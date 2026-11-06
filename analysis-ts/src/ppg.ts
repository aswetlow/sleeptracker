/**
 * Beat-to-beat analysis of the raw pulse wave (raw_ppg.csv, button "Start + PPG").
 * TypeScript version of legacy/python/ppg.py, same rules and output files.
 *
 *     npx tsx src/ppg.ts ../sessions/<session> [--channel 6]
 *
 * Candidates, not a diagnosis. Validation only with a simultaneous ECG.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { butterBandpass, findPeaks, peakProminences, sosfiltfilt, welchBins } from "./lib/dsp.ts";
import { argValue, f, hms, readEvents, readNumericCsv, sortBy, writeCsv } from "./lib/io.ts";
import { interp, mean, median, rollingMedian, rollingStd, searchsorted, std } from "./lib/stats.ts";

const BAND: [number, number] = [0.6, 3.5];
const MOTION_THR = 0.03;
const MOTION_PAD_S = 3.0;
const MIN_CORR = 0.6;
const WIN_MED = 9;

export interface Ppg { t: Float64Array; ch: Float32Array[] }

/** raw_ppg.csv: epoch_ms,accuracy,n,"v0 v1 …" – rows whose time is not greater than the previous row's are dropped (like ppg.py). */
export function loadPpg(session: string): Ppg {
  const buf = readFileSync(join(session, "raw_ppg.csv"));
  let rows = 0;
  for (let i = 0; i < buf.length; i++) if (buf[i] === 10) rows++;
  const t = new Float64Array(rows);
  const ch: Float32Array[] = [];
  let pos = buf.indexOf(10) + 1, r = 0, last = -Infinity;
  while (pos < buf.length) {
    let end = buf.indexOf(10, pos);
    if (end < 0) end = buf.length;
    if (end > pos) {
      const line = buf.toString("latin1", pos, end);
      const c1 = line.indexOf(","), c2 = line.indexOf(",", c1 + 1), c3 = line.indexOf(",", c2 + 1);
      const ts = Number(line.slice(0, c1));
      const keep = ts > last;
      last = ts;
      if (keep) {
        const vals = line.slice(c3 + 1).trim().split(" ");
        while (ch.length < vals.length) ch.push(new Float32Array(rows).fill(NaN));
        t[r] = ts;
        for (let k = 0; k < ch.length; k++) ch[k][r] = k < vals.length ? Number(vals[k]) : NaN;
        r++;
      }
    }
    pos = end + 1;
  }
  return { t: t.slice(0, r), ch: ch.map((c) => c.slice(0, r)) };
}

/** Movement: std of |a| over 25 values > MOTION_THR, widened by ±3 s, mapped onto the PPG timestamps. */
export function motionMask(session: string, tMs: Float64Array): Uint8Array {
  const acc = sortBy(readNumericCsv(join(session, "accel.csv"), ["epoch_ms", "x", "y", "z"]), "epoch_ms");
  const mag = acc.x.map((x, i) => Math.hypot(x, acc.y[i], acc.z[i]));
  const act = rollingStd(mag, 25, 5).map((v) => (Number.isNaN(v) ? 0 : v));
  const at = interp(tMs, acc.epoch_ms, act);
  const pad = Math.trunc(MOTION_PAD_S * 100);
  const n = tMs.length, out = new Uint8Array(n);
  // convolution with ones (length 2·pad+1, "same") > 0 == any moving value in [i-pad, i+pad]
  let lastMove = -Infinity;
  for (let i = 0; i < n; i++) if (at[i] > MOTION_THR) lastMove = i; else if (i - lastMove <= pad) out[i] = 1;
  let nextMove = Infinity;
  for (let i = n - 1; i >= 0; i--) {
    if (at[i] > MOTION_THR) { nextMove = i; out[i] = 1; } else if (nextMove - i <= pad) out[i] = 1;
  }
  return out;
}

const SOS = (fs: number) => butterBandpass(3, BAND[0], BAND[1], fs);

