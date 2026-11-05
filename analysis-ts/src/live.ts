/**
 * Live-Dashboard: Uhr -> ADB-Tunnel -> Laptop -> Browser (TypeScript-Fassung von analysis/live.py).
 *
 *     npx tsx src/live.ts --serial 192.168.178.35:41773
 *     npx tsx src/live.ts --demo
 *     npx tsx src/live.ts --replay ../sessions/<session> [--speed 4]
 *
 * Gleiches Protokoll wie live.py (Uhr verbindet sich auf 127.0.0.1:9000), gleiche Seite auf
 * http://localhost:8765. Alles Empfangene wird nach sessions/live/live_<Zeit>.txt mitgeschrieben.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, type WriteStream } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createTcp } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { autocorr, butterBandpass, findPeaks, peakProminences, principalComponent, sosfiltfilt } from "./lib/dsp.ts";
import { argValue, readEvents, readNumericCsv } from "./lib/io.ts";
import { mean, median, std } from "./lib/stats.ts";

const PPG_FS = 100, IMU_FS = 25, PPG_KEEP_S = 12, IMU_KEEP_S = 70, IBI_KEEP_S = 300;
const HERE = dirname(fileURLToPath(import.meta.url));

/** Ringpuffer mit fester Länge (wie deque(maxlen)). */
class Ring<T> {
  private a: T[] = [];
  constructor(private max: number) {}
  push(v: T) { this.a.push(v); if (this.a.length > this.max * 1.5) this.a = this.a.slice(-this.max); }
  get items(): T[] { if (this.a.length > this.max) this.a = this.a.slice(-this.max); return this.a; }
  get length() { return Math.min(this.a.length, this.max); }
  last(): T | undefined { return this.a[this.a.length - 1]; }
}

type Imu = [number, number, number, number];
type Ibi = [number, number, string];

class State {
  ch: number;
  chQuality: Record<number, number> = {};
  chChecked = 0;
  ppgT = new Ring<number>(PPG_KEEP_S * PPG_FS);
  ppgY = new Ring<number[]>(PPG_KEEP_S * PPG_FS);
  sosPpg = butterBandpass(3, 0.6, 3.5, PPG_FS);
  sosBreath = butterBandpass(2, 0.1, 0.5, IMU_FS);
  ppgF: [number[], number[]] = [[], []];
  acc = new Ring<Imu>(IMU_KEEP_S * IMU_FS);
  gyro = new Ring<Imu>(IMU_KEEP_S * IMU_FS);
  hr = new Ring<[number, number]>(IBI_KEEP_S);
  beats = new Ring<number>(600);
  ibis = new Ring<Ibi>(600);
  felt = new Ring<number>(200);
  proms = new Ring<number>(15);
  lastRx = 0;
  lines = 0;
  counts: Record<string, number> = {};
  breath: { t: number[]; y: number[]; rate: number | null; quality: number } = { t: [], y: [], rate: null, quality: 0 };
  activity: { t: number[]; y: number[] } = { t: [], y: [] };
  lastP = "";
  error = "";

  constructor(public fixedCh: number | null, private rec: WriteStream | null) {
    this.ch = fixedCh ?? 6;
  }

  feed(line: string) {
    const s = line.trim();
    const parts = s.split(",");
    if (!s || parts[0] === "k") return;
    const kind = parts[0];
    this.counts[kind] = (this.counts[kind] ?? 0) + 1;
    this.rec?.write(s + "\n");
    const t = Number(parts[1]);
    const bad = (why: string) => {
      this.counts.kaputt = (this.counts.kaputt ?? 0) + 1;
      this.error = `Zeile nicht lesbar (${why}): ${s.slice(0, 80)}`;
    };
    if (parts.length < 3 || Number.isNaN(t)) return bad("Format");
    this.lastRx = Date.now();
    this.lines++;
    if (kind === "p") {
      this.lastP = s.slice(0, 160);
      const vals = parts[2].trim().split(/\s+/).slice(0, 7).map(Number);
      if (vals.some(Number.isNaN)) return bad("Zahl");
      if (vals.length <= this.ch) this.counts.p_zu_kurz = (this.counts.p_zu_kurz ?? 0) + 1;
      while (vals.length < 7) vals.push(NaN);
      this.ppgT.push(t); this.ppgY.push(vals);
    } else if (kind === "a" || kind === "g") {
      const v = parts.slice(2, 5).map(Number);
      if (v.length < 3 || v.some(Number.isNaN)) return bad("Zahl");
      (kind === "a" ? this.acc : this.gyro).push([t, v[0], v[1], v[2]]);
    } else if (kind === "h") {
      const v = Number(parts[2]);
      if (Number.isNaN(v)) return bad("Zahl");
      this.hr.push([t, v]);
    } else if (kind === "e" && parts[2].startsWith("felt")) this.felt.push(t);
  }

