import assert from "node:assert/strict";
import { test } from "node:test";
import { butterBandpass, findPeaks, sosfiltfilt } from "../src/lib/dsp.ts";
import { f } from "../src/lib/io.ts";
import { rollingMedian } from "../src/lib/stats.ts";

// Referenzwerte aus scipy 1.16 / pandas 3.0
const close = (a: number, b: number, tol = 1e-9) => assert.ok(Math.abs(a - b) < tol, `${a} != ${b}`);

/** |H(e^jw)| eines SOS-Filters */
function gain(sos: number[][], fHz: number, fs: number) {
  const w = (2 * Math.PI * fHz) / fs;
  let g = 1;
  for (const [b0, b1, b2, a0, a1, a2] of sos) {
    const re = (c0: number, c1: number, c2: number) => [c0 + c1 * Math.cos(w) + c2 * Math.cos(2 * w), -(c1 * Math.sin(w) + c2 * Math.sin(2 * w))];
    const [nr, ni] = re(b0, b1, b2), [dr, di] = re(a0, a1, a2);
    g *= Math.hypot(nr, ni) / Math.hypot(dr, di);
  }
  return g;
}

test("Butterworth-Bandpass hat -3 dB an den Eckfrequenzen und 1 in der Mitte", () => {
  const sos = butterBandpass(3, 0.6, 3.5, 100);
  close(gain(sos, 0.6, 100), Math.SQRT1_2, 1e-9);
  close(gain(sos, 3.5, 100), Math.SQRT1_2, 1e-9);
  close(gain(sos, Math.sqrt(0.6 * 3.5) * 1.0, 100), 1, 1e-2);
});

test("sosfiltfilt wie scipy", () => {
  const sos = butterBandpass(2, 0.1, 0.5, 25);
  const x = Array.from({ length: 200 }, (_, i) => Math.sin(i / 3) + i * 0.01);
  const y = sosfiltfilt(sos, x);
  [[0, -0.42914519083902586], [50, -0.05216472140477607], [100, -0.01884194299395775], [199, 0.13075379074669857]]
    .forEach(([i, v]) => close(y[i], v, 1e-10));
});

test("find_peaks mit Plateau, distance und prominence wie scipy", () => {
  const { peaks, prominences } = findPeaks([0, 1, 3, 1, 0, 2, 2, 2, 0, 5, 1, 0, 1, 0], { distance: 2, prominence: 0.5 });
  assert.deepEqual(peaks, [2, 6, 9, 12]);
  assert.deepEqual(Array.from(prominences), [3, 2, 5, 1]);
});

test("rolling median zentriert wie pandas (gerades Fenster)", () => {
  const m = rollingMedian(Array.from({ length: 20 }, (_, i) => i), 4, 1);
  assert.deepEqual(Array.from(m.slice(0, 6)), [0.5, 1, 1.5, 2.5, 3.5, 4.5]);
});

test("Rundung wie Python-Format", () => {
  assert.equal(f(2.25, 1), "2.2");
  assert.equal(f(0.5), "0");
  assert.equal(f(1.5), "2");
  assert.equal(f(59.85, 1), "59.9");
});
