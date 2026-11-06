package de.alex.sleeplogger

import java.net.InetSocketAddress
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit

/**
 * Live streaming to the laptop over the ADB tunnel:
 *   adb -s <IP:port> reverse tcp:9000 tcp:9000   (analysis/live.py does this automatically)
 * The watch connects to 127.0.0.1:9000; ADB forwards that to the laptop.
 * No laptop -> a connection attempt every 3 s, which costs practically nothing.
 *
 * Line format (text, one measurement per line):
 *   a,epoch_ms,x,y,z   accelerometer      g,epoch_ms,x,y,z   gyroscope
 *   h,epoch_ms,bpm     heart rate         p,epoch_ms,v0 v1 … raw PPG
 *   e,epoch_ms,text    event (e.g. felt)                      k  keepalive
 *   c,epoch_ms,v0 v1 … raw ECG (ECG test)  l,epoch_ms,v0 …     ECG lead detector
 *   q,epoch_ms,ch mA … PPG controller (LED current per channel; resent on every connect)
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

    /** Latest line per key, sent again whenever the laptop (re)connects (state that only changes rarely). */
    private val sticky = ConcurrentHashMap<String, String>()

    fun sendSticky(key: String, line: String) {
        sticky[key] = line
        send(line)
    }

    /** Non-blocking; when the buffer is full (laptop too slow) the line is dropped. */
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
                    sticky.values.forEach { queue.offer(it) }
                    connected = true
                    while (running) {
                        var line = queue.poll(500, TimeUnit.MILLISECONDS)
                        if (line == null) {
                            out.write("k\n")       // keepalive: notices when the laptop is gone
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
                // no tunnel / laptop gone – try again later
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