  process() {
    let pt = this.ppgT.items.slice(), raw = this.ppgY.items.slice();
    if (pt.length !== raw.length) { const n = Math.min(pt.length, raw.length); pt = pt.slice(-n); raw = raw.slice(-n); }
    let sorted = true;
    for (let i = 1; i < pt.length; i++) if (pt[i] < pt[i - 1]) { sorted = false; break; }
    if (!sorted) {
      const o = pt.map((_, i) => i).sort((a, b) => pt[a] - pt[b] || a - b);
      pt = o.map((i) => pt[i]); raw = o.map((i) => raw[i]);
    }
    if (pt.length > PPG_FS * 3) {
      if (this.fixedCh === null && Date.now() - this.chChecked > 5000) this.pickChannel(raw);
      const keep = raw.map((r, i) => i).filter((i) => Number.isFinite(raw[i][this.ch]));
      if (keep.length > PPG_FS * 3) {
        const t = keep.map((i) => pt[i]);
        const py = keep.map((i) => raw[i][this.ch]);
        const m = mean(py);
        const y = sosfiltfilt(this.sosPpg, py.map((v) => v - m));
        this.ppgF = [t, Array.from(y)];
        this.detectBeats(t, y);
      }
    }
    const acc = this.acc.items, gyro = this.gyro.items;
    if (acc.length > IMU_FS * 5) {
      const act = this.rollingStdLeft(acc);
      const tt: number[] = [], yy: number[] = [];
      for (let i = 0; i < acc.length; i += 5) { tt.push(acc[i][0]); yy.push(Math.round(act[i] * 1e4) / 1e4); }
      this.activity = { t: tt, y: yy };
    }
    const src = gyro.length > IMU_FS * 30 ? gyro : acc;
    if (src.length > IMU_FS * 30) this.computeBreath(src, acc);
  }

  /** Std (ddof 0) von |a| über die letzte Sekunde je Messpunkt. */
  private rollingStdLeft(acc: Imu[]): number[] {
    const mag = acc.map(([, x, y, z]) => Math.hypot(x, y, z));
    const w = IMU_FS;
    return mag.map((_, i) => std(mag.slice(Math.max(0, i - w), i + 1), 0));
  }

  private pickChannel(raw: number[][]) {
    this.chChecked = Date.now();
    const seg = raw.slice(-8 * PPG_FS);
    const q: Record<number, number> = {};
    for (let c = 0; c < 7; c++) {
      const x = seg.map((r) => r[c]);
      if (x.some((v) => !Number.isFinite(v) || v < 0) || std(x, 0) < 1e-6) continue;
      const m = mean(x);
      const fl = sosfiltfilt(this.sosPpg, x.map((v) => v - m));
      const fm = mean(fl), fsd = std(fl, 0) + 1e-12;
      const ac = autocorr(fl.map((v) => (v - fm) / fsd), Math.trunc(1.5 * PPG_FS));
      let best = -Infinity;
      for (let k = Math.trunc(0.33 * PPG_FS); k < Math.trunc(1.5 * PPG_FS); k++) best = Math.max(best, ac[k]);
      q[c] = Math.round(best * 100) / 100;
    }
    this.chQuality = q;
    const keys = Object.keys(q).map(Number);
    if (keys.length) {
      const best = keys.reduce((a, b) => (q[b] > q[a] ? b : a));
      if (best !== this.ch && q[best] > (q[this.ch] ?? -1) + 0.1) this.ch = best;
    }
  }

