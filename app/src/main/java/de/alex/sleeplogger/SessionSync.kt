package de.alex.sleeplogger

import android.content.Context
import android.os.PowerManager
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder

/**
 * Sends finished sessions to the PC over Wi-Fi (npm run ui or npm run sync must be running there).
 *   GET  http://<pc>:<sync>/sessions/<name>        -> {"files": {"accel.csv": 123, …}} (complete files only)
 *   PUT  http://<pc>:<sync>/sessions/<name>/<file> -> body = file, answer {"size": n}
 * Only files missing or of a different size on the PC are sent. After a session is confirmed complete on the
 * PC (all sizes equal) it is deleted on the watch (deleteAfter). The session that is still recording is skipped.
 */
object SessionSync {
    private const val TAG = "SessionSync"
    @Volatile var running = false
        private set
    @Volatile var status = ""
        private set

    fun start(ctx: Context, deleteAfter: Boolean = true) {
        synchronized(this) {
            if (running) return
            running = true
        }
        val app = ctx.applicationContext
        Thread({ run(app, deleteAfter) }, "session-sync").start()
    }

    private fun run(ctx: Context, deleteAfter: Boolean) {
        val wl = ctx.getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sleeplogger:sync").apply { acquire(30 * 60_000L) }
        WifiLink.acquire(ctx)
        try {
            status = "Sync: Wi-Fi …"
            val net = WifiLink.await(20_000) ?: return fail("no Wi-Fi")
            status = "Sync: looking for PC …"
            val pc = WifiLink.findPc(ctx, net, 4000) ?: return fail("PC not found (npm run sync running?)")
            val base = "http://${pc.host.hostAddress}:${pc.syncPort}/sessions"
            val skip = if (SensorLoggerService.isRunning) SensorLoggerService.currentSession else null
            val dirs = (File(ctx.filesDir, "sessions").listFiles() ?: emptyArray())
                .filter { it.isDirectory && it.name != skip && it.name.matches(Regex("\\d{8}_\\d{6}")) }
                .sortedBy { it.name }
            if (dirs.isEmpty()) { status = "Sync: nothing to send"; return }
            var sentBytes = 0L
            var done = 0
            for ((i, d) in dirs.withIndex()) {
                val files = (d.listFiles() ?: emptyArray()).filter { it.isFile }
                var remote = remoteSizes(net, "$base/${d.name}")
                for (f in files) {
                    if (remote[f.name] == f.length()) continue
                    status = "Sync ${i + 1}/${dirs.size}: ${f.name} ${f.length() / 1_000_000} MB"
                    put(net, "$base/${d.name}/${URLEncoder.encode(f.name, "UTF-8")}", f)
                    sentBytes += f.length()
                }
                remote = remoteSizes(net, "$base/${d.name}")
                val complete = files.all { remote[it.name] == it.length() }
                if (!complete) return fail("${d.name} incomplete on the PC")
                done++
                if (deleteAfter) d.deleteRecursively()
            }
            status = "Sync ✓ $done session(s), ${sentBytes / 1_000_000} MB → ${pc.name.ifEmpty { pc.host.hostAddress }}" +
                if (deleteAfter) ", deleted here" else ""
        } catch (e: Exception) {
            Log.w(TAG, "sync failed", e)
            fail(e.message ?: e.javaClass.simpleName)
        } finally {
            WifiLink.release(ctx)
            if (wl.isHeld) wl.release()
            running = false
        }
    }

    private fun fail(msg: String) { status = "Sync failed: $msg" }

    private fun remoteSizes(net: android.net.Network, url: String): Map<String, Long> {
        val c = net.openConnection(URL(url)) as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 15000
        try {
            if (c.responseCode != 200) throw RuntimeException("PC answered ${c.responseCode}")
            val files = JSONObject(c.inputStream.bufferedReader().readText()).getJSONObject("files")
            return files.keys().asSequence().associateWith { files.getLong(it) }
        } finally { c.disconnect() }
    }

    private fun put(net: android.net.Network, url: String, f: File) {
        val c = net.openConnection(URL(url)) as HttpURLConnection
        c.connectTimeout = 5000; c.readTimeout = 60_000
        c.requestMethod = "PUT"
        c.doOutput = true
        c.setFixedLengthStreamingMode(f.length())
        c.setRequestProperty("Content-Type", "application/octet-stream")
        try {
            c.outputStream.use { out -> f.inputStream().use { it.copyTo(out, 64 * 1024) } }
            if (c.responseCode != 200) throw RuntimeException("upload ${f.name}: PC answered ${c.responseCode}")
        } finally { c.disconnect() }
    }
}
