"""
Atempausen-Test: Sieht die Uhr willkürliches Luftanhalten?

Protokoll (siehe README, Abschnitt 7):
  Start (am besten "Start + PPG"), 2 min ruhig atmen, Handgelenk schütteln + Stoppuhr starten,
  ab 0:30 fünfmal 20 s Luft anhalten / 40 s atmen, bei ~5:30 nochmal schütteln, Stopp.

Auswertung:
  - Zeitmarke = erstes kräftiges Schütteln nach der Ruhephase (oder --marker HH:MM:SS)
  - Atembewegung: Bandpass 0,1–0,7 Hz, Hauptkomponente über die Achsen (Gyro und Accelerometer getrennt)
  - Amplitude: gleitender RMS über 5 s, normiert auf den Median der Testphase (≈ normales Atmen)
  - Pause erkannt: Amplitude < PAUSE_RATIO für ≥ MIN_PAUSE_S
  - Abgleich mit den geplanten Pausen: Treffer, Fehlalarme, Zeitversatz
  - Puls pro Pause (vorher / während / danach), bei PPG-Rohdaten zusätzlich die Atemmodulation der Pulswelle

    python breath_hold.py ../sessions/<session> --plot
"""
import argparse
from datetime import datetime
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal

from analyze import load, resample, movement_events, principal_component, autocorr_rate

FS = 25.0
RESP_BAND = (0.1, 0.7)
ENV_WIN_S = 5.0
PAUSE_RATIO = 0.35
MIN_PAUSE_S = 8.0
TZ = "Europe/Berlin"


def schedule(marker_ms, first_s, hold_s, cycle_s, n):
    return [(marker_ms + (first_s + k * cycle_s) * 1000, marker_ms + (first_s + k * cycle_s + hold_s) * 1000)
            for k in range(n)]


def find_marker(events, grid, explicit, min_quiet_s=60):
    if explicit:
        day = pd.to_datetime(grid[0], unit="ms", utc=True).tz_convert(TZ)
        t = datetime.strptime(explicit, "%H:%M:%S").time()
        return pd.Timestamp.combine(day.date(), t).tz_localize(TZ).value / 1e6
    cand = events[(events.start_ms > grid[0] + min_quiet_s * 1000)].sort_values("start_ms")
    strong = cand[cand.peak_activity >= cand.peak_activity.max() * 0.3] if len(cand) else cand
    return float(strong.start_ms.iloc[0]) if len(strong) else None