  private movingTimes(): number[] {
    const acc = this.acc.items;
    if (acc.length < IMU_FS * 2) return [];
    const sd = this.rollingStdLeft(acc);
    return acc.filter((_, i) => sd[i] > 0.03).map((a) => a[0]);
  }

  private detectBeats(pt: number[], py: Float64Array) {
    const tEnd = pt[pt.length - 1];
    const recent: number[] = [];
    for (let i = 0; i < pt.length; i++) if (pt[i] > tEnd - 2500) recent.push(Math.abs(py[i]));
    const amp = median(recent) + 1e-9;
    let { peaks } = findPeaks(py, { distance: Math.trunc(0.33 * PPG_FS), prominence: 0.8 * amp });
    peaks = peaks.filter((p) => pt[p] > pt[0] + 1000);
    const mov = this.movingTimes();
    let last = this.beats.last() ?? -1;
    const ibis = this.ibis.items;
    const medIbi = ibis.length >= 5 ? median(ibis.slice(-15).map((x) => x[1])) : 600;
    const refr = Math.max(330, 0.45 * medIbi);
    const prom = peaks.length ? peakProminences(py, peaks) : new Float64Array(0);
    const promRef = this.proms.length >= 5 ? median(this.proms.items) : 0;
    peaks.forEach((p, n) => {
      const tb = pt[p];
      if (tb <= last + refr || tb > tEnd - 1000) return;
      if (n + 1 < peaks.length && pt[peaks[n + 1]] - tb < 0.6 * medIbi && prom[n + 1] > prom[n]) return;
      if (prom[n] < 0.25 * promRef) return;
      const prevBeat = this.beats.last();
      if (prevBeat !== undefined) {
        const ibi = tb - prevBeat;
        if (ibi >= 300 && ibi <= 2500) {
          const ref = this.ibis.items.slice(-15).filter((x) => x[2] !== "bewegt").map((x) => x[1]);
          const med = median(ref.length ? ref : [ibi]);
          let flag = "";
          const prevFlag = this.ibis.last()?.[2];
          if (mov.length && Math.min(...mov.map((m) => Math.abs(m - tb))) < 3000) flag = "bewegt";
          else if (ibi < 0.8 * med) flag = "kurz";
          else if (ibi >= 1.75 * med && ibi <= 2.3 * med) flag = "Puls fehlt";
          else if (ibi > 1.15 * med && prevFlag === "kurz") flag = "Pause";
          this.ibis.push([tb, ibi, flag]);
          if (flag !== "bewegt") this.proms.push(prom[n]);
        }
      }
      this.beats.push(tb);
      last = tb;
    });
  }

  private computeBreath(src: Imu[], acc: Imu[]) {
    const tEnd = src[src.length - 1][0];
    const sel = src.filter((r) => r[0] > tEnd - 60000);
    const ts = sel.map((r) => r[0]);
    const cols = [1, 2, 3].map((k) => {
      const v = sel.map((r) => r[k]);
      const md = median(v);
      return v.map((x) => x - md);
    });
    if (acc.length > IMU_FS * 5) {
      const mag = acc.map(([, x, y, z]) => Math.hypot(x, y, z));
      const movingT = acc.filter((_, i) => Math.abs(mag[i] - mag[i ? i - 1 : 0]) > 0.15).map((a) => a[0]);
      if (movingT.length && movingT.length < 2000) {
        ts.forEach((t, i) => { if (movingT.some((m) => Math.abs(t - m) < 3000)) for (const c of cols) c[i] = 0; });
      }
    }
    if (ts.length < 20) return;
    const filt = cols.map((c) => sosfiltfilt(this.sosBreath, c));
    const pc = principalComponent(filt);
    const m = mean(pc), sd = std(pc, 0) + 1e-12;
    const z = pc.map((v) => (v - m) / sd);
    const lo = IMU_FS * 2, hi = IMU_FS * 10;
    const ac = autocorr(z, hi);
    const { peaks } = findPeaks(ac.subarray(lo, hi));
    let rate: number | null = null, q = 0;
    if (peaks.length) {
      const best = Math.max(...peaks.map((p) => ac[lo + p]));
      const p = peaks.find((pp) => ac[lo + pp] >= 0.8 * best)!;
      rate = (60 * IMU_FS) / (lo + p); q = ac[lo + p];
      if (q < 0.3) rate = null;
    }
    const tt: number[] = [], yy: number[] = [];
    for (let i = 0; i < ts.length; i += 5) { tt.push(ts[i]); yy.push(Math.round(pc[i] * 1e6) / 1e6); }
    this.breath = { t: tt, y: yy, rate, quality: q };
  }

