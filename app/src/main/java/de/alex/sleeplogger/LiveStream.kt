package de.alex.sleeplogger

import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Live-Übertragung an den Laptop über den ADB-Tunnel:
 *   adb -s <IP:Port> reverse tcp:9000 tcp:9000   (macht analysis/live.py automatisch)
 * Die Uhr verbindet sich auf 127.0.0.1:9000; ADB leitet das an den Laptop weiter.
 * Kein Laptop da -> Verbindungsversuch alle 3 s, kostet praktisch nichts.
 *
 * Zeilenformat (Text, eine Messung pro Zeile):
 *   a,epoch_ms,x,y,z   Accelerometer      g,epoch_ms,x,y,z   Gyroskop
 *   h,epoch_ms,bpm     Puls               p,epoch_ms,v0 v1 … Roh-PPG
 *   e,epoch_ms,text    Ereignis (z. B. felt)                  k  Keepalive
 */
class LiveStream(private val port: Int = 9000) {
    private val queue = LinkedBlockingQueue<String>(20_000)
    @Volatile var connected = false
        private set
    @Volatile private var running = true
    private val thread = Thread({ loop() }, "live-stream").apply { isDaemon = true }

    fun start() = thread.start()

    fun stop() {
        running = false
        thread.interrupt()
    }

    /** Nicht blockierend; bei vollem Puffer (Laptop zu langsam) wird verworfen. */
    fun send(line: String) {
        if (connected) queue.offer(line)
    }

    private fun loop() {
        while (running) {
            try {
                Socket().use { s ->
                    s.connect(InetSocketAddress("127.0.0.1", port), 1000)
                    s.tcpNoDelay = true
                    val out = s.getOutputStream().bufferedWriter()
                    queue.clear()
                    connected = true
                    while (running) {
                        var line = queue.poll(500, TimeUnit.MILLISECONDS)
                        if (line == null) {
                            out.write("k\n")       // Keepalive: merkt, wenn der Laptop weg ist
                        } else {
                            while (line != null) {
                                out.write(line)
                                line = queue.poll()
                            }
                        }
                        out.flush()
                    }
                }
            } catch (_: InterruptedException) {
                return
            } catch (_: Exception) {
                // kein Tunnel / Laptop weg – später nochmal
            }
            connected = false
            try {
                Thread.sleep(3000)
            } catch (_: InterruptedException) {
                return
            }
        }
    }
}
