#!/usr/bin/env python3
"""
Analyse einer SleepLogger-Nacht.

    python analyze.py <session-ordner> [--plot]

Liest accel.csv und hr.csv, findet Bewegungs-Events, misst die Pulsreaktion
darauf und versucht in ruhigen Phasen eine Atemfrequenz zu schätzen.
Schreibt movement_events.csv, per_minute.csv und summary.txt in den Ordner.
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal

ACTIVITY_WINDOW_S = 1.0     # Fenster für Bewegungsintensität
MERGE_GAP_S = 5.0           # Events mit kleinerer Lücke werden zusammengefasst
MIN_EVENT_S = 1.0
THRESHOLD_K = 6.0           # Schwelle = Median + K * MAD der Ruhe-Aktivität
MIN_THRESHOLD = 0.05        # m/s², Untergrenze, damit Sensorrauschen/Atmung nie als Bewegung zählt
HR_PRE_S, HR_POST_S = 30, 60
BREATH_WINDOW_S = 60
BREATH_BAND_HZ = (0.1, 0.5)  # 6–30 Atemzüge/min


def load(session: Path):
    acc = pd.read_csv(session / "accel.csv")
    hr = pd.read_csv(session / "hr.csv")
    acc["t"] = pd.to_datetime(acc.epoch_ms, unit="ms", utc=True).dt.tz_convert("Europe/Berlin")
    hr["t"] = pd.to_datetime(hr.epoch_ms, unit="ms", utc=True).dt.tz_convert("Europe/Berlin")
    hr = hr[(hr.bpm > 30) & (hr.accuracy >= 2)]  # 0/1 = unzuverlässig bzw. kein Hautkontakt
    return acc.sort_values("epoch_ms"), hr.sort_values("epoch_ms")


def resample_accel(acc: pd.DataFrame, fs: float):
    """Auf festes Raster bringen (Batching liefert unregelmäßige Abstände)."""
    t0, t1 = acc.epoch_ms.iloc[0], acc.epoch_ms.iloc[-1]
    grid = np.arange(t0, t1, 1000.0 / fs)
    xyz = np.column_stack([np.interp(grid, acc.epoch_ms, acc[c]) for c in "xyz"])
    # Lücken > 1 s (z. B. FIFO-Überlauf) als NaN markieren statt zu interpolieren
    gaps = np.diff(acc.epoch_ms.values) > 1000
    for a, b in zip(acc.epoch_ms.values[:-1][gaps], acc.epoch_ms.values[1:][gaps]):
        xyz[(grid > a) & (grid < b)] = np.nan
    return grid, xyz


def movement_events(grid, xyz, fs):
    mag = np.linalg.norm(xyz, axis=1)
    win = int(ACTIVITY_WINDOW_S * fs)
    s = pd.Series(mag)
    # Std der Magnitude pro Fenster: Lageänderung und Zucken, unabhängig von Schwerkraft-Richtung
    activity = s.rolling(win, center=True, min_periods=win // 2).std().values
    baseline = np.nanmedian(activity)
    mad = np.nanmedian(np.abs(activity - baseline)) or 1e-3
    thr = max(baseline + THRESHOLD_K * mad, MIN_THRESHOLD)
    active = np.nan_to_num(activity) > thr

    events, start = [], None
    for i, a in enumerate(active):
        if a and start is None:
            start = i
        elif not a and start is not None:
            events.append([start, i]); start = None
    if start is not None:
        events.append([start, len(active)])

    merged = []
    for e in events:
        if merged and (e[0] - merged[-1][1]) / fs < MERGE_GAP_S:
            merged[-1][1] = e[1]
        else:
            merged.append(e)
    merged = [e for e in merged if (e[1] - e[0]) / fs >= MIN_EVENT_S]

    # Lagewechsel: Schwerkraftvektor vorher/nachher vergleichen
    rows = []
    for a, b in merged:
        pre_seg, post_seg = xyz[max(0, a - int(5 * fs)):a], xyz[b:b + int(5 * fs)]
        angle = np.nan
        if len(pre_seg) and len(post_seg):
            pre, post = np.nanmean(pre_seg, axis=0), np.nanmean(post_seg, axis=0)
            cos = np.dot(pre, post) / (np.linalg.norm(pre) * np.linalg.norm(post) + 1e-9)
            angle = float(np.degrees(np.arccos(np.clip(cos, -1, 1))))
        rows.append({
            "start_ms": grid[a], "end_ms": grid[min(b, len(grid) - 1)],
            "duration_s": (b - a) / fs,
            "peak_activity": float(np.nanmax(activity[a:b])),
            "orientation_change_deg": angle,
        })
    return pd.DataFrame(rows), activity, thr


def hr_response(events: pd.DataFrame, hr: pd.DataFrame):
    if hr.empty or events.empty:
        return events
    hr_s = hr.set_index("epoch_ms").bpm
    pre, peak = [], []
    for _, e in events.iterrows():
        before = hr_s[(hr_s.index >= e.start_ms - HR_PRE_S * 1000) & (hr_s.index < e.start_ms)]
        after = hr_s[(hr_s.index >= e.start_ms) & (hr_s.index <= e.end_ms + HR_POST_S * 1000)]
        pre.append(before.median() if len(before) else np.nan)
        peak.append(after.max() if len(after) else np.nan)
    events["hr_before"] = pre
    events["hr_peak_after"] = peak
    events["hr_delta"] = events.hr_peak_after - events.hr_before
    return events


def breathing_estimates(grid, xyz, activity, thr, fs):
    """
    Nur in komplett ruhigen 60-s-Fenstern: Bandpass 0,1–0,5 Hz auf der Achse mit
    der größten Varianz, Peak im Welch-Spektrum. Am Handgelenk ist das Signal
    winzig und oft vom Puls oder Mikrobewegungen überlagert, deshalb gibt es
    einen Qualitätswert (Anteil der Bandleistung im Peak). Werte < 0,3 ignorieren.
    """
    sos = signal.butter(2, BREATH_BAND_HZ, btype="band", fs=fs, output="sos")
    n = int(BREATH_WINDOW_S * fs)
    out = []
    for i in range(0, len(grid) - n, n):
        seg = xyz[i:i + n]
        if np.isnan(seg).any() or np.nanmax(activity[i:i + n]) > thr * 0.5:
            continue
        filt = signal.sosfiltfilt(sos, seg - seg.mean(axis=0), axis=0)
        axis = np.argmax(filt.var(axis=0))
        f, p = signal.welch(filt[:, axis], fs=fs, nperseg=n, nfft=4 * n)
        band = (f >= BREATH_BAND_HZ[0]) & (f <= BREATH_BAND_HZ[1])
        if not band.any() or p[band].sum() == 0:
            continue
        k = np.argmax(p[band])
        fb, pb = f[band], p[band]
        quality = pb[max(0, k - 1):k + 2].sum() / pb.sum()
        out.append({"epoch_ms": grid[i], "breaths_per_min": fb[k] * 60, "quality": quality})
    return pd.DataFrame(out)


def per_minute(grid, activity, events, hr, breath):
    df = pd.DataFrame({"epoch_ms": grid, "activity": activity})
    df["minute"] = (df.epoch_ms // 60000) * 60000
    m = df.groupby("minute").activity.mean().to_frame("activity_mean")
    m["movement_events"] = 0
    if not events.empty:
        counts = ((events.start_ms // 60000) * 60000).value_counts()
        m.loc[m.index.intersection(counts.index), "movement_events"] = counts
    if not hr.empty:
        hr_m = hr.assign(minute=(hr.epoch_ms // 60000) * 60000).groupby("minute").bpm
        m["hr_mean"] = hr_m.mean(); m["hr_min"] = hr_m.min(); m["hr_max"] = hr_m.max()
    if not breath.empty:
        good = breath[breath.quality >= 0.3]
        m["breaths_per_min"] = good.assign(minute=(good.epoch_ms // 60000) * 60000) \
            .groupby("minute").breaths_per_min.mean()
    m.index = pd.to_datetime(m.index, unit="ms", utc=True).tz_convert("Europe/Berlin")
    return m


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--fs", type=float, default=25.0)
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()

    acc, hr = load(args.session)
    grid, xyz = resample_accel(acc, args.fs)
    events, activity, thr = movement_events(grid, xyz, args.fs)
    events = hr_response(events, hr)
    breath = breathing_estimates(grid, xyz, activity, thr, args.fs)
    minutes = per_minute(grid, activity, events, hr, breath)

    hours = (grid[-1] - grid[0]) / 3.6e6
    gap_s = np.isnan(xyz[:, 0]).sum() / args.fs
    good_breath = breath[breath.quality >= 0.3] if not breath.empty else breath
    lines = [
        f"Aufzeichnung: {hours:.2f} h, Datenlücken: {gap_s / 60:.1f} min",
        f"Bewegungs-Events: {len(events)} ({len(events) / max(hours, 1e-9):.1f}/h)",
    ]
    if not events.empty:
        big = events[events.orientation_change_deg > 30]
        lines += [
            f"  davon Lagewechsel (>30°): {len(big)}",
            f"  mittlere Dauer: {events.duration_s.mean():.1f} s",
        ]
        if "hr_delta" in events:
            lines.append(f"  mittlere Pulsreaktion: +{events.hr_delta.mean():.1f} bpm")
    if not hr.empty:
        lines.append(f"Puls: min {hr.bpm.min():.0f}, Median {hr.bpm.median():.0f}, "
                     f"max {hr.bpm.max():.0f} bpm ({len(hr)} Werte)")
    lines.append(f"Atemfrequenz-Schätzungen mit Qualität ≥0,3: {len(good_breath)} von "
                 f"{len(breath)} ruhigen Minuten" +
                 (f", Median {good_breath.breaths_per_min.median():.1f}/min"
                  if len(good_breath) else ""))
    summary = "\n".join(lines)
    print(summary)

    (args.session / "summary.txt").write_text(summary + "\n")
    events.to_csv(args.session / "movement_events.csv", index=False)
    minutes.to_csv(args.session / "per_minute.csv")

    if args.plot:
        import matplotlib.pyplot as plt
        fig, ax = plt.subplots(3, 1, sharex=True, figsize=(14, 8))
        ax[0].plot(minutes.index, minutes.activity_mean); ax[0].set_ylabel("Aktivität")
        ax[1].bar(minutes.index, minutes.movement_events, width=1 / 1440)
        ax[1].set_ylabel("Events/min")
        if "hr_mean" in minutes:
            ax[2].plot(minutes.index, minutes.hr_mean); ax[2].set_ylabel("Puls")
        fig.tight_layout()
        fig.savefig(args.session / "night.png", dpi=120)
        print(f"Plot: {args.session / 'night.png'}")


if __name__ == "__main__":
    main()
