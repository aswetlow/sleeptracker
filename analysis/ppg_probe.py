"""
First look at the undocumented raw sensors (raw_ppg.csv, raw_hr_ext.csv, raw_ppg_ctrl.csv).

For each file: sample rate, number of values per event, statistics per channel, and whether a channel
looks like a pulse wave (PPG) or like beat intervals in ms (hr_ext). Plot of the first 20 s.

    python ppg_probe.py ../sessions/<session> [--plot]
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal


def load_raw(path: Path):
    df = pd.read_csv(path)
    if df.empty:
        return df, pd.DataFrame()
    vals = df["values"].astype(str).str.split(" ", expand=True).apply(pd.to_numeric, errors="coerce")
    vals.columns = [f"v{i}" for i in range(vals.shape[1])]
    vals.index = df.epoch_ms
    return df, vals


def pulse_rate(x, fs):
    """Dominant frequency in the pulse band 0.7–3 Hz (42–180 bpm) and how pronounced it is."""
    x = x - np.nanmean(x)
    x = np.nan_to_num(x)
    if len(x) < fs * 8 or np.std(x) == 0:
        return np.nan, 0.0
    b, a = signal.butter(2, [0.7, 3.0], btype="band", fs=fs)
    y = signal.filtfilt(b, a, x)
    f, p = signal.welch(y, fs=fs, nperseg=min(len(y), int(fs * 8)))
    band = (f >= 0.7) & (f <= 3.0)
    i = np.argmax(p[band])
    return f[band][i] * 60, p[band][i] / p[band].sum()


def describe(name, df, vals, hr_ref):
    print(f"\n=== {name}: {len(df)} events")
    if df.empty:
        print("  no data (the sensor delivers nothing to third-party apps or needs activation)")
        return
    dt = np.diff(df.epoch_ms.values)
    fs = 1000 / np.median(dt[dt > 0]) if (dt > 0).any() else np.nan
    print(f"  duration {(df.epoch_ms.iloc[-1] - df.epoch_ms.iloc[0]) / 1000:.1f} s, rate ≈ {fs:.1f} Hz, "
          f"values/event: {df.n.value_counts().to_dict()}, accuracy: {df.accuracy.value_counts().to_dict()}")
    print(f"  duplicate timestamps: {(dt == 0).mean() * 100:.0f} %  (high = sensor delivers blocks)")
    st = vals.describe().T[["mean", "std", "min", "max"]]
    st["unique"] = vals.nunique()
    print(st.round(3).to_string())
    print("  first rows:")
    print(df.head(5).to_string(index=False))

    if np.isfinite(fs) and fs >= 10:
        for c in vals.columns:
            if vals[c].nunique() < 10:
                continue
            bpm, sharp = pulse_rate(vals[c].values.astype(float), fs)
            if sharp > 0.15:
                print(f"  {c}: pulse band peak {bpm:.0f} bpm (sharpness {sharp:.2f})"
                      + (f", heart-rate sensor mean {hr_ref:.0f}" if np.isfinite(hr_ref) else ""))
    for c in vals.columns:
        s = vals[c].dropna()
        if len(s) and s.between(300, 2000).mean() > 0.8:
            implied = 60000 / s.median()
            print(f"  {c}: >80 % within 300–2000 → could be beat intervals in ms "
                  f"(≙ {implied:.0f} bpm)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()

    hr_ref = np.nan
    if (args.session / "hr.csv").exists():
        hr = pd.read_csv(args.session / "hr.csv")
        hr_ref = hr.bpm[hr.bpm > 0].mean()
    sensors = args.session / "sensors.txt"
    if sensors.exists():
        print("Sensors with google/ppg in the name:")
        for line in sensors.read_text(encoding="utf-8").splitlines():
            if "google" in line.lower() or "ppg" in line.lower():
                print("  " + line)

    loaded = {}
    for f in ("raw_ppg.csv", "raw_hr_ext.csv", "raw_ppg_ctrl.csv"):
        p = args.session / f
        if p.exists():
            df, vals = load_raw(p)
            describe(f, df, vals, hr_ref)
            loaded[f] = vals
        else:
            print(f"\n=== {f}: not present")

    if args.plot and loaded:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        n = sum(min(v.shape[1], 6) for v in loaded.values() if not v.empty)
        fig, axes = plt.subplots(max(n, 1), 1, figsize=(12, 1.8 * max(n, 1)), sharex=True)
        axes = np.atleast_1d(axes)
        i = 0
        for name, v in loaded.items():
            if v.empty:
                continue
            t0 = v.index[0]
            seg = v[v.index < t0 + 20000]
            for c in seg.columns[:6]:
                axes[i].plot((seg.index - t0) / 1000, seg[c], lw=0.8)
                axes[i].set_ylabel(f"{name.split('.')[0][4:]}\n{c}", fontsize=8)
                i += 1
        axes[-1].set_xlabel("s")
        fig.tight_layout()
        out = args.session / "ppg_probe.png"
        fig.savefig(out, dpi=110)
        print(f"\nPlot: {out}")


if __name__ == "__main__":
    main()
