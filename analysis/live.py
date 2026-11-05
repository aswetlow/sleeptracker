"""
Live dashboard: watch -> ADB tunnel -> laptop -> browser.

1. Start the app on the watch (preferably "Start + PPG", otherwise there is no pulse wave).
2. On the laptop:
       python live.py --serial 192.168.178.35:41773
   The script sets up `adb reverse tcp:9000 tcp:9000`, waits for the watch and opens
   http://localhost:8765 in the browser. The watch connects on its own (within 3 s).
3. Try it without a watch:  python live.py --demo
   Play back a saved session:  python live.py --replay ..\\sessions\\<session> [--speed 4]

Shown: pulse wave of the last 10 s with detected beats, beat intervals of the last 5 min
(ectopic beat candidates red, "felt" green), breathing motion of the last 60 s, movement,
and as numbers heart rate (PPG and sensor), RMSSD of the last 60 s, breaths/min.
Recording on the watch continues independently.
"""
import argparse
import json
import os
import signal as _signal
import math
import socket
import socketserver
import subprocess
import threading
import time
import webbrowser
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from scipy import signal

PPG_FS = 100.0
IMU_FS = 25.0
PPG_KEEP_S = 12
IMU_KEEP_S = 70
IBI_KEEP_S = 300


class State:
    def __init__(self, ppg_channel, record=None):
        self.lock = threading.Lock()
        self.fixed_ch = ppg_channel             # None = automatically pick the channel with the clearest pulse
        self.ch = ppg_channel if ppg_channel is not None else 6
        self.ch_quality = {}
        self.ch_checked = 0.0
        self.ppg_t = deque(maxlen=int(PPG_KEEP_S * PPG_FS))
        self.ppg_y = deque(maxlen=int(PPG_KEEP_S * PPG_FS))   # all channels v0…v6 (missing = NaN)
        self.last_p = ""
        self.error = ""
        self.rec = record                       # file every received line is written to
        self.sos_ppg = signal.butter(3, (0.6, 3.5), btype="band", fs=PPG_FS, output="sos")
        self.ppg_f = ([], [])                   # filtered pulse wave for display
        self.acc = deque(maxlen=int(IMU_KEEP_S * IMU_FS))
        self.gyro = deque(maxlen=int(IMU_KEEP_S * IMU_FS))
        self.hr = deque(maxlen=IBI_KEEP_S)
        self.beats = deque(maxlen=600)          # times of detected beats (ms)
        self.ibis = deque(maxlen=600)           # (t_ms, ibi_ms, flag)
        self.felt = deque(maxlen=200)
        self.proms = deque(maxlen=15)
        self.connected = False
        self.last_rx = 0.0
        self.lines = 0
        self.counts = {}
        self.breath = {"t": [], "y": [], "rate": None, "quality": 0.0}
        self.activity = {"t": [], "y": []}

    # ---- input (TCP thread) ----
    def feed(self, line: str):
        parts = line.strip().split(",")
        if not parts or parts[0] == "k":
            return
        kind = parts[0]
        self.counts[kind] = self.counts.get(kind, 0) + 1
        if self.rec:
            try:
                self.rec.write(line if line.endswith("\n") else line + "\n")
            except Exception:
                pass
        try:
            t = float(parts[1])
            with self.lock:
                self.last_rx = time.time()
                self.lines += 1
                if kind == "p":
                    self.last_p = line.strip()[:160]
                    vals = [float(v) for v in parts[2].split()[:7]]
                    if len(vals) <= self.ch:
                        self.counts["p_too_short"] = self.counts.get("p_too_short", 0) + 1
                    vals += [math.nan] * (7 - len(vals))
                    self.ppg_t.append(t)
                    self.ppg_y.append(vals)         # raw; channel choice and filtering in process()
                elif kind == "a":
                    self.acc.append((t, float(parts[2]), float(parts[3]), float(parts[4])))
                elif kind == "g":
                    self.gyro.append((t, float(parts[2]), float(parts[3]), float(parts[4])))
                elif kind == "h":
                    self.hr.append((t, float(parts[2])))
                elif kind == "e" and parts[2].startswith("felt"):
                    self.felt.append(t)
        except (ValueError, IndexError) as e:
            self.counts["malformed"] = self.counts.get("malformed", 0) + 1
            self.error = f"unreadable line ({e}): {line.strip()[:80]}"

    # ---- processing (every 200 ms) ----
    def process(self):
        with self.lock:
            pt, raw = np.array(self.ppg_t), np.array(self.ppg_y, dtype=float).reshape(-1, 7)
            acc, gyro = np.array(self.acc), np.array(self.gyro)
        if len(pt) > 1 and np.any(np.diff(pt) < 0):           # batches can overlap
            o = np.argsort(pt, kind="stable")
            pt, raw = pt[o], raw[o]
        if len(pt) > PPG_FS * 3:
            if self.fixed_ch is None and time.time() - self.ch_checked > 5:
                self._pick_channel(raw)
            py = raw[:, self.ch]
            ok = np.isfinite(py)
            if ok.sum() > PPG_FS * 3:
                pt, py = pt[ok], py[ok]
                # Zero-phase filtering (forward/backward): a causal filter shifts the peaks depending on
                # baseline wander and makes the intervals jitter by ±100 ms
                y = signal.sosfiltfilt(self.sos_ppg, py - py.mean())
                with self.lock:
                    self.ppg_f = (pt.tolist(), y.tolist())
                self._beats(pt, y)
        if len(acc) > IMU_FS * 5:
            mag = np.linalg.norm(acc[:, 1:], axis=1)
            w = int(IMU_FS)
            act = np.array([mag[max(0, i - w):i + 1].std() for i in range(len(mag))])
            step = 5
            with self.lock:
                self.activity = {"t": acc[::step, 0].tolist(), "y": act[::step].round(4).tolist()}
        src = gyro if len(gyro) > IMU_FS * 30 else acc
        if len(src) > IMU_FS * 30:
            self._breath(src, acc)

    def _pick_channel(self, raw):
        """Channel with the clearest pulse period (autocorrelation at 0.33–1.5 s) over the last 8 s."""
        self.ch_checked = time.time()
        seg = raw[-int(8 * PPG_FS):]
        q = {}
        for c in range(7):
            x = seg[:, c]
            # skip status/sentinel channels (negative codes, constant) and gaps
            if not np.all(np.isfinite(x)) or np.any(x < 0) or x.std() < 1e-6:
                continue
            f = signal.sosfiltfilt(self.sos_ppg, x - x.mean())
            z = (f - f.mean()) / (f.std() + 1e-12)
            ac = np.correlate(z, z, "full")[len(z) - 1:] / len(z)
            q[c] = round(float(ac[int(0.33 * PPG_FS):int(1.5 * PPG_FS)].max()), 2)
        with self.lock:
            self.ch_quality = q
            if q:
                best = max(q, key=q.get)
                if best != self.ch and q[best] > q.get(self.ch, -1) + 0.1:
                    self.ch = best

    def _moving_times(self):
        """Times with movement (std of |a| over 1 s > 0.03 m/s²) from the accelerometer buffer."""
        with self.lock:
            acc = np.array(self.acc)
        if len(acc) < IMU_FS * 2:
            return np.array([])
        mag = np.linalg.norm(acc[:, 1:], axis=1)
        w = int(IMU_FS)
        std = np.array([mag[max(0, i - w):i + 1].std() for i in range(len(mag))])
        return acc[std > 0.03, 0]

    def _beats(self, pt, py):
        # look for beats in the settled part (older than 1 s); prominence relative to amplitude
        recent = pt > pt[-1] - 2500
        amp = np.median(np.abs(py[recent])) + 1e-9
        pk, prop = signal.find_peaks(py, distance=int(0.33 * PPG_FS), prominence=0.8 * amp)
        pk = pk[pt[pk] > pt[0] + 1000]          # left edge: filter settling
        mov = self._moving_times()
        with self.lock:
            last = self.beats[-1] if self.beats else -1
            # Against double counting (dicrotic wave): minimum spacing 45 % of the typical interval.
            # No more, otherwise real early extra beats (often 50–70 %) are lost.
            med_ibi = float(np.median([i for _, i, _f in list(self.ibis)[-15:]])) if len(self.ibis) >= 5 else 600
            refr = max(330.0, 0.45 * med_ibi)
            prom = signal.peak_prominences(py, pk)[0] if len(pk) else []
            prom_ref = float(np.median(self.proms)) if len(self.proms) >= 5 else 0.0
            for n, p in enumerate(pk):
                tb = pt[p]
                # decide only after 1 s: at the right edge the prominence is still incomplete
                if tb <= last + refr or tb > pt[-1] - 1000:
                    continue
                # if a stronger peak follows shortly after (< 60 % interval), this one is a side wave/noise
                if n + 1 < len(pk) and pt[pk[n + 1]] - tb < 0.6 * med_ibi and prom[n + 1] > prom[n]:
                    continue
                if prom[n] < 0.25 * prom_ref:
                    continue
                if self.beats:
                    ibi = tb - self.beats[-1]
                    if 300 <= ibi <= 2500:
                        # median over the last 15 intervals (robust, cannot get "stuck")
                        ref = [i for _, i, _f in list(self.ibis)[-15:] if _f != "moving"] or [ibi]
                        med = float(np.median(ref))
                        flag = ""
                        if len(mov) and np.min(np.abs(mov - tb)) < 3000:
                            flag = "moving"
                        elif ibi < 0.8 * med:
                            flag = "short"
                        elif 1.75 * med <= ibi <= 2.3 * med:
                            flag = "missed pulse"
                        elif ibi > 1.15 * med and self.ibis and self.ibis[-1][2] == "short":
                            flag = "pause"
                        self.ibis.append((tb, ibi, flag))
                        if flag != "moving":
                            self.proms.append(prom[n])
                self.beats.append(tb)
                last = tb

    def _breath(self, src, acc):
        t = src[:, 0]
        sel = t > t[-1] - 60_000
        x = src[sel, 1:] - np.median(src[sel, 1:], axis=0)
        # neutralise movement sections (±3 s), otherwise movement wins the principal component
        if len(acc) > IMU_FS * 5:
            mag = np.linalg.norm(acc[:, 1:], axis=1)
            act = np.abs(np.diff(mag, prepend=mag[0]))
            moving_t = acc[act > 0.15, 0]
            ts = t[sel]
            if len(moving_t):
                near = np.min(np.abs(ts[:, None] - moving_t[None, :]), axis=1) < 3000 \
                    if len(moving_t) < 2000 else np.zeros(len(ts), bool)
                x[near] = 0
        sos = signal.butter(2, (0.1, 0.5), btype="band", fs=IMU_FS, output="sos")
        f = signal.sosfiltfilt(sos, x, axis=0)
        _, vecs = np.linalg.eigh(np.cov(f.T))
        pc = f @ vecs[:, -1]
        z = (pc - pc.mean()) / (pc.std() + 1e-12)
        ac = np.correlate(z, z, "full")[len(z) - 1:] / len(z)
        lo, hi = int(IMU_FS * 2), int(IMU_FS * 10)
        pk, _ = signal.find_peaks(ac[lo:hi])
        rate, q = None, 0.0
        if len(pk):
            best = ac[lo:hi][pk].max()
            cand = [p for p in pk if ac[lo + p] >= 0.8 * best]
            p = cand[0]
            rate, q = 60 * IMU_FS / (lo + p), float(ac[lo + p])
            if q < 0.3:
                rate = None
        with self.lock:
            self.breath = {"t": t[sel][::5].tolist(), "y": pc[::5].round(6).tolist(),
                           "rate": rate, "quality": q}

    # ---- output ----
    def snapshot(self):
        with self.lock:
            now = self.ppg_t[-1] if self.ppg_t else (self.acc[-1][0] if self.acc else 0)
            pt, py = self.ppg_f
            k = max(1, len(pt) // 600)
            ibis = [x for x in self.ibis if x[0] > now - IBI_KEEP_S * 1000]
            clean = [i for _t, i, f in ibis if f == "" and _t > now - 60_000]
            d = np.diff(clean) if len(clean) > 2 else np.array([])
            med = np.median(clean) if clean else None
            d = d[np.abs(d) < 0.2 * med] if med else d
            hr_sensor = self.hr[-1][1] if self.hr else None
            wall = time.time() * 1000
            yf = np.array(py) if py else np.array([0.0])
            diag = {
                "ch": self.ch, "auto": self.fixed_ch is None, "quality": self.ch_quality,
                "ppg_n": len(self.ppg_t),
                "ppg_span_s": round((self.ppg_t[-1] - self.ppg_t[0]) / 1000, 1) if len(self.ppg_t) > 1 else 0,
                "lag_ppg_s": round((wall - self.ppg_t[-1]) / 1000, 1) if self.ppg_t else None,
                "lag_acc_s": round((wall - self.acc[-1][0]) / 1000, 1) if self.acc else None,
                "filt_range": round(float(yf.max() - yf.min()), 1),
                "last_p": self.last_p,
                "error": self.error,
            }
            return {
                "diag": diag,
                "now": now,
                "connected": time.time() - self.last_rx < 3,
                "lines": self.lines,
                "counts": dict(self.counts),
                "ppg": {"t": pt[::k], "y": [round(v, 1) for v in py[::k]]},  # up to 1 s old, see below
                "beats": [b for b in self.beats if pt and b >= pt[0]],
                "ibis": ibis,
                "felt": list(self.felt),
                "hr": [x for x in self.hr if x[0] > now - IBI_KEEP_S * 1000],
                "breath": self.breath,
                "activity": self.activity,
                "numbers": {
                    "hr_ppg": round(60000 / np.median(clean[-10:]), 1) if len(clean) >= 3 else None,
                    "hr_sensor": hr_sensor,
                    "rmssd": round(float(np.sqrt(np.mean(d ** 2))), 1) if len(d) > 5 else None,
                    "breath": round(self.breath["rate"], 1) if self.breath["rate"] else None,
                    "breath_q": round(self.breath["quality"], 2),
                    "candidates_5min": sum(1 for x in ibis if x[2] and x[2] != "moving"),
                    "felt_5min": sum(1 for f in self.felt if f > now - IBI_KEEP_S * 1000),
                },
            }


def tcp_server(state, port):
    class Handler(socketserver.StreamRequestHandler):
        def handle(self):
            print(f"watch connected ({self.client_address[0]})")
            for raw in self.rfile:
                state.feed(raw.decode("utf-8", "ignore"))
            print("watch disconnected")

    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True      # otherwise Ctrl+C hangs on the open watch connection
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()


def demo_feeder(state):
    """Synthetic watch: heart rate ~62 bpm with an occasional ectopic beat, breathing 14/min, occasional movement."""
    rng = np.random.default_rng(0)
    t0 = time.time() * 1000
    next_beat, beat_n, last_imu, last_ppg = 0.0, 0, 0.0, 0.0
    beats = []
    while True:
        now = time.time() * 1000 - t0
        while next_beat < now + 2000:
            beats.append(next_beat)
            beat_n += 1
            base = 970 + 40 * math.sin(2 * math.pi * next_beat / 4300)
            if beat_n % 37 == 0:            # ectopic beat: early, followed by a compensatory pause
                beats.append(next_beat + 0.55 * base)
                next_beat += 2 * base
                if beat_n % 74 == 0:
                    state.feed(f"e,{t0 + next_beat + 900:.0f},felt")
            else:
                next_beat += base
        while last_ppg < now:
            last_ppg += 10
            ts = last_ppg
            x = sum(math.exp(-((ts - b) / 90) ** 2) + 0.25 * math.exp(-((ts - b - 320) / 60) ** 2)
                    for b in beats[-6:] if b <= ts + 300)
            resp = math.sin(2 * math.pi * ts / 4300)
            state.feed(f"p,{t0 + ts:.0f},850 150000 1000 920000 900000 1000 "
                       f"{700000 + 3000 * x + 400 * resp + rng.normal(0, 30):.0f}")
        if now - last_imu >= 40:
            moving = (now // 1000) % 47 in (0, 1)
            while last_imu + 40 <= now:
                last_imu += 40
                ts = last_imu
                resp = math.sin(2 * math.pi * ts / 4300)
                n = 0.3 if moving else 0.0015
                state.feed(f"a,{t0 + ts:.0f},{0.3 + 0.004 * resp + rng.normal(0, n)},"
                           f"{9.7 + rng.normal(0, n)},{1.0 + rng.normal(0, n)}")
                state.feed(f"g,{t0 + ts:.0f},{0.003 * resp + rng.normal(0, n / 2)},"
                           f"{0.0015 * resp + rng.normal(0, n / 2)},{rng.normal(0, n / 2)}")
        if int(now) % 1000 < 100:
            state.feed(f"h,{t0 + now:.0f},62")
        time.sleep(0.1)


def replay_feeder(state, session, speed):
    """Play back a saved session as if it were coming from the watch right now."""
    import pandas as pd
    from pathlib import Path
    s = Path(session)
    parts = []
    for name, kind in (("accel.csv", "a"), ("gyro.csv", "g")):
        if (s / name).exists():
            d = pd.read_csv(s / name)
            parts.append(pd.DataFrame({"t": d.epoch_ms, "line": kind + "," + d.epoch_ms.astype(str) + "," +
                                       d.x.astype(str) + "," + d.y.astype(str) + "," + d.z.astype(str)}))
    if (s / "hr.csv").exists():
        d = pd.read_csv(s / "hr.csv")
        parts.append(pd.DataFrame({"t": d.epoch_ms, "line": "h," + d.epoch_ms.astype(str) + "," + d.bpm.astype(str)}))
    if (s / "raw_ppg.csv").exists():
        d = pd.read_csv(s / "raw_ppg.csv")
        parts.append(pd.DataFrame({"t": d.epoch_ms, "line": "p," + d.epoch_ms.astype(str) + "," + d["values"]}))
    if (s / "events.csv").exists():
        d = pd.read_csv(s / "events.csv")
        d = d[d.event.astype(str).str.strip('"') == "felt"]
        parts.append(pd.DataFrame({"t": d.epoch_ms, "line": "e," + d.epoch_ms.astype(str) + ",felt"}))
    df = pd.concat(parts).sort_values("t", kind="stable")
    ts, lines = df.t.values.astype(float), df.line.values
    start_wall, start_t = time.time(), ts[0]
    i = 0
    while i < len(ts):
        due = start_t + (time.time() - start_wall) * 1000 * speed
        j = np.searchsorted(ts, due, side="right")
        for k in range(i, j):
            state.feed(lines[k])
        i = j
        time.sleep(0.05)
    print("replay finished")


def setup_adb(serial, port):
    cmd = ["adb"] + (["-s", serial] if serial else []) + ["reverse", f"tcp:{port}", f"tcp:{port}"]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=10)
    except FileNotFoundError:
        print("adb not found – is it on PATH? Otherwise set up the tunnel by hand: " + " ".join(cmd))
        return
    if r.returncode != 0 and "more than one" in (r.stderr + r.stdout) and not serial:
        devs = subprocess.run(["adb", "devices"], capture_output=True, text=True).stdout.splitlines()
        cands = [l.split()[0] for l in devs[1:] if l.strip().endswith("device")]
        print("Several devices: " + ", ".join(cands) + " – please choose one with --serial.")
        return
    print(("Tunnel ready: " if r.returncode == 0 else "Tunnel failed: ") + " ".join(cmd)
          + ("" if r.returncode == 0 else "\n" + r.stderr.strip()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", help="adb device, e.g. 192.168.178.35:41773")
    ap.add_argument("--port", type=int, default=9000)
    ap.add_argument("--http", type=int, default=8765)
    ap.add_argument("--channel", type=int, default=None,
                    help="fix the PPG channel (0–6); automatic if omitted (v6 was cleanest in testing)")
    ap.add_argument("--demo", action="store_true", help="without a watch, with synthetic data")
    ap.add_argument("--replay", help="play back a saved session instead of live")
    ap.add_argument("--speed", type=float, default=1.0, help="playback speed for --replay")
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()

    rec = None
    if not args.demo and not args.replay:
        from pathlib import Path
        d = Path(__file__).resolve().parent.parent / "sessions" / "live"
        d.mkdir(parents=True, exist_ok=True)
        rec_path = d / time.strftime("live_%Y%m%d_%H%M%S.txt")
        rec = open(rec_path, "w", buffering=1, encoding="utf-8")
        print(f"Recording received data to: {rec_path}")
    state = State(args.channel, rec)
    if args.demo:
        threading.Thread(target=demo_feeder, args=(state,), daemon=True).start()
    elif args.replay:
        threading.Thread(target=replay_feeder, args=(state, args.replay, args.speed), daemon=True).start()
    else:
        setup_adb(args.serial, args.port)
        tcp_server(state, args.port)

    def worker():
        while True:
            try:
                state.process()
            except Exception as e:      # the live view must never stop because of a computation error
                import traceback
                msg = f"processing: {type(e).__name__}: {e}"
                if msg != state.error:
                    print(msg)
                    traceback.print_exc()
                state.error = msg
            time.sleep(0.2)
    threading.Thread(target=worker, daemon=True).start()

    class Http(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            if self.path.startswith("/data"):
                body = json.dumps(state.snapshot()).encode()
                ctype = "application/json"
            else:
                body = PAGE.encode()
                ctype = "text/html; charset=utf-8"
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)

    # exit reliably on Ctrl+C, even while a watch connection is open
    _signal.signal(_signal.SIGINT, lambda *_: (print("\nstopped"), os._exit(0)))
    ThreadingHTTPServer.daemon_threads = True
    srv = ThreadingHTTPServer(("127.0.0.1", args.http), Http)
    url = f"http://localhost:{args.http}"
    print(f"Dashboard: {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever(poll_interval=0.2)
    except KeyboardInterrupt:
        print("stopped")
    finally:
        srv.server_close()
        os._exit(0)      # do not let open sockets/threads hang on Windows


PAGE = r"""<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SleepLogger live</title>
<style>
:root{--bg:#0f1115;--panel:#171a21;--ink:#e6e8ee;--muted:#8b93a7;--grid:#262b36;--line:#5aa9ff;--beat:#ffb454;--bad:#ff5c6c;--felt:#3ddc97;--alt:#c792ea}
@media (prefers-color-scheme: light){:root{--bg:#f6f7f9;--panel:#fff;--ink:#1b1f27;--muted:#5b6475;--grid:#e6e8ee;--line:#1f6feb;--beat:#d97706;--bad:#d1242f;--felt:#1a7f37;--alt:#8250df}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,sans-serif}
header{display:flex;align-items:center;gap:12px;padding:12px 16px}h1{font-size:16px;margin:0;font-weight:600}
.dot{width:10px;height:10px;border-radius:50%;background:var(--bad)}.dot.on{background:var(--felt)}
#status{color:var(--muted)}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;padding:0 16px 10px}
.tile{background:var(--panel);border-radius:10px;padding:10px 12px}.tile .v{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums}
.tile .l{color:var(--muted);font-size:12px}
.panel{background:var(--panel);border-radius:10px;margin:0 16px 10px;padding:8px 10px}
.panel .l{color:var(--muted);font-size:12px;margin-bottom:4px}.diag{color:var(--muted);font:11px/1.4 ui-monospace,monospace;margin-top:4px;word-break:break-all}canvas{width:100%;display:block}
</style></head><body>
<header><div id="dot" class="dot"></div><h1>SleepLogger live</h1><span id="status">waiting for watch …</span></header>
<div class="tiles">
 <div class="tile"><div class="v" id="hr_ppg">–</div><div class="l">Heart rate from pulse wave (bpm)</div></div>
 <div class="tile"><div class="v" id="hr_sensor">–</div><div class="l">Watch heart-rate sensor (bpm)</div></div>
 <div class="tile"><div class="v" id="rmssd">–</div><div class="l">RMSSD last 60 s (ms)</div></div>
 <div class="tile"><div class="v" id="breath">–</div><div class="l">Breaths/min (quality)</div></div>
 <div class="tile"><div class="v" id="cand">–</div><div class="l">Candidates / felt (5 min)</div></div>
</div>
<div class="panel"><div class="l">Pulse wave, last 10 s · dots = detected beats</div><canvas id="c_ppg" height="160"></canvas><div class="diag" id="diag"></div></div>
<div class="panel"><div class="l">Beat intervals, last 5 min (ms) · red = abnormal · grey = movement · green = felt · purple = heart-rate sensor</div><canvas id="c_ibi" height="160"></canvas></div>
<div class="panel"><div class="l">Breathing motion, last 60 s</div><canvas id="c_breath" height="110"></canvas></div>
<div class="panel"><div class="l">Movement, last 60 s</div><canvas id="c_act" height="70"></canvas></div>
<script>
const css=n=>getComputedStyle(document.documentElement).getPropertyValue(n).trim();
function setup(c){const r=window.devicePixelRatio||1,w=c.clientWidth,h=c.height/(c._r||1);c._r=r;c.width=w*r;c.height=h*r;
 const x=c.getContext('2d');x.setTransform(r,0,0,r,0,0);x.clearRect(0,0,w,h);return [x,w,h]}
function plot(id,ts,ys,t0,t1,opt={}){const c=document.getElementById(id);const [x,w,h]=setup(c);
 x.strokeStyle=css('--grid');x.lineWidth=1;for(let i=1;i<4;i++){x.beginPath();x.moveTo(0,h*i/4);x.lineTo(w,h*i/4);x.stroke()}
 if(!ts.length)return null;let lo=opt.lo??Infinity,hi=opt.hi??-Infinity;
 if(opt.lo==null){for(let i=0;i<ys.length;i++){if(ts[i]<t0)continue;lo=Math.min(lo,ys[i]);hi=Math.max(hi,ys[i])}}
 if(!(hi>lo)){hi=lo+1}const pad=(hi-lo)*0.08;lo-=pad;hi+=pad;
 const X=t=>(t-t0)/(t1-t0)*w,Y=v=>h-(v-lo)/(hi-lo)*h;
 if(opt.dots){for(let i=0;i<ts.length;i++){if(ts[i]<t0)continue;x.fillStyle=opt.color?.(i)||css('--line');x.beginPath();x.arc(X(ts[i]),Y(ys[i]),opt.r||2.5,0,7);x.fill()}}
 else{x.strokeStyle=opt.stroke||css('--line');x.lineWidth=1.6;x.beginPath();let s=false;
  for(let i=0;i<ts.length;i++){if(ts[i]<t0)continue;const px=X(ts[i]),py=Y(ys[i]);s?x.lineTo(px,py):x.moveTo(px,py);s=true}x.stroke()}
 if(opt.ticks){x.fillStyle=css('--muted');x.font='11px system-ui';x.fillText(Math.round(hi-pad),4,12);x.fillText(Math.round(lo+pad),4,h-4)}
 return {x,X,Y,w,h}}
function vlines(g,ts,color,t0){if(!g)return;g.x.strokeStyle=color;g.x.lineWidth=2;for(const t of ts){if(t<t0)continue;g.x.beginPath();g.x.moveTo(g.X(t),0);g.x.lineTo(g.X(t),g.h);g.x.stroke()}}
const fmt=(v,d=0)=>v==null?'–':Number(v).toFixed(d);
async function tick(){try{const d=await (await fetch('/data')).json();
 document.getElementById('dot').classList.toggle('on',d.connected);
 document.getElementById('status').textContent=d.connected?`connected · pulse wave ${d.counts.p||0} · accel ${d.counts.a||0} · gyro ${d.counts.g||0} · heart rate ${d.counts.h||0}`+(d.counts.p?'':' · no pulse wave: start with "Start + PPG" on the watch')+(d.counts.p_too_short?` · ${d.counts.p_too_short} PPG lines too short (other channel needed)`:''):'waiting for watch …';
 const n=d.numbers;hr_ppg.textContent=fmt(n.hr_ppg);hr_sensor.textContent=fmt(n.hr_sensor);rmssd.textContent=fmt(n.rmssd);
 breath.textContent=n.breath?`${fmt(n.breath,1)} (${fmt(n.breath_q,2)})`:'–';cand.textContent=`${n.candidates_5min} / ${n.felt_5min}`;
 const now=d.now;const g_=d.diag;
 document.getElementById('diag').textContent=`channel v${g_.ch}${g_.auto?' (auto)':''} · quality ${Object.entries(g_.quality).map(([c,q])=>'v'+c+'='+q).join(' ')||'–'} · buffer ${g_.ppg_n} values / ${g_.ppg_span_s} s · lag PPG ${g_.lag_ppg_s??'–'} s, accel ${g_.lag_acc_s??'–'} s · range ${g_.filt_range}${d.counts.malformed?' · '+d.counts.malformed+' malformed lines':''}${g_.error?' · '+g_.error:''} · last line: ${g_.last_p}`;
 const g=plot('c_ppg',d.ppg.t,d.ppg.y,now-10000,now);
 if(g){const bt=d.beats.filter(b=>b>=now-10000);g.x.fillStyle=css('--beat');
  for(const b of bt){let i=d.ppg.t.findIndex(t=>t>=b);if(i<0)continue;g.x.beginPath();g.x.arc(g.X(b),g.Y(d.ppg.y[i]),3.5,0,7);g.x.fill()}}
 const it=d.ibis.map(r=>r[0]),iv=d.ibis.map(r=>r[1]);
 const gi=plot('c_ibi',it,iv,now-300000,now,{dots:true,lo:400,hi:1800,ticks:true,color:i=>d.ibis[i][2]==='moving'?css('--muted'):(d.ibis[i][2]?css('--bad'):css('--line'))});
 if(gi){gi.x.strokeStyle=css('--alt');gi.x.lineWidth=1.5;gi.x.beginPath();let s=false;
  for(const [t,b] of d.hr){if(t<now-300000)continue;const px=gi.X(t),py=gi.Y(60000/b);s?gi.x.lineTo(px,py):gi.x.moveTo(px,py);s=true}gi.x.stroke()}
 vlines(gi,d.felt,css('--felt'),now-300000);
 plot('c_breath',d.breath.t,d.breath.y,now-60000,now,{stroke:css('--alt')});
 plot('c_act',d.activity.t,d.activity.y,now-60000,now,{lo:0,hi:Math.max(0.1,...d.activity.y.slice(-300))});
}catch(e){document.getElementById('status').textContent='dashboard server unreachable'}}
setInterval(tick,250);tick();
</script></body></html>"""


if __name__ == "__main__":
    main()