def resp_envelope(xyz, mask, fs, band=RESP_BAND, order=2):
    """Atemkomponente und normierte Amplitude innerhalb der Maske (Rest NaN)."""
    sos = signal.butter(order, band, btype="band", fs=fs, output="sos")
    seg = np.nan_to_num(xyz[mask] - np.nanmean(xyz[mask], axis=0))
    filt = signal.sosfiltfilt(sos, seg, axis=0)
    pc = filt[:, 0] if filt.shape[1] == 1 else principal_component(filt)
    win = int(ENV_WIN_S * fs)
    env = pd.Series(pc).pow(2).rolling(win, center=True, min_periods=win // 2).mean().pow(0.5).values
    env = env / np.nanmedian(env)
    out_pc, out_env = np.full(len(mask), np.nan), np.full(len(mask), np.nan)
    out_pc[mask], out_env[mask] = pc, env
    return out_pc, out_env


def detect_pauses(grid, env, fs):
    low = np.nan_to_num(env, nan=np.inf) < PAUSE_RATIO
    out, start = [], None
    for i, v in enumerate(low):
        if v and start is None:
            start = i
        elif not v and start is not None:
            if (i - start) / fs >= MIN_PAUSE_S:
                out.append((grid[start], grid[i - 1]))
            start = None
    return out


def match(planned, found, tol_s=10):
    hits, used = [], set()
    for a, b in planned:
        best = None
        for j, (c, d) in enumerate(found):
            ov = min(b, d) - max(a, c)
            if j not in used and ov > -tol_s * 1000 and (best is None or ov > best[1]):
                best = (j, ov)
        if best:
            used.add(best[0])
            c, d = found[best[0]]
            hits.append({"planned_start": a, "found_start": c, "offset_s": (c - a) / 1000,
                         "found_len_s": (d - c) / 1000})
        else:
            hits.append({"planned_start": a, "found_start": np.nan, "offset_s": np.nan, "found_len_s": np.nan})
    false_alarms = [f for j, f in enumerate(found) if j not in used]
    return pd.DataFrame(hits), false_alarms


def load_ppg(session, grid, fs_out=FS):
    """Rohe PPG-Kanäle auf das Raster bringen (nur Kanäle mit Pulswelle). None, wenn nicht vorhanden."""
    p = session / "raw_ppg.csv"
    if not p.exists():
        return None, None
    df = pd.read_csv(p)
    if df.empty:
        return None, None
    vals = df["values"].astype(str).str.split(" ", expand=True).apply(pd.to_numeric, errors="coerce")
    t = df.epoch_ms.values.astype(float)
    keep = np.r_[True, np.diff(t) > 0]
    t, vals = t[keep], vals[keep]
    fs_raw = 1000 / np.median(np.diff(t))
    if fs_raw < 5:
        return None, fs_raw
    chans = {}
    b, a = signal.butter(2, [0.7, 3.0], btype="band", fs=fs_raw)
    for c in vals.columns:
        x = vals[c].values.astype(float)
        if np.nanstd(x) == 0 or len(x) < fs_raw * 20:
            continue
        y = signal.filtfilt(b, a, np.nan_to_num(x - np.nanmean(x)))
        f, pw = signal.welch(y, fs=fs_raw, nperseg=int(fs_raw * 8))
        band = (f >= 0.7) & (f <= 3.0)
        if pw[band].max() / pw[band].sum() > 0.15:
            chans[f"ppg_v{c}"] = np.interp(grid, t, x, left=np.nan, right=np.nan)
    return (chans or None), fs_raw


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--marker", help="Zeitmarke HH:MM:SS statt automatischer Erkennung")
    ap.add_argument("--first-s", type=float, default=30)
    ap.add_argument("--hold-s", type=float, default=20)
    ap.add_argument("--cycle-s", type=float, default=60)
    ap.add_argument("--holds", type=int, default=5)
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()

    acc, gyro, hr = load(args.session)
    grid = np.arange(acc.epoch_ms.iloc[0], acc.epoch_ms.iloc[-1], 1000.0 / FS)
    sources = {"gyro": resample(gyro, grid)} if gyro is not None and len(gyro) > 100 else {}
    sources["accel"] = resample(acc, grid)
    events, activity, thr = movement_events(grid, sources["accel"], FS)

    marker = find_marker(events, grid, args.marker)
    if marker is None:
        raise SystemExit("Keine Zeitmarke (Schütteln) gefunden – mit --marker HH:MM:SS angeben.")
    plan = schedule(marker, args.first_s, args.hold_s, args.cycle_s, args.holds)
    test_a = plan[0][0] - 25_000
    test_b = plan[-1][1] + 25_000   # vor dem End-Schütteln aufhören
    fmt = lambda ms: pd.to_datetime(ms, unit="ms", utc=True).tz_convert(TZ).strftime("%H:%M:%S")
    lines = [f"Zeitmarke: {fmt(marker)}  →  geplante Pausen ab " + ", ".join(fmt(a) for a, _ in plan)]

    moving = [(e.start_ms, e.end_ms) for e in events.itertuples() if test_a <= e.start_ms <= test_b]
    if moving:
        lines.append("Bewegung während des Tests (stört die Auswertung): " +
                     ", ".join(f"{fmt(a)} ({(b - a) / 1000:.0f} s)" for a, b in moving))

    # Grundlinie: ruhige Phase vor der Zeitmarke
    base = (grid > grid[0] + 15_000) & (grid < marker - 5_000)
    for name, xyz in sources.items():
        if base.sum() > 60 * FS:
            sos = signal.butter(2, (0.1, 0.5), btype="band", fs=FS, output="sos")
            seg = signal.sosfiltfilt(sos, np.nan_to_num(xyz[base] - np.nanmean(xyz[base], axis=0)), axis=0)
            rate, q = autocorr_rate(principal_component(seg), FS)
            lines.append(f"Ruhephase {name}: {rate:.1f} Atemzüge/min (Qualität {q:.2f})")

    test = (grid >= test_a) & (grid <= test_b)
    results, traces = {}, {}
    for name, xyz in sources.items():
        pc, env = resp_envelope(xyz, test, FS)
        traces[name] = (pc, env)
        found = detect_pauses(grid, env, FS)
        hits, fa = match(plan, found)
        results[name] = (hits, fa)
        in_hold = np.zeros(len(grid), bool)
        for a, b in plan:
            in_hold |= (grid >= a + 3000) & (grid <= b - 3000)
        ratio = np.nanmedian(env[in_hold]) / np.nanmedian(env[test & ~in_hold])
        n_hit = hits.found_start.notna().sum()
        lines.append(f"{name}: {n_hit}/{len(plan)} Pausen erkannt, {len(fa)} Fehlalarme, "
                     f"Amplitude in Pausen = {ratio * 100:.0f} % vom Atmen"
                     + (f", Versatz {hits.offset_s.median():+.1f} s" if n_hit else ""))

    ppg, ppg_fs = load_ppg(args.session, grid)
    if ppg:
        lines.append(f"PPG: {len(ppg)} Kanal/Kanäle mit Pulswelle, {ppg_fs:.0f} Hz")
        for name, x in ppg.items():
            # Pulswelle selbst (~1 Hz) muss raus, nur die langsame Atemmodulation der Grundlinie bleibt
            pc, env = resp_envelope(x[:, None], test, FS, band=(0.1, 0.45), order=4)
            traces[name] = (pc, env)
            found = detect_pauses(grid, env, FS)
            hits, fa = match(plan, found)
            results[name] = (hits, fa)
            in_hold = np.zeros(len(grid), bool)
            for a, b in plan:
                in_hold |= (grid >= a + 3000) & (grid <= b - 3000)
            ratio = np.nanmedian(env[in_hold]) / np.nanmedian(env[test & ~in_hold])
            lines.append(f"{name} (Atemmodulation der Pulswelle): {hits.found_start.notna().sum()}/{len(plan)} "
                         f"erkannt, {len(fa)} Fehlalarme, Amplitude in Pausen {ratio * 100:.0f} %")
    elif ppg_fs is not None:
        lines.append(f"PPG: Rohdaten vorhanden, aber zu langsam ({ppg_fs:.1f} Hz) oder ohne Pulswelle")

    if len(hr):
        rows = []
        for a, b in plan:
            pre = hr[(hr.epoch_ms >= a - 20_000) & (hr.epoch_ms < a)].bpm.mean()
            during = hr[(hr.epoch_ms >= a) & (hr.epoch_ms < b)].bpm
            after = hr[(hr.epoch_ms >= b) & (hr.epoch_ms < b + 30_000)].bpm.max()
            rows.append((pre, during.min(), during.max(), after))
        r = np.array(rows, float)
        lines.append(f"Puls pro Pause (Mittel): vorher {np.nanmean(r[:, 0]):.0f}, während {np.nanmean(r[:, 1]):.0f}–"
                     f"{np.nanmean(r[:, 2]):.0f}, Maximum 30 s danach {np.nanmean(r[:, 3]):.0f} bpm")

    text = "\n".join(lines)
    print(text)
    (args.session / "breath_hold.txt").write_text(text + "\n", encoding="utf-8")

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        names = list(traces)
        fig, axes = plt.subplots(2 * len(names) + 1, 1, figsize=(12, 2.0 * (2 * len(names) + 1)), sharex=True)
        t = pd.to_datetime(grid, unit="ms", utc=True).tz_convert(TZ).tz_localize(None)
        view = (grid >= test_a - 30_000) & (grid <= test_b + 10_000)
        k = 0
        for name in names:
            pc, env = traces[name]
            axes[k].plot(t[view], pc[view], lw=0.7)
            axes[k].set_ylabel(f"{name}\nAtembewegung", fontsize=8)
            axes[k + 1].plot(t[view], env[view], lw=1)
            axes[k + 1].axhline(PAUSE_RATIO, color="grey", lw=0.8, ls="--")
            axes[k + 1].set_ylabel("Amplitude\n(rel.)", fontsize=8)
            for a, b in results[name][0].dropna().apply(
                    lambda r: (r.found_start, r.found_start + r.found_len_s * 1000), axis=1):
                axes[k + 1].axvspan(pd.to_datetime(a, unit="ms", utc=True).tz_convert(TZ).tz_localize(None),
                                    pd.to_datetime(b, unit="ms", utc=True).tz_convert(TZ).tz_localize(None),
                                    color="tab:green", alpha=0.25)
            k += 2
        hv = hr[(hr.epoch_ms >= grid[view][0]) & (hr.epoch_ms <= grid[view][-1])]
        axes[k].plot(hv.t.dt.tz_localize(None), hv.bpm, lw=1)
        axes[k].set_ylabel("Puls", fontsize=8)
        for ax in axes:
            for a, b in plan:
                ax.axvspan(pd.to_datetime(a, unit="ms", utc=True).tz_convert(TZ).tz_localize(None),
                           pd.to_datetime(b, unit="ms", utc=True).tz_convert(TZ).tz_localize(None),
                           color="tab:red", alpha=0.12)
        axes[0].set_title("rot = geplante Pause, grün = erkannte Pause", fontsize=9)
        fig.tight_layout()
        out = args.session / "breath_hold.png"
        fig.savefig(out, dpi=110)
        print(f"Plot: {out}")


if __name__ == "__main__":
    main()
