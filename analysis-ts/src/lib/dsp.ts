/**
 * Signalverarbeitung ohne Abhängigkeiten, nachgebaut nach scipy.signal:
 * butter (Bandpass, SOS), sosfilt, sosfiltfilt, find_peaks (distance/prominence/wlen),
 * peak_prominences, Welch-Leistung für einzelne Frequenzen, Autokorrelation.
 * Ziel: dieselben Zahlen wie die Python-Skripte (bis auf Rundung im Bereich 1e-9).
 */

export type Sos = number[][]; // je Abschnitt [b0, b1, b2, a0, a1, a2]

type C = { re: number; im: number };
const c = (re: number, im = 0): C => ({ re, im });
const add = (a: C, b: C): C => c(a.re + b.re, a.im + b.im);
const sub = (a: C, b: C): C => c(a.re - b.re, a.im - b.im);
const mul = (a: C, b: C): C => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: C, b: C): C => {
  const d = b.re * b.re + b.im * b.im;
  return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d);
};
const csqrt = (a: C): C => {
  const r = Math.hypot(a.re, a.im);
  const re = Math.sqrt((r + a.re) / 2);
  const im = Math.sign(a.im || 1) * Math.sqrt(Math.max(0, (r - a.re) / 2));
  return c(re, a.im === 0 && a.re >= 0 ? 0 : im);
};

/** Butterworth-Bandpass der Ordnung n (wie scipy.signal.butter(n, (lo, hi), "band", fs=fs, output="sos")). */
export function butterBandpass(n: number, lo: number, hi: number, fs: number): Sos {
  // analoger Tiefpass-Prototyp
  const proto: C[] = [];
  for (let m = -n + 1; m < n; m += 2) {
    const ang = (Math.PI * m) / (2 * n);
    proto.push(c(-Math.cos(ang), -Math.sin(ang)));
  }
  // Vorverzerrung (bilinear, fs_norm = 2)
  const w1 = 4 * Math.tan((Math.PI * (2 * lo) / fs) / 2);
  const w2 = 4 * Math.tan((Math.PI * (2 * hi) / fs) / 2);
  const bw = w2 - w1;
  const wo = Math.sqrt(w1 * w2);
  // Tiefpass -> Bandpass
  const poles: C[] = [];
  for (const p of proto) {
    const pl = mul(p, c(bw / 2));
    const r = csqrt(sub(mul(pl, pl), c(wo * wo)));
    poles.push(add(pl, r), sub(pl, r));
  }
  let k = Math.pow(bw, n);
  // bilinear: s -> z, fs2 = 4
  const fs2 = 4;
  const zp = poles.map((p) => div(add(c(fs2), p), sub(c(fs2), p)));
  // Nullstellen: n bei s = 0 (z = +1) und n bei z = -1
  let num = c(1), den = c(1);
  for (let i = 0; i < n; i++) num = mul(num, c(fs2)); // prod(fs2 - 0)
  for (const p of poles) den = mul(den, sub(c(fs2), p));
  k = k * div(num, den).re;
  return polesToSos(zp, k, n);
}

/** Pole paaren (konjugiert komplex bzw. zwei reelle) und je Abschnitt eine Nullstelle bei +1 und -1. */
function polesToSos(zp: C[], k: number, n: number): Sos {
  const eps = 1e-10;
  const cplx = zp.filter((p) => p.im > eps);
  const real = zp.filter((p) => Math.abs(p.im) <= eps).map((p) => p.re).sort((a, b) => a - b);
  const den: number[][] = [];
  for (const p of cplx) den.push([1, -2 * p.re, p.re * p.re + p.im * p.im]);
  for (let i = 0; i < real.length; i += 2) {
    const a = real[i], b = real[i + 1] ?? 0;
    den.push(i + 1 < real.length ? [1, -(a + b), a * b] : [1, -a, 0]);
  }
  // nach Polbetrag sortieren (wie scipy: Pole nahe dem Einheitskreis zuletzt)
  den.sort((x, y) => x[2] - y[2]);
  if (den.length !== n) throw new Error("unerwartete Polzahl");
  return den.map((a, i) => [i === 0 ? k : 1, 0, i === 0 ? -k : -1, ...a]);
}

/** Butterworth-Tiefpass/Hochpass brauchen die Skripte nicht. */

/** Anfangszustand für Sprungantwort-Gleichgewicht (scipy.signal.sosfilt_zi). */
export function sosfiltZi(sos: Sos): number[][] {
  let scale = 1;
  return sos.map(([b0, b1, b2, , a1, a2]) => {
    // lfilter_zi für Abschnitt 2. Ordnung: (I - A^T) zi = B
    const B0 = b1 - a1 * b0, B1 = b2 - a2 * b0;
    // [[1 + a1, -1], [a2, 1]] · zi = B
    const det = (1 + a1) * 1 - (-1) * a2;
    const z0 = (B0 * 1 - -1 * B1) / det;
    const z1 = ((1 + a1) * B1 - a2 * B0) / det;
    const zi = [scale * z0, scale * z1];
    scale *= (b0 + b1 + b2) / (1 + a1 + a2);
    return zi;
  });
}

