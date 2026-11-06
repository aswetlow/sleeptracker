/**
 * HRV from RR intervals (ECG or PPG). Intervals outside 300–2000 ms are artefacts. An interval that differs by more
 * than 20 % from the median of its neighbours (±5) is ectopic; a short one followed by a long one is counted as one
 * extrasystole. RMSSD only uses pairs of successive normal (NN) intervals, SDNN all NN intervals.
 * Standard short-term HRV wants ≥ 2 min; shorter measurements are flagged.
 */
import { median } from "./stats.ts";

export interface Hrv {
  n: number;              // all intervals
  nn: number;             // normal intervals used
  ectopic: number;        // extrasystoles (short-long pairs or single outliers)
  artefacts: number;      // outside 300–2000 ms
  durationS: number;      // sum of all intervals
  hr: number | null;      // from the mean NN interval
  rmssd: number | null;
  sdnn: number | null;
  pnn50: number | null;   // % of successive NN differences > 50 ms
  valid: boolean;         // ≥ 120 s and ≥ 80 % NN
  note: string;
}

export const HRV_MIN_S = 120;

export function hrv(rr: number[]): Hrv {
  const n = rr.length;
  const plaus = rr.map((v) => v >= 300 && v <= 2000);
  const normal = new Array<boolean>(n).fill(false);
  let ectopic = 0;
  for (let i = 0; i < n; i++) {
    if (!plaus[i]) continue;
    const nb: number[] = [];
    for (let k = Math.max(0, i - 5); k <= Math.min(n - 1, i + 5); k++) if (k !== i && plaus[k]) nb.push(rr[k]);
    if (nb.length < 3) continue;
    const m = median(nb);
    if (Math.abs(rr[i] - m) <= 0.2 * m) { normal[i] = true; continue; }
    // short interval (premature beat) followed by a long one (compensatory pause) = one extrasystole
    const prevAbnormalShort = i > 0 && plaus[i - 1] && !normal[i - 1] && rr[i - 1] < rr[i];
    if (!prevAbnormalShort) ectopic++;
  }
  const nnIdx = rr.map((_, i) => i).filter((i) => normal[i]);
  const nn = nnIdx.map((i) => rr[i]);
  const diffs: number[] = [];
  for (let i = 1; i < n; i++) if (normal[i] && normal[i - 1]) diffs.push(rr[i] - rr[i - 1]);
  const mNN = nn.length ? nn.reduce((a, b) => a + b, 0) / nn.length : NaN;
  const durationS = rr.reduce((a, b) => a + b, 0) / 1000;
  const r2 = (v: number) => Math.round(v * 10) / 10;
  const rmssd = diffs.length >= 10 ? r2(Math.sqrt(diffs.reduce((a, d) => a + d * d, 0) / diffs.length)) : null;
  const sdnn = nn.length >= 10 ? r2(Math.sqrt(nn.reduce((a, v) => a + (v - mNN) ** 2, 0) / (nn.length - 1))) : null;
  const pnn50 = diffs.length >= 10 ? r2((100 * diffs.filter((d) => Math.abs(d) > 50).length) / diffs.length) : null;
  const share = n ? nn.length / n : 0;
  const valid = durationS >= HRV_MIN_S && share >= 0.8 && rmssd !== null;
  const note = !n ? "no intervals"
    : durationS < HRV_MIN_S ? `only ${Math.round(durationS)} s – 2 min are standard, value is rough`
    : share < 0.8 ? `only ${Math.round(share * 100)} % normal intervals – too many artefacts/extrasystoles`
    : "ok";
  return {
    n, nn: nn.length, ectopic, artefacts: plaus.filter((p) => !p).length, durationS: r2(durationS),
    hr: Number.isFinite(mNN) ? r2(60000 / mNN) : null, rmssd, sdnn, pnn50, valid, note,
  };
}
