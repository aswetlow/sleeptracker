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
        val dm = resources.displayMetrics
        status = TextView(this).apply { gravity = Gravity.CENTER; textSize = 12f; setPadding(0, 8, 0, 8) }
        toggle = Button(this).apply { setOnClickListener { onToggle(false) } }
        // Zusätzlich die rohen PPG-Sensoren mitschreiben (erst als kurzer Test, Datenmenge unbekannt)
        rawButton = Button(this).apply { text = "Start + PPG"; setOnClickListener { onToggle(true) } }
        // Extrasystole gespürt -> Zeitmarke in events.csv ("felt"), als Referenz für ppg.py
        markButton = Button(this).apply {
            text = "Gespürt"
            textSize = 18f
            minimumHeight = (dm.heightPixels * 0.28).toInt()   // groß, damit man ihn blind trifft
            setOnClickListener {
                startService(Intent(this@MainActivity, SensorLoggerService::class.java)
                    .setAction(SensorLoggerService.ACTION_MARK)
                    .putExtra(SensorLoggerService.EXTRA_TIME, System.currentTimeMillis()))
            }
        }
        // Rundes Display: seitlich und oben/unten Rand lassen, alles in einer ScrollView
        // (Wischen oder Krone). Reihenfolge: Gespürt oben, Status, Stopp/Start unten.
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
            isFocusableInTouchMode = true      // nötig, damit die Krone (Rotary) scrollt
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
            // kurz halten, damit "Gespürt" und "Stopp" ohne Scrollen auf den Bildschirm passen
            status.text = "${SensorLoggerService.lastBpm.toInt()} bpm · Gespürt ${SensorLoggerService.markCount}\n" +
                (if (SensorLoggerService.rawMode) "PPG ${SensorLoggerService.rawCount / 1000}k" else "ohne PPG") +
                (if (SensorLoggerService.liveConnected) " · Live ✓" else "")
            toggle.text = "Stopp"
            rawButton.visibility = android.view.View.GONE
            markButton.visibility = android.view.View.VISIBLE
            // Im PPG-Test die ersten 20 min Bildschirm anlassen, damit "Gespürt" mit einem Tippen geht.
            // Danach (z. B. PPG über Nacht) wieder normal ausgehen lassen.
            val keepOn = SensorLoggerService.rawMode &&
                System.currentTimeMillis() - SensorLoggerService.startedAtMs < 20 * 60_000L
            if (keepOn) window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            else window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        } else {
            status.text = "Bereit"
            toggle.text = "Start"
            rawButton.visibility = android.view.View.VISIBLE
            markButton.visibility = android.view.View.GONE
            window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }
}
