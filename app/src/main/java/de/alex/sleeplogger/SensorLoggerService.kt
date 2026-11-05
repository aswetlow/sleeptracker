package de.alex.sleeplogger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.BatteryManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.os.SystemClock
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Logs acceleration and gyroscope (~25 Hz, batched in the sensor FIFO) and heart rate (~1 Hz) to CSV files.
 * Files go to files/sessions/<start>/ and are exported via adb (see README).
 */
class SensorLoggerService : Service(), SensorEventListener {

    companion object {
        const val TAG = "SleepLogger"
        const val ACTION_STOP = "de.alex.sleeplogger.STOP"
        const val EXTRA_RAW = "raw"
        const val ACTION_MARK = "de.alex.sleeplogger.MARK"
        const val EXTRA_TIME = "time"
        // position calibration: "pose <label>" in events.csv, then lie still until the watch vibrates
        const val ACTION_POSE = "de.alex.sleeplogger.POSE"
        const val EXTRA_POSE = "pose"
        const val POSE_HOLD_MS = 25_000L            // position.py uses 5–25 s after the tap
        // Undocumented Google sensors of the Pixel Watch (see `adb shell dumpsys sensorservice`).
        // Format unknown, hence raw: epoch_ms,accuracy,n,v0 v1 ... v(n-1)
        val RAW_SENSORS = linkedMapOf(
            "com.google.wear.sensor.ppg" to "raw_ppg.csv",
            "com.google.sensor.heart_rate_extended" to "raw_hr_ext.csv",
            "com.google.sensor.ppg_controller" to "raw_ppg_ctrl.csv",
        )
        const val ACCEL_PERIOD_US = 40_000          // 25 Hz
        const val ACCEL_MAX_LATENCY_US = 10_000_000 // buffer up to 10 s in the FIFO
        const val FLUSH_INTERVAL_MS = 30_000L
        const val BATTERY_INTERVAL_MS = 10 * 60_000L
        private const val CHANNEL_ID = "logging"
        private const val NOTIFICATION_ID = 1

        @Volatile var isRunning = false
            private set
        @Volatile var lastBpm = 0f
            private set
        @Volatile var accelCount = 0L
            private set
        @Volatile var rawCount = 0L
            private set
        @Volatile var rawMode = false
            private set
        @Volatile var markCount = 0
            private set
        @Volatile var startedAtMs = 0L
            private set
        @Volatile var liveConnected = false
            private set
        /** calibration taps per position in this recording */
        val poseCounts = java.util.concurrent.ConcurrentHashMap<String, Int>()
        /** end of the current calibration hold (epoch ms), 0 = none */
        @Volatile var poseHoldUntilMs = 0L
            private set
        @Volatile var poseHoldLabel = ""
            private set
    }

    private lateinit var sensorManager: SensorManager
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private var wakeLock: PowerManager.WakeLock? = null

    private var accelOut: BufferedWriter? = null
    private var gyroOut: BufferedWriter? = null
    private var hrOut: BufferedWriter? = null
    private var eventsOut: BufferedWriter? = null
    private val rawOut = HashMap<Int, BufferedWriter>()   // sensor type -> file
    @Volatile private var live: LiveStream? = null

    // Sensor timestamps are elapsedRealtimeNanos; anchored to the wall clock once
    // so the time series does not jump when the clock is corrected via NTP at night.
    private var epochOffsetNs = 0L