  snapshot() {
    const ppgT = this.ppgT.items, acc = this.acc.items;
    const now = ppgT.length ? ppgT[ppgT.length - 1] : acc.length ? acc[acc.length - 1][0] : 0;
    const [pt, py] = this.ppgF;
    const k = Math.max(1, Math.floor(pt.length / 600));
    const ibis = this.ibis.items.filter((x) => x[0] > now - IBI_KEEP_S * 1000);
    const clean = ibis.filter(([t, , fl]) => fl === "" && t > now - 60000).map((x) => x[1]);
    let d = clean.length > 2 ? clean.slice(1).map((v, i) => v - clean[i]) : [];
    const med = clean.length ? median(clean) : null;
    if (med) d = d.filter((v) => Math.abs(v) < 0.2 * med);
    const hrLast = this.hr.last();
    const wall = Date.now();
    const yf = py.length ? py : [0];
    const round1 = (v: number) => Math.round(v * 10) / 10;
    return {
      diag: {
        ch: this.ch, auto: this.fixedCh === null, quality: this.chQuality, ppg_n: ppgT.length,
        ppg_span_s: ppgT.length > 1 ? round1((ppgT[ppgT.length - 1] - ppgT[0]) / 1000) : 0,
        lag_ppg_s: ppgT.length ? round1((wall - ppgT[ppgT.length - 1]) / 1000) : null,
        lag_acc_s: acc.length ? round1((wall - acc[acc.length - 1][0]) / 1000) : null,
        filt_range: round1(Math.max(...yf) - Math.min(...yf)),
        last_p: this.lastP, error: this.error, engine: "TypeScript",
      },
      now,
      connected: wall - this.lastRx < 3000,
      lines: this.lines,
      counts: { ...this.counts },
      ppg: { t: pt.filter((_, i) => i % k === 0), y: py.filter((_, i) => i % k === 0).map(round1) },
      beats: this.beats.items.filter((b) => pt.length && b >= pt[0]),
      ibis,
      felt: this.felt.items,
      hr: this.hr.items.filter((x) => x[0] > now - IBI_KEEP_S * 1000),
      breath: this.breath,
      activity: this.activity,
      numbers: {
        hr_ppg: clean.length >= 3 ? round1(60000 / median(clean.slice(-10))) : null,
        hr_sensor: hrLast ? hrLast[1] : null,
        rmssd: d.length > 5 ? round1(Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length)) : null,
        breath: this.breath.rate ? round1(this.breath.rate) : null,
        breath_q: Math.round(this.breath.quality * 100) / 100,
        candidates_5min: ibis.filter((x) => x[2] && x[2] !== "bewegt").length,
        felt_5min: this.felt.items.filter((t) => t > now - IBI_KEEP_S * 1000).length,
      },
    };
  }
}

