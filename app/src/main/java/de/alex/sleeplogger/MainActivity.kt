package de.alex.sleeplogger

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.contract.ActivityResultContracts

class MainActivity : ComponentActivity() {

    private lateinit var status: TextView
    private lateinit var toggle: Button
    private lateinit var rawButton: Button
    private lateinit var markButton: Button
    private var startRaw = false
    private val ui = Handler(Looper.getMainLooper())

    private val requiredPermissions: Array<String>
        get() = buildList {
            // With targetSdk 34, Wear OS 6 maps BODY_SENSORS to READ_HEART_RATE automatically.
            add(Manifest.permission.BODY_SENSORS)
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.POST_NOTIFICATIONS)
        }.toTypedArray()

    private val permissionLauncher =
        registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { result ->
            if (result.values.all { it }) startLogger(startRaw)
            else status.text = "Permission missing.\nAllow it in Settings › Apps."
        }

    private val refresh = object : Runnable {
        override fun run() {
            render()
            ui.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val dm = resources.displayMetrics
        status = TextView(this).apply { gravity = Gravity.CENTER; textSize = 12f; setPadding(0, 8, 0, 8) }
        toggle = Button(this).apply { setOnClickListener { onToggle(false) } }
        // additionally record the raw PPG sensors (first as a short test, data volume unknown)
        rawButton = Button(this).apply { text = "Start + PPG"; setOnClickListener { onToggle(true) } }
        // ectopic beat felt -> time marker in events.csv ("felt"), as a reference for ppg.py
        markButton = Button(this).apply {
            text = "Felt"
            textSize = 18f
            minimumHeight = (dm.heightPixels * 0.28).toInt()   // large, so it can be hit blindly
            setOnClickListener {
                startService(Intent(this@MainActivity, SensorLoggerService::class.java)
                    .setAction(SensorLoggerService.ACTION_MARK)
                    .putExtra(SensorLoggerService.EXTRA_TIME, System.currentTimeMillis()))
            }
        }
        // Round display: leave margins at the sides and top/bottom, everything in a ScrollView
        // (swipe or crown). Order: Felt at the top, status, Stop/Start at the bottom.
        val padX = (dm.widthPixels * 0.12).toInt()
        val padY = (dm.heightPixels * 0.14).toInt()
        val column = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            setPadding(padX, padY, padX, padY)
            addView(markButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(status)
            addView(toggle, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
            addView(rawButton, LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT))
        }
        val scroll = ScrollView(this).apply {
            isFillViewport = true
            isVerticalScrollBarEnabled = true
            isFocusableInTouchMode = true      // needed so the crown (rotary) scrolls
            addView(column)
        }
        setContentView(scroll)
        scroll.requestFocus()
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
            // keep it short so "Felt" and "Stop" fit on the screen without scrolling
            status.text = "${SensorLoggerService.lastBpm.toInt()} bpm · felt ${SensorLoggerService.markCount}\n" +
                (if (SensorLoggerService.rawMode) "PPG ${SensorLoggerService.rawCount / 1000}k" else "no PPG") +
                (if (SensorLoggerService.liveConnected) " · Live ✓" else "")
            toggle.text = "Stop"
            rawButton.visibility = android.view.View.GONE
            markButton.visibility = android.view.View.VISIBLE
            // In the PPG test keep the screen on for the first 20 min so "Felt" takes a single tap.
            // After that (e.g. PPG overnight) let it turn off normally again.
            val keepOn = SensorLoggerService.rawMode &&
                System.currentTimeMillis() - SensorLoggerService.startedAtMs < 20 * 60_000L
            if (keepOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            status.text = "Ready"
            toggle.text = "Start"
            rawButton.visibility = android.view.View.VISIBLE
            markButton.visibility = android.view.View.GONE
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
