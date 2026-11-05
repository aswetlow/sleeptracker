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
import android.os.Looper
import android.os.PowerManager
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
        // Undocumented Google sensors of the Pixel Watch (see `adb shell dumpsys sensorservice`).
        // Format unknown, hence raw: epoch_ms,accuracy,n,v0 v1 ... v(n-1)
        val RAW_SENSORS = linkedMapOf(
            "com.google.wear.sensor.ppg" to "raw_ppg.csv",
            "com.google.sensor.heart_rate_extended" to "raw_hr_ext.csv",
            "com.google.sensor.ppg_controller" to "raw_ppg_ctrl.csv",
        )
        // ECG test (experimental): undocumented ECG sensors of the Pixel Watch, 60 s, finger on the crown
        const val EXTRA_ECG_TEST = "ecg_test"
        const val ECG_TEST_MS = 60_000L
        const val ECG_TYPE = "com.google.sensor.ecg"
        const val ECG_LEAD_TYPE = "com.google.sensor.ecg_lead_detector"
        const val PPG_TYPE = "com.google.wear.sensor.ppg"
        val ECG_SENSORS = linkedMapOf(
            ECG_TYPE to "raw_ecg.csv",
            ECG_LEAD_TYPE to "raw_ecg_lead.csv",
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
        @Volatile var ecgMode = false
            private set
        @Volatile var ecgCount = 0L
            private set
        @Volatile var ecgLeadLast = "–"
            private set
        @Volatile var ecgEndsAtMs = 0L
            private set
        /** Result line of the last ECG test (shown on the watch after it ends), null before the first test. */
        @Volatile var ecgResult: String? = null
            private set
        @Volatile var ecgBlocked = false
            private set
    }

    /** Per-sensor statistics for the ECG test: event count, time span, constant / all-zero values. */
    private class RawStats {
        var count = 0L; var firstMs = 0L; var lastMs = 0L; var maxN = 0
        var first: FloatArray? = null; var constant = true; var allZero = true

        fun add(ms: Long, v: FloatArray, n: Int) {
            if (count == 0L) { firstMs = ms; first = v.copyOf() }
            else if (!v.contentEquals(first)) constant = false
            if (v.any { it != 0f }) allZero = false
            lastMs = ms; count++
            if (n > maxN) maxN = n
        }

        /** Events per second over the first-to-last span. */
        val rate: Double get() = if (count > 1 && lastMs > firstMs) (count - 1) * 1000.0 / (lastMs - firstMs) else 0.0
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
    private val rawStats = HashMap<Int, RawStats>()       // ECG test only
    private val ecgTypes = LinkedHashMap<String, Int>()   // ECG test: string type -> registered sensor type
    private var ecgStatsWritten = false
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

    // ECG test: stop automatically after ECG_TEST_MS
    private val ecgFinish = Runnable {
        writeEcgStats("finished")
        Handler(Looper.getMainLooper()).post { stopSelf() }
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
        if (isRunning) return START_STICKY

        val ecg = intent?.getBooleanExtra(EXTRA_ECG_TEST, false) ?: false
        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification(ecg), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification(ecg))
        }
        startLogging(intent?.getBooleanExtra(EXTRA_RAW, false) ?: false, ecg)
        return START_STICKY
    }

    private fun startLogging(raw: Boolean, ecg: Boolean = false) {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        thread = HandlerThread("sensor-writer").apply { start() }
        handler = Handler(thread.looper)

        epochOffsetNs = System.currentTimeMillis() * 1_000_000L - SystemClock.elapsedRealtimeNanos()

        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val dir = File(filesDir, "sessions/$stamp").apply { mkdirs() }
        if (!ecg) {
            accelOut = File(dir, "accel.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
            gyroOut = File(dir, "gyro.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
        }
        hrOut = File(dir, "hr.csv").bufferedWriter().apply { write("epoch_ms,bpm,accuracy\n") }
        eventsOut = File(dir, "events.csv").bufferedWriter().apply { write("epoch_ms,event\n") }
        accelCount = 0; rawCount = 0; markCount = 0; rawMode = raw || ecg
        ecgMode = ecg; ecgCount = 0; ecgLeadLast = "–"; ecgResult = null; ecgBlocked = false
        ecgStatsWritten = false; rawStats.clear(); ecgTypes.clear()
        startedAtMs = System.currentTimeMillis()

        // record all sensors with metadata; costs nothing and helps reverse engineering.
        val all = sensorManager.getSensorList(Sensor.TYPE_ALL)
        File(dir, "sensors.txt").writeText(all.joinToString("\n") {
            "${it.name} | ${it.vendor} | type=${it.type} ${it.stringType} | wakeup=${it.isWakeUpSensor} | " +
                "minDelay=${it.minDelay}us maxDelay=${it.maxDelay}us | range=${it.maximumRange} " +
                "res=${it.resolution} | fifo=${it.fifoMaxEventCount} | mode=${it.reportingMode}"
        } + "\n")

        if (ecg) {
            startEcgTest(dir, all)
            return
        }

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

    /**
     * ECG test: only heart rate, raw PPG and the two ECG sensors, 60 s, then stop.
     * The ECG sensors are registered as fast as possible (0 µs, no batching), non-wake-up variant first.
     */
    private fun startEcgTest(dir: File, all: List<Sensor>) {
        val hr = sensorManager.getDefaultSensor(Sensor.TYPE_HEART_RATE)
        // the screen stays on during the test; the wakelock only keeps the writer thread alive
        wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepLogger::ecg")
            .apply { acquire(5 * 60_000L) }
        logEvent("ecg_test start duration=${ECG_TEST_MS / 1000}s hr=${hr?.name}")
        hr?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, 0, handler)
        } ?: logEvent("no_heart_rate_sensor")

        for ((stringType, file) in linkedMapOf(PPG_TYPE to "raw_ppg.csv") + ECG_SENSORS) {
            val s = all.firstOrNull { it.stringType == stringType && !it.isWakeUpSensor }
                ?: all.firstOrNull { it.stringType == stringType }
            if (s == null) { logEvent("raw_missing $stringType"); continue }
            rawOut[s.type] = File(dir, file).bufferedWriter().apply { write("epoch_ms,accuracy,n,values\n") }
            val ok = sensorManager.registerListener(this, s, 0, 0, handler)
            logEvent("raw ${s.name} | ${s.vendor} | type=${s.type} ${s.stringType} | wakeup=${s.isWakeUpSensor} | " +
                "minDelay=${s.minDelay}us maxDelay=${s.maxDelay}us | fifo=${s.fifoMaxEventCount} " +
                "reserved=${s.fifoReservedEventCount} | mode=${s.reportingMode} | registered=$ok")
            if (!ok) { rawOut.remove(s.type)?.close(); continue }
            ecgTypes[stringType] = s.type
        }

        live = LiveStream().also { it.start() }
        handler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS)
        handler.post(batteryRunnable)
        handler.post(liveRunnable)
        ecgEndsAtMs = System.currentTimeMillis() + ECG_TEST_MS
        handler.postDelayed(ecgFinish, ECG_TEST_MS)
        isRunning = true
        Log.i(TAG, "ECG test, logging to ${dir.absolutePath}")
    }

    /** Writes events, time span, rate and constant/zero flags per sensor to events.csv (writer thread). */
    private fun writeEcgStats(reason: String) {
        if (ecgStatsWritten) return
        ecgStatsWritten = true
        for (stringType in listOf(ECG_TYPE, ECG_LEAD_TYPE, PPG_TYPE)) {
            val type = ecgTypes[stringType]
            val st = type?.let { rawStats[it] }
            when {
                type == null -> logEvent("ecg_stats $stringType not_registered")
                st == null -> logEvent("ecg_stats $stringType events=0")
                else -> logEvent("ecg_stats $stringType events=${st.count} first=${st.firstMs} last=${st.lastMs} " +
                    "rate=${"%.1f".format(Locale.US, st.rate)}Hz values_per_event=${st.maxN} " +
                    "constant=${st.constant} all_zero=${st.allZero}")
            }
        }
        val ecg = ecgTypes[ECG_TYPE]?.let { rawStats[it] }
        ecgBlocked = ecg == null || ecg.count == 0L
        ecgResult = when {
            ecgTypes[ECG_TYPE] == null -> "ECG blocked? sensor not registered"
            ecg == null || ecg.count == 0L -> "ECG blocked? 0 events"
            ecg.allZero -> "ECG: ${ecg.count} events, all 0"
            ecg.constant -> "ECG: ${ecg.count} events, constant"
            else -> "ECG: ${ecg.count} events, ${"%.0f".format(Locale.US, ecg.rate)} Hz"
        }
        logEvent("ecg_test $reason result=$ecgResult")
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
                if (ecgMode) {
                    rawStats.getOrPut(event.sensor.type) { RawStats() }.add(epochMs, v, n)
                    when (event.sensor.stringType) {
                        ECG_TYPE -> { ecgCount++; live?.send("c,$epochMs,$joined\n") }
                        ECG_LEAD_TYPE -> { ecgLeadLast = joined; live?.send("l,$epochMs,$joined\n") }
                    }
                }
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
            handler.removeCallbacks(ecgFinish)
            live?.stop(); live = null; liveConnected = false
            // finish writing on the writer thread so no lines are lost.
            handler.post {
                batteryRunnable.run()
                handler.removeCallbacks(batteryRunnable)
                if (ecgMode) writeEcgStats("stopped_early")
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

    private fun buildNotification(ecg: Boolean = false): Notification {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "Sleep logging", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SleepLogger running")
            .setContentText(if (ecg) "ECG test (60 s)" else "Recording movement + heart rate")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