/** Kausaler Filter (Direktform II transponiert), optional mit Anfangszustand. */
export function sosfilt(sos: Sos, x: ArrayLike<number>, zi?: number[][]): Float64Array {
  const y = Float64Array.from(x as ArrayLike<number>);
  for (let s = 0; s < sos.length; s++) {
    const [b0, b1, b2, , a1, a2] = sos[s];
    let z0 = zi ? zi[s][0] : 0, z1 = zi ? zi[s][1] : 0;
    for (let i = 0; i < y.length; i++) {
      const xi = y[i];
      const yi = b0 * xi + z0;
      z0 = b1 * xi - a1 * yi + z1;
      z1 = b2 * xi - a2 * yi;
      y[i] = yi;
    }
  }
  return y;
}

/** Nullphasig vor/zurück (scipy.signal.sosfiltfilt, padtype "odd"). */
export function sosfiltfilt(sos: Sos, x: ArrayLike<number>): Float64Array {
  const n = x.length;
  let pad = 3 * (2 * sos.length + 1);
  pad = Math.min(pad, n - 1);
  if (n <= pad || n < 2) throw new Error(`Signal zu kurz für sosfiltfilt (${n} Werte)`);
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) ext[i] = 2 * x[0] - x[pad - i];
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  for (let i = 0; i < pad; i++) ext[pad + n + i] = 2 * x[n - 1] - x[n - 2 - i];
  const zi = sosfiltZi(sos);
  let y = sosfilt(sos, ext, zi.map((z) => z.map((v) => v * ext[0])));
  y.reverse();
  const y0 = y[0];
  y = sosfilt(sos, y, zi.map((z) => z.map((v) => v * y0)));
  y.reverse();
  return y.slice(pad, pad + n);
}

/** Lokale Maxima mit Plateau-Mitte (scipy _local_maxima_1d). */
export function localMaxima(x: ArrayLike<number>): number[] {
  const out: number[] = [];
  const n = x.length;
  let i = 1;
  while (i < n - 1) {
    if (x[i - 1] < x[i]) {
      let ahead = i + 1;
      while (ahead < n - 1 && x[ahead] === x[i]) ahead++;
      if (x[ahead] < x[i]) {
        out.push((i + ahead - 1) >> 1);
        i = ahead;
      }
    }
    i++;
  }
  return out;
}

/** Prominenz je Peak (scipy.signal.peak_prominences); wlen < 2 = ganzes Signal. */
export function peakProminences(x: ArrayLike<number>, peaks: number[], wlen = -1): Float64Array {
  const n = x.length;
  const w = wlen > 1 ? Math.ceil(wlen) : -1;
  const out = new Float64Array(peaks.length);
  for (let j = 0; j < peaks.length; j++) {
    const p = peaks[j];
    let iMin = 0, iMax = n - 1;
    if (w >= 2) {
      iMin = Math.max(p - (w >> 1), iMin);
      iMax = Math.min(p + (w >> 1), iMax);
    }
    let i = p, leftMin = x[p];
    while (iMin <= i && x[i] <= x[p]) {
      if (x[i] < leftMin) leftMin = x[i];
      i--;
    }
    i = p;
    let rightMin = x[p];
    while (i <= iMax && x[i] <= x[p]) {
      if (x[i] < rightMin) rightMin = x[i];
      i++;
    }
    out[j] = x[p] - Math.max(leftMin, rightMin);
  }
  return out;
}

export interface PeakOpts { distance?: number; prominence?: number; wlen?: number }

/** scipy.signal.find_peaks mit distance, prominence (Untergrenze) und wlen. */
export function findPeaks(x: ArrayLike<number>, opts: PeakOpts = {}): { peaks: number[]; prominences: Float64Array } {
  let peaks = localMaxima(x);
  if (opts.distance !== undefined && opts.distance > 1 && peaks.length > 1) {
    const d = opts.distance;
    const keep = new Uint8Array(peaks.length).fill(1);
    // Gleichstand: der frühere Peak gewinnt (so verhält sich numpy in der Praxis meist; argsort ist dort nicht stabil)
    const order = peaks.map((_, i) => i).sort((a, b) => x[peaks[a]] - x[peaks[b]] || b - a);
    for (let o = order.length - 1; o >= 0; o--) {
      const j = order[o];
      if (!keep[j]) continue;
      for (let k = j - 1; k >= 0 && peaks[j] - peaks[k] < d; k--) keep[k] = 0;
      for (let k = j + 1; k < peaks.length && peaks[k] - peaks[j] < d; k++) keep[k] = 0;
    }
    peaks = peaks.filter((_, i) => keep[i]);
  }
  let prominences = new Float64Array(0);
  if (opts.prominence !== undefined) {
    const prom = peakProminences(x, peaks, opts.wlen ?? -1);
    const idx = peaks.map((_, i) => i).filter((i) => prom[i] >= opts.prominence!);
    peaks = idx.map((i) => peaks[i]);
    prominences = Float64Array.from(idx.map((i) => prom[i]));
  }
  return { peaks, prominences };
}