/** Fill NaN linearly (edges with the nearest value), subtract the mean, filter with zero phase. */
export function bandpass(x: ArrayLike<number>, fs: number): Float64Array {
  const y = Float64Array.from(x as ArrayLike<number>);
  let prev = -1;
  for (let i = 0; i <= y.length; i++) {
    if (i < y.length && Number.isNaN(y[i])) continue;
    if (i - prev > 1) {
      for (let k = prev + 1; k < i; k++) {
        y[k] = prev < 0 ? y[i] : i >= y.length ? y[prev] : y[prev] + ((y[i] - y[prev]) * (k - prev)) / (i - prev);
      }
    }
    prev = i;
  }
  const m = mean(y);
  for (let i = 0; i < y.length; i++) y[i] -= m;
  return sosfiltfilt(SOS(fs), y);
}

export function pickChannel(ch: Float32Array[], fs: number, still: Uint8Array): [number | null, number] {
  let best: number | null = null, score = 0;
  const nper = Math.trunc(fs * 8);
  const kLo = Math.ceil((0.7 * nper) / fs), kHi = Math.floor((3.0 * nper) / fs);
  ch.forEach((x, c) => {
    let finiteN = 0, sentinel = 0;
    for (let i = 0; i < x.length; i++) { if (!Number.isNaN(x[i])) finiteN++; if (x[i] < -1000) sentinel++; }
    if (!finiteN || std(x, 0) === 0 || sentinel / x.length > 0.05) return;
    const yAll = bandpass(x, fs);
    const y: number[] = [];
    for (let i = 0; i < yAll.length; i++) if (still[i]) y.push(yAll[i]);
    if (y.length < fs * 20) return;
    const p = welchBins(y, nper, kLo, kHi);
    let mx = 0, sum = 0;
    for (const v of p) { sum += v; if (v > mx) mx = v; }
    const s = mx / sum;
    if (s > score) { best = c; score = s; }
  });
  return [best, score];
}

export interface Beats {
  t: number[]; amp: number[]; corr: number[]; moving: boolean[]; ibi: number[]; clean: boolean[]; ibiMed: number[]; flag: string[];
}
export interface PpgEvent {
  t: number; kind: string; ibi: number; ibiNext: number; ibiMedian: number; midWave: number; nextAmp: number;
}

export function detectBeats(y: Float64Array, fs: number) {
  const amp = rollingMedian(y.map(Math.abs), Math.trunc(2 * fs), Math.trunc(fs / 2));
  const { peaks, prominences } = findPeaks(y, { distance: Math.trunc(0.33 * fs), prominence: 1e-9 });
  const pk: number[] = [], prom: number[] = [];
  peaks.forEach((p, i) => { if (prominences[i] >= 0.8 * amp[p]) { pk.push(p); prom.push(prominences[i]); } });
  return { pk, prom };
}

export function beatCorr(y: Float64Array, pk: number[], fs: number): number[] {
  const a = Math.trunc(0.3 * fs), b = Math.trunc(0.5 * fs), L = a + b;
  const segs: Float64Array[] = [], idx: number[] = [];
  pk.forEach((p, i) => {
    if (p - a >= 0 && p + b < y.length) {
      const s = y.slice(p - a, p + b);
      const m = mean(s), sd = std(s, 0) + 1e-9;
      segs.push(s.map((v) => (v - m) / sd)); idx.push(i);
    }
  });
  const corr = new Array(pk.length).fill(NaN);
  if (segs.length > 10) {
    const tmpl = new Float64Array(L);
    const col = new Float64Array(segs.length);
    for (let k = 0; k < L; k++) { for (let j = 0; j < segs.length; j++) col[j] = segs[j][k]; tmpl[k] = median(col); }
    let nt = 0;
    for (const v of tmpl) nt += v * v;
    const norm = Math.sqrt(nt) * Math.sqrt(L);
    segs.forEach((s, j) => { let d = 0; for (let k = 0; k < L; k++) d += s[k] * tmpl[k]; corr[idx[j]] = d / norm; });
  }
  return corr;
}

