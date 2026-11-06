package de.alex.sleeplogger

import android.content.Context
import android.net.ConnectivityManager
import android.net.LinkProperties
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.Inet4Address
import java.net.InetAddress
import java.net.SocketTimeoutException

/**
 * Direct Wi-Fi to the PC, without ADB.
 *
 * Wear OS turns Wi-Fi off whenever the phone is reachable over Bluetooth. An app that needs Wi-Fi requests it
 * with ConnectivityManager.requestNetwork(TRANSPORT_WIFI); the system keeps Wi-Fi up as long as the request is
 * registered. Sockets are bound to that Network explicitly, so traffic never goes over the Bluetooth proxy.
 * Reference-counted: live stream and sync can hold it at the same time; the last release drops the request.
 *
 * The PC (npm run ui / npm run sync) answers a UDP broadcast "SLEEPLOGGER? 1" on port 9001 with
 * "SLEEPLOGGER 1 <livePort> <syncPort> <name>". The last PC found is remembered for when broadcasts are blocked.
 */
object WifiLink {
    private const val TAG = "WifiLink"
    const val DISCOVERY_PORT = 9001
    private const val PREFS = "wifi_link"

    data class Pc(val host: InetAddress, val livePort: Int, val syncPort: Int, val name: String)

    private val lock = Any()
    private var users = 0
    private var callback: ConnectivityManager.NetworkCallback? = null
    @Volatile var network: Network? = null
        private set

    fun acquire(ctx: Context) {
        synchronized(lock) {
            users++
            if (callback != null) return
            val cm = ctx.getSystemService(ConnectivityManager::class.java)
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(n: Network) { network = n; Log.i(TAG, "Wi-Fi available") }
                override fun onLost(n: Network) { if (network == n) network = null; Log.i(TAG, "Wi-Fi lost") }
            }
            val req = NetworkRequest.Builder().addTransportType(NetworkCapabilities.TRANSPORT_WIFI).build()
            try {
                cm.requestNetwork(req, cb)
                callback = cb
            } catch (e: Exception) {
                Log.w(TAG, "requestNetwork failed", e)
                users--
            }
        }
    }

    fun release(ctx: Context) {
        synchronized(lock) {
            if (users > 0) users--
            if (users > 0) return
            callback?.let {
                try { ctx.getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(it) } catch (_: Exception) {}
            }
            callback = null
            network = null
        }
    }

    /** Waits for the requested Wi-Fi (switching it on takes a few seconds). */
    fun await(timeoutMs: Long): Network? {
        val end = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < end) {
            network?.let { return it }
            try { Thread.sleep(200) } catch (_: InterruptedException) { return null }
        }
        return network
    }

    /** Broadcasts a probe on the Wi-Fi network and waits for the PC's answer; falls back to the last PC seen. */
    fun findPc(ctx: Context, net: Network, timeoutMs: Int = 3000): Pc? {
        val targets = mutableListOf<InetAddress>(InetAddress.getByName("255.255.255.255"))
        ctx.getSystemService(ConnectivityManager::class.java).getLinkProperties(net)?.let { subnetBroadcast(it)?.let(targets::add) }
        val last = lastPc(ctx)
        last?.let { targets.add(it.host) }
        try {
            DatagramSocket().use { s ->
                net.bindSocket(s)
                s.broadcast = true
                s.soTimeout = 700
                val probe = "SLEEPLOGGER? 1".toByteArray()
                val end = System.currentTimeMillis() + timeoutMs
                val buf = ByteArray(512)
                while (System.currentTimeMillis() < end) {
                    for (t in targets) {
                        try { s.send(DatagramPacket(probe, probe.size, t, DISCOVERY_PORT)) } catch (_: Exception) {}
                    }
                    try {
                        val p = DatagramPacket(buf, buf.size)
                        s.receive(p)
                        val parts = String(p.data, 0, p.length).trim().split(" ", limit = 5)
                        if (parts.size >= 4 && parts[0] == "SLEEPLOGGER" && parts[1] == "1") {
                            val pc = Pc(p.address, parts[2].toInt(), parts[3].toInt(), parts.getOrElse(4) { "" })
                            remember(ctx, pc)
                            return pc
                        }
                    } catch (_: SocketTimeoutException) {
                    }
                }
            }
        } catch (e: Exception) {
            Log.w(TAG, "discovery failed", e)
        }
        return null
    }

    private fun subnetBroadcast(lp: LinkProperties): InetAddress? {
        val la = lp.linkAddresses.firstOrNull { it.address is Inet4Address } ?: return null
        val ip = la.address.address
        val prefix = la.prefixLength
        if (prefix !in 1..30) return null
        val v = ((ip[0].toInt() and 0xff) shl 24) or ((ip[1].toInt() and 0xff) shl 16) or
            ((ip[2].toInt() and 0xff) shl 8) or (ip[3].toInt() and 0xff)
        val b = v or ((1 shl (32 - prefix)) - 1)
        return InetAddress.getByAddress(byteArrayOf((b ushr 24).toByte(), (b ushr 16).toByte(), (b ushr 8).toByte(), b.toByte()))
    }

    private fun remember(ctx: Context, pc: Pc) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
            .putString("host", pc.host.hostAddress).putInt("live", pc.livePort).putInt("sync", pc.syncPort)
            .putString("name", pc.name).apply()
    }

    private fun lastPc(ctx: Context): Pc? {
        val p = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val host = p.getString("host", null) ?: return null
        return try { Pc(InetAddress.getByName(host), p.getInt("live", 9000), p.getInt("sync", 9002), p.getString("name", "") ?: "") }
        catch (_: Exception) { null }
    }
}