/** Autokorrelation (np.correlate(z, z, "full")[n-1:] / n) für Verschiebungen 0 … maxLag. */
export function autocorr(z: ArrayLike<number>, maxLag: number): Float64Array {
  const n = z.length;
  const out = new Float64Array(Math.min(maxLag, n - 1) + 1);
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    for (let i = 0; i + k < n; i++) s += z[i] * z[i + k];
    out[k] = s / n;
  }
  return out;
}

/**
 * Welch-Leistungsdichte (Hann, 50 % Überlappung, Mittelwert je Segment abgezogen) nur für die
 * Frequenz-Bins kLo … kHi. Absolute Skalierung weggelassen, Verhältnisse stimmen mit scipy überein.
 */
export function welchBins(y: ArrayLike<number>, nperseg: number, kLo: number, kHi: number): Float64Array {
  const step = nperseg >> 1;
  const win = new Float64Array(nperseg);
  for (let i = 0; i < nperseg; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / nperseg);
  const nb = kHi - kLo + 1;
  const cosT: Float64Array[] = [], sinT: Float64Array[] = [];
  for (let b = 0; b < nb; b++) {
    const k = kLo + b;
    const cs = new Float64Array(nperseg), sn = new Float64Array(nperseg);
    for (let i = 0; i < nperseg; i++) {
      cs[i] = Math.cos((2 * Math.PI * k * i) / nperseg) * win[i];
      sn[i] = Math.sin((2 * Math.PI * k * i) / nperseg) * win[i];
    }
    cosT.push(cs); sinT.push(sn);
  }
  const acc = new Float64Array(nb);
  let segs = 0;
  const seg = new Float64Array(nperseg);
  for (let s = 0; s + nperseg <= y.length; s += step) {
    let mean = 0;
    for (let i = 0; i < nperseg; i++) mean += y[s + i];
    mean /= nperseg;
    for (let i = 0; i < nperseg; i++) seg[i] = y[s + i] - mean;
    for (let b = 0; b < nb; b++) {
      let re = 0, im = 0;
      const cs = cosT[b], sn = sinT[b];
      for (let i = 0; i < nperseg; i++) { re += seg[i] * cs[i]; im += seg[i] * sn[i]; }
      acc[b] += re * re + im * im;
    }
    segs++;
  }
  if (segs) for (let b = 0; b < nb; b++) acc[b] /= segs;
  return acc;
}

/** Eigenvektor zum größten Eigenwert einer symmetrischen 3×3-Matrix (Jacobi-Verfahren). */
export function topEigenvector3(m: number[][]): number[] {
  const a = m.map((r) => r.slice());
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = a[0][1] ** 2 + a[0][2] ** 2 + a[1][2] ** 2;
    if (off < 1e-30) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue;
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const cs = 1 / Math.sqrt(t * t + 1), sn = t * cs;
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q];
        a[k][p] = cs * akp - sn * akq; a[k][q] = sn * akp + cs * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k];
        a[p][k] = cs * apk - sn * aqk; a[q][k] = sn * apk + cs * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q];
        v[k][p] = cs * vkp - sn * vkq; v[k][q] = sn * vkp + cs * vkq;
      }
    }
  }
  let best = 0;
  for (let i = 1; i < 3; i++) if (a[i][i] > a[best][best]) best = i;
  return [v[0][best], v[1][best], v[2][best]];
}

/** Hauptkomponente mehrerer gleich langer Spalten (Kovarianz mit ddof=1, wie np.cov). */
export function principalComponent(cols: Float64Array[]): Float64Array {
  const n = cols[0].length, d = cols.length;
  const cen = cols.map((col) => {
    let m = 0;
    for (let i = 0; i < n; i++) m += col[i];
    m /= n;
    return col.map((v) => v - m);
  });
  const cov: number[][] = [];
  for (let i = 0; i < d; i++) {
    cov.push([]);
    for (let j = 0; j < d; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += cen[i][k] * cen[j][k];
      cov[i].push(s / (n - 1));
    }
  }
  if (d !== 3) throw new Error("principalComponent erwartet 3 Achsen");
  const vec = topEigenvector3(cov);
  const out = new Float64Array(n);
  for (let k = 0; k < n; k++) out[k] = cen[0][k] * vec[0] + cen[1][k] * vec[1] + cen[2][k] * vec[2];
  return out;
}