/** pandas rolling(WIN_MED, center, min_periods=4).median() on a list with NaN, then ffill/bfill. */
function medFill(v: number[]): number[] {
  const m = Array.from(rollingMedian(v, WIN_MED, 4));
  let last = NaN;
  for (let i = 0; i < m.length; i++) if (Number.isNaN(m[i])) m[i] = last; else last = m[i];
  last = NaN;
  for (let i = m.length - 1; i >= 0; i--) if (Number.isNaN(m[i])) m[i] = last; else last = m[i];
  return m;
}

export function analyse(tMs: Float64Array, y: Float64Array, fs: number, moving: Uint8Array) {
  const { pk, prom } = detectBeats(y, fs);
  const corr = beatCorr(y, pk, fs);
  const n = pk.length;
  const b: Beats = {
    t: pk.map((p) => tMs[p]), amp: prom, corr, moving: pk.map((p) => !!moving[p]),
    ibi: [], clean: [], ibiMed: [], flag: new Array(n).fill(""),
  };
  b.ibi = b.t.map((t, i) => (i ? t - b.t[i - 1] : NaN));
  const good = b.moving.map((m, i) => !m && b.corr[i] >= MIN_CORR);
  b.clean = good.map((g, i) => g && i > 0 && good[i - 1] && b.ibi[i] >= 300 && b.ibi[i] <= 2500);
  const m = medFill(b.ibi.map((v, i) => (b.clean[i] ? v : NaN)));
  b.ibiMed = m;
  const ampMed = medFill(b.amp.map((v, i) => (b.clean[i] ? v : NaN)));
  const events: PpgEvent[] = [];
  for (let i = 2; i < n - 2; i++) {
    let mv = false;
    for (let k = Math.max(0, i - 4); k < Math.min(n, i + 4); k++) if (b.moving[k]) { mv = true; break; }
    if (mv || !Number.isFinite(m[i])) continue;
    const r = b.ibi[i] / m[i], rNext = b.ibi[i + 1] / m[i];
    let kind: string;
    if (r < 0.8 && rNext > 1.1 && r + rNext >= 1.75 && r + rNext <= 2.3 && b.clean[i - 1]) kind = "premature";
    else if (r >= 1.75 && r <= 2.3 && b.ibi[i - 1] / m[i] >= 0.85 && b.ibi[i - 1] / m[i] <= 1.15 &&
      b.ibi[i + 1] / m[i] >= 0.85 && b.ibi[i + 1] / m[i] <= 1.15) kind = "missed pulse";
    else continue;
    const a0 = searchsorted(tMs, b.t[i - 1] + 250), b0 = searchsorted(tMs, b.t[i] - 250);
    let mid = NaN;
    if (b0 > a0) {
      let lo = Infinity, hi = -Infinity;
      for (let k = a0; k < b0; k++) { if (y[k] < lo) lo = y[k]; if (y[k] > hi) hi = y[k]; }
      mid = (hi - lo) / (2 * ampMed[i]);
    }
    const post = b.amp[i + (kind === "premature" ? 1 : 0)] / ampMed[i];
    b.flag[i] = kind;
    events.push({ t: b.t[i], kind, ibi: b.ibi[i], ibiNext: b.ibi[i + 1], ibiMedian: m[i],
      midWave: round2(mid), nextAmp: round2(post) });
  }
  return { beats: b, events };
}

const round2 = (v: number) => Math.round(v * 100) / 100;

