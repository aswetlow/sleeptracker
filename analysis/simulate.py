#!/usr/bin/env python3
"""
Erzeugt eine synthetische Nacht zum Testen von analyze.py:

    python simulate.py <ziel-ordner> [--audio]

3 h, Atmung 15/min, ab 1,5 h 12/min (auf dem Accelerometer unter dem Rauschen,
auf dem Gyro knapp darüber). Drei Bewegungen, eine mit Lagewechsel. Von 2:00 bis 2:20
20 apnoe-artige Zyklen: 45 s keine Atmung, dann Weckreaktion mit Pulsspitze und Zucken.
Bei 30 s ein Klatschen mit der Uhrhand.

--audio schreibt zusätzlich eine passende Handy-Aufnahme (WAV, 8 kHz): hörbares Atmen,
Schnarchen 0:20–0:40, Japsen am Ende jeder Apnoe, ab 2:30 so leises Atmen, dass es
im Rauschen verschwindet. Die Aufnahme startet 20 s vor der Uhr, der Dateiname liegt
absichtlich 7 s daneben, damit die Klatsch-Synchronisation etwas zu tun hat.
"""
import sys
import wave
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

FS, DUR = 25, 3 * 3600
APNEA = (7200, 8400, 60)  # Start, Ende, Zykluslänge in s
CLAP_S = 30
T0 = 1761850000000


def breath_phase(ts):
    """Atemphase (in Zyklen) für 15/min bis 1,5 h, danach 12/min."""
    return 0.25 * np.minimum(ts, 5400) + 0.2 * np.maximum(ts - 5400, 0)


def apnea_mask(ts):
    return (ts >= APNEA[0]) & (ts < APNEA[1]) & (((ts - APNEA[0]) % APNEA[2]) < 45)


def main(out: Path):
    out.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(1)
    n = DUR * FS
    ts = np.arange(n) / FS
    t0 = T0
    epoch = t0 + (ts * 1000).astype(np.int64) + rng.integers(-3, 3, n)

    breath = np.sin(2 * np.pi * breath_phase(ts))
    breath[apnea_mask(ts)] = 0

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
    acc[CLAP_S * FS:CLAP_S * FS + 2] += [15.0, -10.0, 8.0]

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


def write_audio(out: Path, sr=8000, lead_s=20, name_error_s=7):
    from scipy import signal
    rng = np.random.default_rng(3)
    start_ms = T0 - lead_s * 1000
    stamp = datetime.fromtimestamp((start_ms / 1000) + name_error_s, ZoneInfo("Europe/Berlin"))
    path = out / f"Aufnahme {stamp:%Y-%m-%d %H.%M.%S}.wav"
    sos = signal.butter(4, (400, 1500), btype="band", fs=sr, output="sos")
    zi = signal.sosfilt_zi(sos) * 0
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr)
        for c in range(0, DUR + lead_s, 60):
            ts = c - lead_s + np.arange(60 * sr) / sr      # Zeit relativ zum Uhr-Start
            ph = breath_phase(np.maximum(ts, 0)) % 1
            inhale = ph < 0.4
            env = np.where(inhale, np.sin(np.pi * ph / 0.4), 0.5 * np.sin(np.pi * (ph - 0.4) / 0.6))
            env[apnea_mask(ts)] = 0
            amp = np.where(ts >= 9000, 0.0012, 0.012)     # ab 2:30 leise
            noise, zi = signal.sosfilt(sos, rng.normal(0, 1, len(ts)), zi=zi)
            x = rng.normal(0, 0.001, len(ts)) + amp * env * noise
            snore = (ts >= 1200) & (ts < 2400) & inhale
            x += snore * env * 0.05 * signal.sawtooth(2 * np.pi * 90 * ts)
            for a in range(APNEA[0], APNEA[1], APNEA[2]):  # Japsen
                g = (ts >= a + 45) & (ts < a + 46.5)
                x[g] += rng.normal(0, 0.1, g.sum())
            clap = (ts >= CLAP_S) & (ts < CLAP_S + 0.02)
            x[clap] += rng.choice([-0.8, 0.8], clap.sum())
            w.writeframes((np.clip(x, -1, 1) * 32767).astype("<i2").tobytes())
    print(f"Audio: {path}")


if __name__ == "__main__":
    target = Path(sys.argv[1])
    main(target)
    if "--audio" in sys.argv:
        write_audio(target)
