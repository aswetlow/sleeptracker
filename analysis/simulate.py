#!/usr/bin/env python3
"""
Erzeugt eine synthetische Nacht zum Testen von analyze.py:

    python simulate.py <ziel-ordner>

3 h, Atmung 15/min, ab 1,5 h 12/min (auf dem Accelerometer unter dem Rauschen,
auf dem Gyro knapp darüber). Drei Bewegungen, eine mit Lagewechsel. Von 2:00 bis 2:20
20 apnoe-artige Zyklen: 45 s keine Atmung, dann Weckreaktion mit Pulsspitze und Zucken.
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

FS, DUR = 25, 3 * 3600
APNEA = (7200, 8400, 60)  # Start, Ende, Zykluslänge in s


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    n = DUR * FS
    ts = np.arange(n) / FS
    t0 = 1761850000000
    epoch = t0 + (ts * 1000).astype(np.int64) + rng.integers(-3, 3, n)

    rate = np.where(ts < 5400, 15, 12) / 60
    breath = np.sin(2 * np.pi * np.cumsum(rate) / FS)
    in_apnea = (ts >= APNEA[0]) & (ts < APNEA[1]) & (((ts - APNEA[0]) % APNEA[2]) < 45)
    breath[in_apnea] = 0

    g = np.tile([0.0, 0.0, 9.81], (n, 1))
    g[ts >= 3004] = [0.0, 9.81, 0.0]
    acc = g + rng.normal(0, 0.01, (n, 3))
    acc[:, 0] += 0.004 * breath
    gyro = rng.normal(0, 0.002, (n, 3))
    gyro[:, 1] += 0.004 * breath

    def burst(s, dur, amp):
        i = slice(int(s * FS), int((s + dur) * FS))
        acc[i] += rng.normal(0, amp, (i.stop - i.start, 3))
        gyro[i] += rng.normal(0, amp / 5, (i.stop - i.start, 3))

    for s in (600, 1800, 3000):
        burst(s, 4, 1.5)

    hr_t = np.arange(DUR)
    bpm = 55 + rng.normal(0, 0.8, DUR)
    for s in (600, 1800, 3000):
        bpm[s:s + 20] += 12
    for c in range(APNEA[0], APNEA[1], APNEA[2]):
        bpm[c:c + 45] -= np.linspace(0, 3, 45)
        bpm[c + 45:c + 50] += np.linspace(3, 15, 5)
        bpm[c + 50:c + 60] += np.linspace(15, 0, 10)
        burst(c + 45, 2, 0.3)
    bpm = pd.Series(bpm).rolling(5, min_periods=1).mean().values  # Uhr glättet ihre BPM

    pd.DataFrame({"epoch_ms": epoch, "x": acc[:, 0], "y": acc[:, 1], "z": acc[:, 2]}) \
        .to_csv(out / "accel.csv", index=False)
    pd.DataFrame({"epoch_ms": epoch, "x": gyro[:, 0], "y": gyro[:, 1], "z": gyro[:, 2]}) \
        .to_csv(out / "gyro.csv", index=False)
    pd.DataFrame({"epoch_ms": t0 + hr_t * 1000, "bpm": bpm, "accuracy": 3}) \
        .to_csv(out / "hr.csv", index=False)
    print(f"Synthetische Nacht in {out}")


if __name__ == "__main__":
    main(Path(sys.argv[1]))
