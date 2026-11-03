package de.alex.sleeplogger

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var rawButton: Button
    private var startRaw = false
    private val ui = Handler(Looper.getMainLooper())

    private val requiredPermissions: Array<String>
        get() = buildList {
            // Bei targetSdk 34 bildet Wear OS 6 BODY_SENSORS automatisch auf READ_HEART_RATE ab.
            add(Manifest.permission.BODY_SENSORS)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) startLogger(startRaw)
            else status.text = "Berechtigung fehlt.\nIn Einstellungen › Apps erlauben."
        }

    private val refresh = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        status = TextView(this).apply { gravity = Gravity.CENTER; textSize = 14f }
        toggle = Button(this).apply { setOnClickListener { onToggle(false) } }
        // Zusätzlich die rohen PPG-Sensoren mitschreiben (erst als kurzer Test, Datenmenge unbekannt)
        rawButton = Button(this).apply { text = "Start + PPG"; setOnClickListener { onToggle(true) } }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(24, 24, 24, 24)
            addView(status)
            addView(toggle)
            addView(rawButton)
        })
    }

    override fun onResume() { super.onResume(); ui.post(refresh) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(refresh) }

    private fun onToggle(raw: Boolean) {
        startRaw = raw
        if (SensorLoggerService.isRunning) {
            startService(Intent(this, SensorLoggerService::class.java)
                .setAction(SensorLoggerService.ACTION_STOP))
        } else if (requiredPermissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
            startLogger(raw)
        } else {
            permissionLauncher.launch(requiredPermissions)
        }
    }

    private fun startLogger(raw: Boolean) {
        startForegroundService(Intent(this, SensorLoggerService::class.java)
            .putExtra(SensorLoggerService.EXTRA_RAW, raw))
    }

    private fun render() {
        if (SensorLoggerService.isRunning) {
            status.text = "Läuft\nPuls: ${SensorLoggerService.lastBpm.toInt()} bpm\n" +
                "Accel-Samples: ${SensorLoggerService.accelCount}" +
                (if (SensorLoggerService.rawCount > 0) "\nPPG-Samples: ${SensorLoggerService.rawCount}" else "")
            toggle.text = "Stopp"
            rawButton.visibility = android.view.View.GONE
        } else {
            status.text = "Bereit"
            toggle.text = "Start"
            rawButton.visibility = android.view.View.VISIBLE
        }
    }
}
