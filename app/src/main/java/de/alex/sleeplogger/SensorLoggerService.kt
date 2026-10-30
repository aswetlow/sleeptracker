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
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.io.BufferedWriter
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Loggt Beschleunigung (~25 Hz, im Sensor-FIFO gebatcht) und Puls (~1 Hz) in CSV-Dateien.
 * Dateien landen in files/sessions/<start>/ und werden per adb exportiert (siehe README).
 */
class SensorLoggerService : Service(), SensorEventListener {

    companion object {
        const val TAG = "SleepLogger"
        const val ACTION_STOP = "de.alex.sleeplogger.STOP"
        const val ACCEL_PERIOD_US = 40_000          // 25 Hz
        const val ACCEL_MAX_LATENCY_US = 10_000_000 // bis zu 10 s im FIFO puffern
        const val FLUSH_INTERVAL_MS = 30_000L
        private const val CHANNEL_ID = "logging"
        private const val NOTIFICATION_ID = 1

        @Volatile var isRunning = false
            private set
        @Volatile var lastBpm = 0f
            private set
        @Volatile var accelCount = 0L
            private set
    }

    private lateinit var sensorManager: SensorManager
    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private var wakeLock: PowerManager.WakeLock? = null

    private var accelOut: BufferedWriter? = null
    private var hrOut: BufferedWriter? = null
    private var eventsOut: BufferedWriter? = null

    // Sensor-Timestamps sind elapsedRealtimeNanos; einmal gegen die Wanduhr verankert,
    // damit die Zeitreihe nicht springt, wenn die Uhrzeit nachts per NTP korrigiert wird.
    private var epochOffsetNs = 0L

    private val flushRunnable = object : Runnable {
        override fun run() {
            accelOut?.flush(); hrOut?.flush(); eventsOut?.flush()
            handler.postDelayed(this, FLUSH_INTERVAL_MS)
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            stopSelf()
            return START_NOT_STICKY
        }
        if (isRunning) return START_STICKY

        if (Build.VERSION.SDK_INT >= 34) {
            startForeground(NOTIFICATION_ID, buildNotification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH)
        } else {
            startForeground(NOTIFICATION_ID, buildNotification())
        }
        startLogging()
        return START_STICKY
    }

    private fun startLogging() {
        sensorManager = getSystemService(Context.SENSOR_SERVICE) as SensorManager
        thread = HandlerThread("sensor-writer").apply { start() }
        handler = Handler(thread.looper)

        epochOffsetNs = System.currentTimeMillis() * 1_000_000L - SystemClock.elapsedRealtimeNanos()

        val stamp = SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())
        val dir = File(filesDir, "sessions/$stamp").apply { mkdirs() }
        accelOut = File(dir, "accel.csv").bufferedWriter().apply { write("epoch_ms,x,y,z\n") }
        hrOut = File(dir, "hr.csv").bufferedWriter().apply { write("epoch_ms,bpm,accuracy\n") }
        eventsOut = File(dir, "events.csv").bufferedWriter().apply { write("epoch_ms,event\n") }

        // Wake-up-Accelerometer weckt die CPU selbst, wenn der FIFO voll ist.
        // Gibt es keins, halten wir einen Partial-Wakelock (kostet mehr Akku).
        val wakeAccel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER, true)
        val accel = wakeAccel ?: sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
        val hr = sensorManager.getDefaultSensor(Sensor.TYPE_HEART_RATE)

        if (wakeAccel == null || hr != null) {
            // Puls ist kein Wake-up-Sensor; ohne Wakelock gehen im Doze Pulswerte verloren.
            wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager)
                .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "SleepLogger::log")
                .apply { acquire(12 * 60 * 60 * 1000L) }
        }

        logEvent("start accel=${accel?.name} wakeup=${wakeAccel != null} " +
                "fifo=${accel?.fifoMaxEventCount} hr=${hr?.name} wakelock=${wakeLock != null}")

        accel?.let {
            sensorManager.registerListener(this, it, ACCEL_PERIOD_US, ACCEL_MAX_LATENCY_US, handler)
        }
        hr?.let {
            sensorManager.registerListener(this, it, SensorManager.SENSOR_DELAY_NORMAL, 0, handler)
        } ?: logEvent("no_heart_rate_sensor")

        handler.postDelayed(flushRunnable, FLUSH_INTERVAL_MS)
        isRunning = true
        Log.i(TAG, "logging to ${dir.absolutePath}")
    }

    override fun onSensorChanged(event: SensorEvent) {
        val epochMs = (event.timestamp + epochOffsetNs) / 1_000_000L
        when (event.sensor.type) {
            Sensor.TYPE_ACCELEROMETER -> {
                val v = event.values
                accelOut?.write("$epochMs,${v[0]},${v[1]},${v[2]}\n")
                accelCount++
            }
            Sensor.TYPE_HEART_RATE -> {
                lastBpm = event.values[0]
                hrOut?.write("$epochMs,${event.values[0]},${event.accuracy}\n")
            }
        }
    }

    override fun onAccuracyChanged(sensor: Sensor, accuracy: Int) {
        logEvent("accuracy ${sensor.type} $accuracy")
    }

    private fun logEvent(text: String) {
        eventsOut?.write("${System.currentTimeMillis()},\"$text\"\n")
    }

    override fun onDestroy() {
        if (isRunning) {
            sensorManager.unregisterListener(this)
            handler.removeCallbacks(flushRunnable)
            // Schreiben auf dem Writer-Thread abschließen, damit keine Zeilen verloren gehen.
            handler.post {
                logEvent("stop")
                accelOut?.close(); hrOut?.close(); eventsOut?.close()
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
            NotificationChannel(CHANNEL_ID, "Schlaf-Logging", NotificationManager.IMPORTANCE_LOW)
        )
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java), PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("SleepLogger läuft")
            .setContentText("Bewegung + Puls werden aufgezeichnet")
            .setSmallIcon(android.R.drawable.ic_menu_compass)
            .setOngoing(true)
            .setContentIntent(open)
            .build()
    }
}
