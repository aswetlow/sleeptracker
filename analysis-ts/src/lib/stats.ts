/** Small statistics helpers with pandas semantics (NaN is skipped). */

export function finite(a: ArrayLike<number>): number[] {
  const o: number[] = [];
  for (let i = 0; i < a.length; i++) if (Number.isFinite(a[i])) o.push(a[i]);
  return o;
}

export function mean(a: ArrayLike<number>): number {
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) { s += a[i]; n++; }
  return n ? s / n : NaN;
}

/** Standard deviation, ddof like pandas (1) or numpy (0). */
export function std(a: ArrayLike<number>, ddof = 1): number {
  const m = mean(a);
  let s = 0, n = 0;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) { s += (a[i] - m) ** 2; n++; }
  return n - ddof > 0 ? Math.sqrt(s / (n - ddof)) : NaN;
}

export function median(a: ArrayLike<number>): number {
  const v = Float64Array.from(finite(a)).sort();
  if (!v.length) return NaN;
  const h = v.length >> 1;
  return v.length % 2 ? v[h] : (v[h - 1] + v[h]) / 2;
}

export const min = (a: ArrayLike<number>) => { const v = finite(a); return v.length ? Math.min(...v) : NaN; };
export const max = (a: ArrayLike<number>) => {
  let m = -Infinity, any = false;
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i])) { any = true; if (a[i] > m) m = a[i]; }
  return any ? m : NaN;
};

export function corr(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const x: number[] = [], y: number[] = [];
  for (let i = 0; i < a.length; i++) if (!Number.isNaN(a[i]) && !Number.isNaN(b[i])) { x.push(a[i]); y.push(b[i]); }
  const mx = mean(x), my = mean(y);
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < x.length; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2; }
  return sxy / Math.sqrt(sxx * syy);
}

/** Bounds of a centred window like pandas rolling(w, center=True). */
function bounds(i: number, w: number, n: number): [number, number] {
  const off = (w - 1) >> 1;
  const end = Math.min(n, i + off + 1);
  const start = Math.max(0, i + off + 1 - w);
  return [start, end];
}

/** pandas rolling(w, center=True, min_periods).median() – sorted window, O(n·w) shifts. */
export function rollingMedian(a: ArrayLike<number>, w: number, minPeriods: number, center = true): Float64Array {
  const n = a.length, out = new Float64Array(n).fill(NaN);
  const win = new Float64Array(w + 2);
  let cnt = 0, lo = 0, hi = 0; // current window [lo, hi)
  const insert = (v: number) => {
    if (Number.isNaN(v)) return;
    let l = 0, r = cnt;
    while (l < r) { const m = (l + r) >> 1; if (win[m] < v) l = m + 1; else r = m; }
    win.copyWithin(l + 1, l, cnt); win[l] = v; cnt++;
  };
  const remove = (v: number) => {
    if (Number.isNaN(v)) return;
    let l = 0, r = cnt;
    while (l < r) { const m = (l + r) >> 1; if (win[m] < v) l = m + 1; else r = m; }
    win.copyWithin(l, l + 1, cnt); cnt--;
  };
  for (let i = 0; i < n; i++) {
    const [s, e] = center ? bounds(i, w, n) : [Math.max(0, i - w + 1), i + 1];
    while (hi < e) insert(a[hi++]);
    while (lo < s) remove(a[lo++]);
    if (cnt >= minPeriods && cnt > 0) {
      const h = cnt >> 1;
      out[i] = cnt % 2 ? win[h] : (win[h - 1] + win[h]) / 2;
    }
  }
  return out;
}

/** pandas rolling(w, center, min_periods).std() (ddof=1), computed directly per window. */
export function rollingStd(a: ArrayLike<number>, w: number, minPeriods: number, center = true): Float64Array {
  const n = a.length, out = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    const [s, e] = center ? bounds(i, w, n) : [Math.max(0, i - w + 1), i + 1];
    let sum = 0, k = 0;
    for (let j = s; j < e; j++) if (!Number.isNaN(a[j])) { sum += a[j]; k++; }
    if (k < minPeriods || k < 2) continue;
    const m = sum / k;
    let ss = 0;
    for (let j = s; j < e; j++) if (!Number.isNaN(a[j])) ss += (a[j] - m) ** 2;
    out[i] = Math.sqrt(ss / (k - 1));
  }
  return out;
}

/** np.interp (x ascending). */
export function interp(x: ArrayLike<number>, xp: ArrayLike<number>, fp: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  let j = 0;
  const n = xp.length;
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (v <= xp[0]) { out[i] = fp[0]; continue; }
    if (v >= xp[n - 1]) { out[i] = fp[n - 1]; continue; }
    if (v < xp[j]) j = 0;
    while (j < n - 2 && xp[j + 1] <= v) j++;
    // like numpy: for equal xp take the right value
    while (j < n - 2 && xp[j + 1] === xp[j + 2] && xp[j + 1] <= v) j++;
    const dx = xp[j + 1] - xp[j];
    out[i] = dx === 0 ? fp[j + 1] : fp[j] + ((v - xp[j]) * (fp[j + 1] - fp[j])) / dx;
  }
  return out;
}

/** First index with a[i] >= v (np.searchsorted side="left"). */
export function searchsorted(a: ArrayLike<number>, v: number, side: "left" | "right" = "left"): number {
  let l = 0, r = a.length;
  while (l < r) {
    const m = (l + r) >> 1;
    if (side === "left" ? a[m] < v : a[m] <= v) l = m + 1; else r = m;
  }
  return l;
}