export function hrv(b: Beats) {
  const n = b.t.length;
  const nn: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!b.clean[i] || b.flag[i] !== "") continue;
    const near = (i > 0 && b.flag[i - 1] !== "") || (i + 1 < n && b.flag[i + 1] !== "");
    if (near) continue;
    if (Math.abs(b.ibi[i] / b.ibiMed[i] - 1) > 0.2) continue;
    nn.push(i);
  }
  const ibis = nn.map((i) => b.ibi[i]);
  // differences only between consecutive NN entries whose predecessor in the NN list was clean
  const d: number[] = [];
  for (let k = 1; k < nn.length; k++) if (b.clean[nn[k - 1]]) d.push(b.ibi[nn[k]] - b.ibi[nn[k - 1]]);
  const sdnn = std(ibis, 1);
  const rmssd = d.length ? Math.sqrt(d.reduce((s, v) => s + v * v, 0) / d.length) : NaN;
  return { nn, ibis, sdnn, rmssd };
}

export function feltMarkers(session: string): number[] {
  return readEvents(session).filter((e) => e.event === "felt").map((e) => e.t).sort((a, b) => a - b);
}

export function checkFelt(markers: number[], b: Beats, events: PpgEvent[], beforeS = 8.0, afterS = 1.0) {
  const cleanIbi = b.ibi.filter((_, i) => b.clean[i]);
  return markers.map((mk) => {
    let ref = b.ibi.filter((_, i) => b.t[i] > mk - 60000 && b.t[i] < mk - beforeS * 1000 && b.clean[i]);
    if (ref.length < 10) ref = cleanIbi;
    const med = median(ref);
    const win = b.t.map((t, i) => i).filter((i) => b.t[i] > mk - beforeS * 1000 && b.t[i] <= mk + afterS * 1000);
    const r = win.map((i) => b.ibi[i] / med);
    let found = "", dt = NaN;
    for (let i = 0; i < r.length; i++) {
      const nxt = i + 1 < r.length ? r[i + 1] : NaN;
      if (r[i] < 0.8 && nxt > 1.1 && r[i] + nxt >= 1.75 && r[i] + nxt <= 2.3) found = "premature";
      else if (r[i] >= 1.75 && r[i] <= 2.3) found = "missed pulse";
      else if (r[i] > 1.3 || r[i] < 0.75) found = "irregular";
      if (found) { dt = (b.t[win[i]] - mk) / 1000; break; }
    }
    const auto = events.filter((e) => e.t > mk - beforeS * 1000 && e.t <= mk + afterS * 1000);
    return { t: mk, pattern: found || "none", secondsBefore: dt, auto: auto.length > 0, median: med, beats: win.length };
  });
}

