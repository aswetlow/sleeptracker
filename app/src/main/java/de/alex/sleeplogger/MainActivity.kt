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
    private val ui = Handler(Looper.getMainLooper())

    private val requiredPermissions: Array<String>
        get() = buildList {
            // Bei targetSdk 34 bildet Wear OS 6 BODY_SENSORS automatisch auf READ_HEART_RATE ab.
            add(Manifest.permission.BODY_SENSORS)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) startLogger()
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
        toggle = Button(this).apply { setOnClickListener { onToggle() } }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setPadding(24, 24, 24, 24)
            addView(status)
            addView(toggle)
        })
    }

    override fun onResume() { super.onResume(); ui.post(refresh) }
    override fun onPause() { super.onPause(); ui.removeCallbacks(refresh) }

    private fun onToggle() {
        if (SensorLoggerService.isRunning) {
            startService(Intent(this, SensorLoggerService::class.java)
                .setAction(SensorLoggerService.ACTION_STOP))
        } else if (requiredPermissions.all { checkSelfPermission(it) == PackageManager.PERMISSION_GRANTED }) {
            startLogger()
        } else {
            permissionLauncher.launch(requiredPermissions)
        }
    }

    private fun startLogger() {
        startForegroundService(Intent(this, SensorLoggerService::class.java))
    }

    private fun render() {
        if (SensorLoggerService.isRunning) {
            status.text = "Läuft\nPuls: ${SensorLoggerService.lastBpm.toInt()} bpm\n" +
                "Accel-Samples: ${SensorLoggerService.accelCount}"
            toggle.text = "Stopp"
        } else {
            status.text = "Bereit"
            toggle.text = "Start"
        }
    }
}