function tcpServer(state: State, port: number) {
  const srv = createTcp((sock) => {
    console.log(`Uhr verbunden (${sock.remoteAddress})`);
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) { state.feed(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    sock.on("close", () => console.log("Uhr getrennt"));
    sock.on("error", () => { /* Uhr weg */ });
  });
  srv.on("error", (e) => console.error(`TCP-Port ${port}: ${e.message}`));
  srv.listen(port, "127.0.0.1");
}

/** Synthetische Uhr: Puls ~62 bpm, gelegentliche Extrasystole, Atmung 14/min, ab und zu Bewegung. */
function demoFeeder(state: State) {
  let seed = 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const normal = (s: number) => s * Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
  const t0 = Date.now();
  let nextBeat = 0, beatN = 0, lastImu = 0, lastPpg = 0;
  const beats: number[] = [];
  setInterval(() => {
    const now = Date.now() - t0;
    while (nextBeat < now + 2000) {
      beats.push(nextBeat); beatN++;
      const base = 970 + 40 * Math.sin((2 * Math.PI * nextBeat) / 4300);
      if (beatN % 37 === 0) {
        beats.push(nextBeat + 0.55 * base);
        nextBeat += 2 * base;
        if (beatN % 74 === 0) state.feed(`e,${Math.round(t0 + nextBeat + 900)},felt`);
      } else nextBeat += base;
    }
    while (lastPpg < now) {
      lastPpg += 10;
      const ts = lastPpg;
      let x = 0;
      for (const b of beats.slice(-6)) if (b <= ts + 300) x += Math.exp(-(((ts - b) / 90) ** 2)) + 0.25 * Math.exp(-(((ts - b - 320) / 60) ** 2));
      const resp = Math.sin((2 * Math.PI * ts) / 4300);
      state.feed(`p,${Math.round(t0 + ts)},850 150000 1000 920000 900000 1000 ${Math.round(700000 + 3000 * x + 400 * resp + normal(30))}`);
    }
    if (now - lastImu >= 40) {
      const moving = [0, 1].includes(Math.floor(now / 1000) % 47);
      while (lastImu + 40 <= now) {
        lastImu += 40;
        const resp = Math.sin((2 * Math.PI * lastImu) / 4300);
        const n = moving ? 0.3 : 0.0015;
        state.feed(`a,${Math.round(t0 + lastImu)},${0.3 + 0.004 * resp + normal(n)},${9.7 + normal(n)},${1.0 + normal(n)}`);
        state.feed(`g,${Math.round(t0 + lastImu)},${0.003 * resp + normal(n / 2)},${0.0015 * resp + normal(n / 2)},${normal(n / 2)}`);
      }
    }
    if (Math.trunc(now) % 1000 < 100) state.feed(`h,${Math.round(t0 + now)},62`);
  }, 100);
}

/** Gespeicherte Session so abspielen, als käme sie gerade von der Uhr. */
function replayFeeder(state: State, session: string, speed: number) {
  const rows: [number, string][] = [];
  for (const [name, kind] of [["accel.csv", "a"], ["gyro.csv", "g"]] as const) {
    const p = join(session, name);
    if (!existsSync(p)) continue;
    const d = readNumericCsv(p, ["epoch_ms", "x", "y", "z"]);
    for (let i = 0; i < d.epoch_ms.length; i++) rows.push([d.epoch_ms[i], `${kind},${d.epoch_ms[i]},${d.x[i]},${d.y[i]},${d.z[i]}`]);
  }
  if (existsSync(join(session, "hr.csv"))) {
    const d = readNumericCsv(join(session, "hr.csv"), ["epoch_ms", "bpm"]);
    for (let i = 0; i < d.epoch_ms.length; i++) rows.push([d.epoch_ms[i], `h,${d.epoch_ms[i]},${d.bpm[i]}`]);
  }
  const pp = join(session, "raw_ppg.csv");
  if (existsSync(pp)) {
    for (const line of readFileSync(pp, "latin1").split("\n").slice(1)) {
      if (!line) continue;
      const c1 = line.indexOf(","), c3 = line.indexOf(",", line.indexOf(",", c1 + 1) + 1);
      rows.push([Number(line.slice(0, c1)), `p,${line.slice(0, c1)},${line.slice(c3 + 1).trim()}`]);
    }
  }
  for (const e of readEvents(session)) if (e.event === "felt") rows.push([e.t, `e,${e.t},felt`]);
  rows.sort((a, b) => a[0] - b[0]);
  if (!rows.length) { console.error("Replay: keine Daten gefunden"); return; }
  const startWall = Date.now(), startT = rows[0][0];
  let i = 0;
  const timer = setInterval(() => {
    const due = startT + (Date.now() - startWall) * speed;
    while (i < rows.length && rows[i][0] <= due) state.feed(rows[i++][1]);
    if (i >= rows.length) { clearInterval(timer); console.log("Replay zu Ende"); }
  }, 50);
}

function setupAdb(serial: string | undefined, port: number) {
  const args = [...(serial ? ["-s", serial] : []), "reverse", `tcp:${port}`, `tcp:${port}`];
  const r = spawnSync("adb", args, { encoding: "utf8", timeout: 10000 });
  if (r.error) { console.log(`adb nicht gefunden – im PATH? Sonst Tunnel von Hand: adb ${args.join(" ")}`); return; }
  if (r.status !== 0 && /more than one/.test(r.stderr + r.stdout) && !serial) {
    const devs = execFileSync("adb", ["devices"], { encoding: "utf8" }).split("\n").slice(1)
      .filter((l) => l.trim().endsWith("device")).map((l) => l.split(/\s+/)[0]);
    console.log(`Mehrere Geräte: ${devs.join(", ")} – bitte mit --serial wählen.`);
    return;
  }
  console.log((r.status === 0 ? "Tunnel steht: " : "Tunnel fehlgeschlagen: ") + `adb ${args.join(" ")}` + (r.status === 0 ? "" : `\n${r.stderr.trim()}`));
}

function openBrowser(url: string) {
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const c = spawn(cmd[0] as string, cmd[1] as string[], { stdio: "ignore", detached: true });
    c.on("error", () => { /* kein Browser – Adresse steht in der Konsole */ });
    c.unref();
  } catch { /* egal */ }
}