    private val flushRunnable = object : Runnable {
        override fun run() {
            accelOut?.flush(); gyroOut?.flush(); hrOut?.flush(); eventsOut?.flush()
            rawOut.values.forEach { it.flush() }
            handler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    // while the laptop is watching: flush the sensor FIFOs every second, otherwise accel/gyro would arrive in 10-s blocks
    private val liveRunnable = object : Runnable {
        override fun run() {
            liveConnected = live?.connected == true
            if (liveConnected) sensorManager.flush(this@SensorLoggerService)
            handler.postDelayed(this, 1000)
        }
    }

    private val batteryRunnable = object : Runnable {
        override fun run() {
            val bm = getSystemService(Context.BATTERY_SERVICE) as BatteryManager
            logEvent("battery ${bm.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)}")
            handler.postDelayed(this, BATTERY_INTERVAL_MS)
        }
    }

    // end of a calibration hold: short double buzz = "done, next arm placement or position"
    // (poseHoldUntilMs stays set: the UI keeps the screen on for 2 min after it, for the next tap)
    private val poseDone = Runnable {
        val vib = if (Build.VERSION.SDK_INT >= 31)
            getSystemService(VibratorManager::class.java)?.defaultVibrator
        else getSystemService(Vibrator::class.java)
        vib?.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 150, 120, 150), -1))
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent?.action == ACTION_MARK) {
            // time of the tap, not of processing; written on the writer thread
            val at = intent.getLongExtra(EXTRA_TIME, System.currentTimeMillis())
            if (isRunning) handler.post { logEvent("felt", at); markCount++; live?.send("e,$at,felt\n") }
            else stopSelf()
            return if (isRunning) START_STICKY else START_NOT_STICKY
        }
        if (intent?.action == ACTION_POSE) {
            val at = intent.getLongExtra(EXTRA_TIME, System.currentTimeMillis())
            val label = intent.getStringExtra(EXTRA_POSE) ?: "unknown"
            if (!isRunning) { stopSelf(); return START_NOT_STICKY }
            handler.post {
                logEvent("pose $label", at)
                live?.send("e,$at,pose $label\n")
                poseCounts.merge(label, 1) { a, b -> a + b }
                poseHoldLabel = label
                poseHoldUntilMs = at + POSE_HOLD_MS
                handler.removeCallbacks(poseDone)
                handler.postDelayed(poseDone, at + POSE_HOLD_MS - System.currentTimeMillis())
            }
            return START_STICKY
        }
        if (isRunning) return START_STICKY

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
        startLogging(intent?.getBooleanExtra(EXTRA_RAW, false) ?: false)
        return START_STICKY
    }

    private fun startLogging(raw: Boolean) {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        thread = HandlerThread("sensor-writer").apply { start() }
        handler = Handler(thread.looper)

        epochOffsetNs = System.currentTimeMillis() * 1_000_000L - SystemClock.elapsedRealtimeNanos()

        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val dir = File(filesDir, "sessions/$stamp").apply { mkdirs() }
        accelOut = File(dir, "accel.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
        gyroOut = File(dir, "gyro.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
        hrOut = File(dir, "hr.csv").bufferedWriter().apply { write("epoch_ms,bpm,accuracy\n") }
        eventsOut = File(dir, "events.csv").bufferedWriter().apply { write("epoch_ms,event\n") }
        accelCount = 0; rawCount = 0; markCount = 0; rawMode = raw
        poseCounts.clear(); poseHoldUntilMs = 0L
        startedAtMs = System.currentTimeMillis()

        // record all sensors with metadata; costs nothing and helps reverse engineering.
        val all = sensorManager.getSensorList(Sensor.TYPE_ALL)
        File(dir, "sensors.txt").writeText(all.joinToString("\n") {
            "${it.name} | ${it.vendor} | type=${it.type} ${it.stringType} | wakeup=${it.isWakeUpSensor} | " +
                "minDelay=${it.minDelay}us maxDelay=${it.maxDelay}us | range=${it.maximumRange} " +
                "res=${it.resolution} | fifo=${it.fifoMaxEventCount} | mode=${it.reportingMode}"
        } + "\n")

        // A wake-up accelerometer wakes the CPU itself when the FIFO is full.
        // If there is none, we hold a partial wakelock (costs more battery).
        val wakeAccel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true)
        val accel = wakeAccel ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        // the gyro sees the tiny wrist rotation from breathing better than the accelerometer
        val gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
        val hr = sensorManager.getDefaultSensor(Sensor.TYPE_HEART_RATE)

        if (wakeAccel == null || hr != null) {
            // heart rate is not a wake-up sensor; without a wakelock heart-rate values are lost in Doze.
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepLogger::log")
                .apply { acquire(12 * 60 * 60 * 1000L) }
        }

        logEvent("start accel=${accel?.name} wakeup=${wakeAccel != null} " +
                "fifo=${accel?.fifoMaxEventCount} gyro=${gyro?.name} hr=${hr?.name} wakelock=${wakeLock != null}")

        accel?.let {
            sensorManager.registerListener(this, it, ACCEL_PERIOD_US, ACCEL_MAX_LATENCY_US, handler)
        }
        gyro?.let {
            sensorManager.registerListener(this, it, ACCEL_PERIOD_US, ACCEL_MAX_LATENCY_US, handler)
        } ?: logEvent("no_gyroscope")
        hr?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, 0, handler)
        } ?: logEvent("no_heart_rate_sensor")

        if (raw) {
            for ((stringType, file) in RAW_SENSORS) {
                val s = all.firstOrNull { it.stringType == stringType && !it.isWakeUpSensor }
                if (s == null) { logEvent("raw_missing $stringType"); continue }
                rawOut[s.type] = File(dir, file).bufferedWriter().apply { write("epoch_ms,accuracy,n,values\n") }
                // 0 µs = as fast as the sensor can
                val ok = sensorManager.registerListener(this, s, 0, 0, handler)
                logEvent("raw ${s.name} type=${s.type} minDelay=${s.minDelay}us registered=$ok")
                if (!ok) rawOut.remove(s.type)?.close()
            }
        }

        live = LiveStream().also { it.start() }
        handler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS)
        handler.post(batteryRunnable)
        handler.post(liveRunnable)
        isRunning = true
        Log.i(TAG, "logging to ${dir.absolutePath}")
    }

    override fun onSensorChanged(event: SensorEvent) {
        val epochMs = (event.timestamp + epochOffsetNs) / 1_000_000L
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val v = event.values
                accelOut?.write("$epochMs,${v[0]},${v[1]},${v[2]}\n")
                live?.send("a,$epochMs,${v[0]},${v[1]},${v[2]}\n")
                accelCount++
            }
            Sensor.TYPE_GYROSCOPE -> {
                val v = event.values
                gyroOut?.write("$epochMs,${v[0]},${v[1]},${v[2]}\n")
                live?.send("g,$epochMs,${v[0]},${v[1]},${v[2]}\n")
            }
            Sensor.TYPE_HEART_RATE -> {
                lastBpm = event.values[0]
                hrOut?.write("$epochMs,${event.values[0]},${event.accuracy}\n")
                live?.send("h,$epochMs,${event.values[0]}\n")
            }
            else -> rawOut[event.sensor.type]?.let { w ->
                // the trailing values are mostly zeros (PPG: 9 of 16 values) – we skip them
                val v = event.values
                var n = v.size
                while (n > 1 && v[n - 1] == 0f) n--
                val joined = v.take(n).joinToString(" ")
                w.write("$epochMs,${event.accuracy},$n,$joined\n")
                if (event.sensor.stringType == "com.google.wear.sensor.ppg") live?.send("p,$epochMs,$joined\n")
                rawCount++
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        logEvent("accuracy ${sensor.type} $accuracy")
    }

    private fun logEvent(text: String, atMs: Long = System.currentTimeMillis()) {
        eventsOut?.write("$atMs,\"$text\"\n")
    }

    override fun onDestroy() {
        if (isRunning) {
            sensorManager.unregisterListener(this)
            handler.removeCallbacks(flushRunnable)
            handler.removeCallbacks(batteryRunnable)
            handler.removeCallbacks(liveRunnable)
            handler.removeCallbacks(poseDone)
            poseHoldUntilMs = 0L
            live?.stop(); live = null; liveConnected = false
            // finish writing on the writer thread so no lines are lost.
            handler.post {
                batteryRunnable.run()
                handler.removeCallbacks(batteryRunnable)
                logEvent("stop")
                accelOut?.close(); gyroOut?.close(); hrOut?.close(); eventsOut?.close()
                rawOut.values.forEach { it.close() }; rawOut.clear()
                thread.quitSafely()
            }
            wakeLock?.takeIf { it.isHeld }?.release()
            isRunning = false
        }
        super.onDestroy()
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Sleep logging", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SleepLogger running")
            .setContentText("Recording movement + heart rate")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