function main() {
  const args = process.argv.slice(2);
  const session = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--channel");
  if (!session) { console.error("Usage: tsx src/ppg.ts <session> [--channel N]"); process.exit(2); }
  const chArg = argValue(args, "--channel");

  const { t, ch } = loadPpg(session);
  const diffs = new Float64Array(t.length - 1);
  for (let i = 1; i < t.length; i++) diffs[i - 1] = t[i] - t[i - 1];
  const fs = 1000 / median(diffs);
  const moving = motionMask(session, t);
  const still = moving.map((m) => (m ? 0 : 1));
  const [c] = chArg !== undefined ? [Number(chArg), NaN] : pickChannel(ch, fs, still);
  if (c === null) { console.error("No channel with a recognisable pulse wave."); process.exit(1); }
  const y = bandpass(ch[c], fs);
  const { beats, events } = analyse(t, y, fs, moving);
  const { ibis, sdnn, rmssd } = hrv(beats);

  const hours = (t[t.length - 1] - t[0]) / 3.6e6;
  const cleanH = beats.ibi.reduce((s, v, i) => s + (beats.clean[i] && !Number.isNaN(v) ? v : 0), 0) / 3.6e6;
  const lines = [
    `PPG: channel v${c}, ${f(fs)} Hz, ${f(hours * 60, 1)} min recording, of which ${f((cleanH / hours) * 100)} % clean beat sequence`,
    ibis.length ? `Beats: ${beats.t.length}, heart rate from intervals ${f(60000 / mean(ibis), 1)} bpm` : "Beats: too few",
    `HRV (clean NN intervals only): SDNN ${f(sdnn)} ms, RMSSD ${f(rmssd)} ms`,
  ];
  if (existsSync(join(session, "hr.csv"))) {
    const hr = readNumericCsv(join(session, "hr.csv"), ["bpm", "accuracy"]);
    const ok = Array.from(hr.bpm).filter((v, i) => v > 30 && hr.accuracy[i] >= 2);
    if (ok.length && ibis.length) lines.push(`Watch heart-rate sensor in the same period: ${f(mean(ok), 1)} bpm`);
  }
  if (!events.length) lines.push("Ectopic beat candidates: none");
  else {
    const counts = new Map<string, number>();
    for (const e of events) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    lines.push(`Ectopic beat candidates: ${events.length} (${f(events.length / Math.max(cleanH, 1e-9))} per clean hour) – `
      + byCount.map(([k, v]) => `${k} ${v}`).join(", "));
    for (const e of events) {
      lines.push(`  ${hms(e.t)} ${e.kind}: ${f(e.ibi)} → ${f(e.ibiNext)} ms (median ${f(e.ibiMedian)}), `
        + `mid wave ${pyNum(e.midWave)}, next beat ×${pyNum(e.nextAmp)}`);
    }
    lines.push("Note: candidates, not a diagnosis. 'missed pulse' can also be a missed beat.");
  }

  const markers = feltMarkers(session);
  const felt = markers.length ? checkFelt(markers, beats, events) : [];
  if (felt.length) {
    const hit = felt.filter((x) => x.pattern === "premature" || x.pattern === "missed pulse").length;
    const irr = felt.filter((x) => x.pattern === "irregular").length;
    const minutes = beats.t.length ? (beats.t[beats.t.length - 1] - beats.t[0]) / 60000 : 0;
    const chance = minutes ? 1 - Math.exp(((-events.length / Math.max(minutes, 1e-9)) * 9) / 60) : NaN;
    lines.push(`Felt: ${felt.length}× – of which ${hit} with an ectopic pattern in the 8 s before, `
      + `${irr} only irregular, ${felt.length - hit - irr} unremarkable `
      + `(chance of a random hit per window ≈ ${f(chance * 100)} %)`);
    for (const x of felt) lines.push(`  ${hms(x.t)}: ${x.pattern}` + (Number.isFinite(x.secondsBefore) ? ` (${f(-x.secondsBefore, 1)} s before)` : ""));
    const autoHit = events.filter((e) => markers.some((mk) => mk > e.t - 1000 && mk < e.t + 8000)).length;
    lines.push(`Automatic candidates without a felt marker in the 8 s after: ${events.length - autoHit}`);
    writeCsv(join(session, "ppg_felt.csv"),
      ["epoch_ms", "pattern", "seconds_before_marker", "auto_candidate", "median_ibi_ms", "beats_in_window"],
      felt.map((x) => [x.t, x.pattern, x.secondsBefore, x.auto, x.median, x.beats]));
  }

  const text = lines.join("\n");
  console.log(text);
  writeFileSync(join(session, "ppg_summary.txt"), text + "\n", "utf8");
  writeCsv(join(session, "ppg_beats.csv"), ["epoch_ms", "amp", "corr", "moving", "ibi_ms", "clean", "ibi_med", "flag"],
    beats.t.map((tt, i) => [tt, beats.amp[i], beats.corr[i], beats.moving[i], beats.ibi[i], beats.clean[i], beats.ibiMed[i], beats.flag[i]]));
  writeCsv(join(session, "ppg_events.csv"),
    ["epoch_ms", "kind", "ibi_ms", "ibi_next_ms", "ibi_median_ms", "mid_wave_rel", "next_beat_amp_rel"],
    events.map((e) => [e.t, e.kind, e.ibi, e.ibiNext, e.ibiMedian, e.midWave, e.nextAmp]));
}

/** Number like Python's str(float) for rounded values: 0.5, 1.0, 0.17 */
const pyNum = (v: number) => (Number.isNaN(v) ? "nan" : Number.isInteger(v) ? v.toFixed(1) : String(v));

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("ppg.ts")) main();