function main() {
  const args = process.argv.slice(2);
  const has = (n: string) => args.includes(n);
  const port = Number(argValue(args, "--port") ?? 9000);
  const http = Number(argValue(args, "--http") ?? 8765);
  const chArg = argValue(args, "--channel");
  let rec: WriteStream | null = null;
  const replay = argValue(args, "--replay");
  if (!has("--demo") && !replay) {
    const dir = join(HERE, "..", "..", "sessions", "live");
    mkdirSync(dir, { recursive: true });
    const d = new Date(), p2 = (n: number) => String(n).padStart(2, "0");
    const path = join(dir, `live_${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}.txt`);
    rec = createWriteStream(path, { encoding: "utf8" });
    console.log(`Empfangene Daten werden mitgeschrieben: ${path}`);
  }
  const state = new State(chArg !== undefined ? Number(chArg) : null, rec);
  if (has("--demo")) demoFeeder(state);
  else if (replay) replayFeeder(state, replay, Number(argValue(args, "--speed") ?? 1));
  else { setupAdb(argValue(args, "--serial"), port); tcpServer(state, port); }

  setInterval(() => {
    try { state.process(); } catch (e) {
      const msg = `Verarbeitung: ${(e as Error).name}: ${(e as Error).message}`;
      if (msg !== state.error) { console.log(msg); console.log((e as Error).stack); }
      state.error = msg;
    }
  }, 200);

  const page = readFileSync(join(HERE, "live_page.html"), "utf8").replace("<h1>SleepLogger live</h1>", "<h1>SleepLogger live · TS</h1>");
  const srv = createHttp((req, res) => {
    if (req.url?.startsWith("/data")) {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(state.snapshot()));
    } else {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(page);
    }
  });
  srv.listen(http, "127.0.0.1", () => {
    const url = `http://localhost:${http}`;
    console.log(`Dashboard: ${url}  (Strg+C beendet)`);
    if (!has("--no-browser")) setTimeout(() => openBrowser(url), 1000);
  });
  process.on("SIGINT", () => { console.log("\nbeendet"); rec?.end(); process.exit(0); });
}

main();
