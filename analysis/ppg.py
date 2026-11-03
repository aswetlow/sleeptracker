"""
Schlag-zu-Schlag-Auswertung der rohen Pulswelle (raw_ppg.csv, Knopf "Start + PPG").

- Kanalwahl: der Kanal mit der deutlichsten Pulswelle in ruhigen Phasen (oder --channel)
- Schläge: Bandpass 0,6–3,5 Hz, Peaks mit Mindestabstand 0,33 s und Prominenz relativ zur lokalen Amplitude
- Qualität: Bewegung (Accelerometer) ±3 s und Formähnlichkeit zur mittleren Pulswelle
- HRV: SDNN/RMSSD nur aus sauberen Normal-zu-Normal-Intervallen
- Extrasystolen-Kandidaten (nur in sauberen Abschnitten):
    "vorzeitig": Intervall < 80 % des lokalen Medians, danach eine Pause, beide zusammen ≈ 2 Intervalle
    "Puls fehlt": ein Intervall ≈ doppelt so lang, Nachbarn normal (Extrasystole ohne tastbare Pulswelle
                  ODER verpasster Schlag – wird über Zwischenwelle und Folgeschlag-Amplitude bewertet)
  Das sind Kandidaten, keine Diagnose. Validierung nur mit zeitgleichem EKG.

    python ppg.py ../sessions/<session> [--plot] [--channel 6]
"""
import argparse
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import signal

TZ = "Europe/Berlin"
BAND = (0.6, 3.5)
MOTION_THR = 0.03       # m/s², Std von |a| über 1 s
MOTION_PAD_S = 3.0
MIN_CORR = 0.6          # Formähnlichkeit eines Schlags zur Vorlage
WIN_MED = 9             # Schläge für den lokalen Median


def load_ppg(session: Path):
    df = pd.read_csv(session / "raw_ppg.csv")
    vals = df["values"].astype(str).str.split(" ", expand=True).apply(pd.to_numeric, errors="coerce")
    vals.columns = [int(c) for c in vals.columns]
    t = df.epoch_ms.values.astype(float)
    keep = np.r_[True, np.diff(t) > 0]
    return t[keep], vals[keep].reset_index(drop=True)


def motion_mask(session: Path, t_ms):
    acc = pd.read_csv(session / "accel.csv").sort_values("epoch_ms")
    mag = np.linalg.norm(acc[["x", "y", "z"]].values, axis=1)
    act = pd.Series(mag).rolling(25, center=True, min_periods=5).std().fillna(0).values
    moving = np.interp(t_ms, acc.epoch_ms.values, act) > MOTION_THR
    pad = int(MOTION_PAD_S * 100)
    return np.convolve(moving.astype(float), np.ones(2 * pad + 1), mode="same") > 0


def bandpass(x, fs):
    b, a = signal.butter(3, BAND, btype="band", fs=fs)
    x = pd.Series(x).interpolate(limit_direction="both").values
    return signal.filtfilt(b, a, x - np.mean(x))


def pick_channel(vals, fs, still):
    best, score = None, 0
    for c in vals.columns:
        x = vals[c].values.astype(float)
        if np.nanstd(x) == 0 or (x < -1000).mean() > 0.05:     # Statuskanäle mit Sentinel-Werten
            continue
        y = bandpass(x, fs)[still]
        if len(y) < fs * 20:
            continue
        f, p = signal.welch(y, fs=fs, nperseg=int(fs * 8))
        band = (f >= 0.7) & (f <= 3.0)
        s = p[band].max() / p[band].sum()
        if s > score:
            best, score = c, s
    return best, score


def detect_beats(y, fs):
    amp = pd.Series(np.abs(y)).rolling(int(2 * fs), center=True, min_periods=int(fs / 2)).median().values
    pk, prop = signal.find_peaks(y, distance=int(0.33 * fs), prominence=1e-9)
    keep = prop["prominences"] >= 0.8 * amp[pk]
    return pk[keep], prop["prominences"][keep], amp


def beat_corr(y, pk, fs):
    a, b = int(0.3 * fs), int(0.5 * fs)
    segs, idx = [], []
    for i, p in enumerate(pk):
        if p - a >= 0 and p + b < len(y):
            s = y[p - a:p + b]
            segs.append((s - s.mean()) / (s.std() + 1e-9)); idx.append(i)
    corr = np.full(len(pk), np.nan)
    if len(segs) > 10:
        segs = np.array(segs)
        tmpl = np.median(segs, axis=0)
        corr[idx] = segs @ tmpl / (np.linalg.norm(tmpl) * np.sqrt(segs.shape[1]))
    return corr


def analyse(t_ms, y, fs, moving):
    pk, prom, amp = detect_beats(y, fs)
    corr = beat_corr(y, pk, fs)
    beats = pd.DataFrame({"epoch_ms": t_ms[pk], "amp": prom, "corr": corr, "moving": moving[pk]})
    beats["ibi_ms"] = beats.epoch_ms.diff()
    # Intervall gilt als sauber, wenn beide Schläge ruhig und formtreu sind
    good = (~beats.moving) & (beats["corr"] >= MIN_CORR)
    beats["clean"] = good & good.shift(fill_value=False) & (beats.ibi_ms.between(300, 2500))
    med = beats.ibi_ms.where(beats.clean).rolling(WIN_MED, center=True, min_periods=4).median()
    med = med.ffill().bfill()
    beats["ibi_med"] = med
    beats["flag"] = ""

    ibi, m = beats.ibi_ms.values, med.values
    amp_med = beats.amp.where(beats.clean).rolling(WIN_MED, center=True, min_periods=4).median().ffill().bfill().values
    events = []
    for i in range(2, len(beats) - 2):
        # ruhig um das Ereignis herum (Schläge i-4 … i+3), sonst ist der lokale Median unzuverlässig
        if beats.moving.iloc[max(0, i - 4):i + 4].any() or not np.isfinite(m[i]):
            continue
        r = ibi[i] / m[i]
        r_next = ibi[i + 1] / m[i]
        if r < 0.8 and r_next > 1.1 and 1.75 <= r + r_next <= 2.3 and beats.clean.iloc[i - 1]:
            kind = "vorzeitig"
        elif 1.75 <= r <= 2.3 and 0.85 <= ibi[i - 1] / m[i] <= 1.15 and 0.85 <= ibi[i + 1] / m[i] <= 1.15:
            kind = "Puls fehlt"
        else:
            continue
        # Zwischenwelle im langen Intervall? (kleine Welle = schwacher Extraschlag)
        a, b = np.searchsorted(t_ms, beats.epoch_ms.iloc[i - 1] + 250), np.searchsorted(t_ms, beats.epoch_ms.iloc[i] - 250)
        mid = (y[a:b].max() - y[a:b].min()) / (2 * amp_med[i]) if b > a else np.nan
        post = beats.amp.iloc[i + (1 if kind == "vorzeitig" else 0)] / amp_med[i]
        beats.loc[beats.index[i], "flag"] = kind
        events.append({"epoch_ms": beats.epoch_ms.iloc[i], "art": kind, "ibi_ms": ibi[i],
                       "ibi_next_ms": ibi[i + 1], "ibi_median_ms": m[i],
                       "zwischenwelle_rel": round(mid, 2), "folgeschlag_amp_rel": round(post, 2)})
    return beats, pd.DataFrame(events)


def hrv(beats):
    nn = beats[beats.clean & (beats.flag == "")].copy()
    near = beats.flag.ne("").rolling(3, center=True, min_periods=1).max().astype(bool)
    nn = nn[~near.reindex(nn.index).values]
    # übliche Artefaktregel: mehr als 20 % vom lokalen Median weg = kein verlässliches NN-Intervall
    nn = nn[(nn.ibi_ms / nn.ibi_med - 1).abs() <= 0.2]
    d = nn.ibi_ms.diff()[nn.clean.shift(fill_value=False)]
    return nn, (nn.ibi_ms.std(), np.sqrt(np.mean(d.dropna() ** 2)) if d.notna().any() else np.nan)


def felt_markers(session: Path):
    p = session / "events.csv"
    if not p.exists():
        return np.array([])
    ev = pd.read_csv(p)
    return np.sort(ev.epoch_ms[ev.event.astype(str).str.strip('"') == "felt"].values.astype(float))


def check_felt(markers, beats, events, before_s=8.0, after_s=1.0):
    """
    Pro "Gespürt"-Marke: Muster aus vorzeitigem Schlag/Pause in den before_s Sekunden davor?
    Die Bewegung beim Tippen kommt NACH dem Herzstolpern, daher wird hier die Bewegungsmaske ignoriert
    und nur bis kurz vor die Marke geschaut. Referenz-Intervall: Median der sauberen Schläge der Minute davor.
    """
    rows = []
    for m in markers:
        ref = beats[(beats.epoch_ms > m - 60_000) & (beats.epoch_ms < m - before_s * 1000) & beats.clean].ibi_ms
        if len(ref) < 10:
            ref = beats[beats.clean].ibi_ms
        med = ref.median()
        win = beats[(beats.epoch_ms > m - before_s * 1000) & (beats.epoch_ms <= m + after_s * 1000)]
        r = (win.ibi_ms / med).values
        found, dt = "", np.nan
        for i in range(len(r)):
            nxt = r[i + 1] if i + 1 < len(r) else np.nan
            if r[i] < 0.8 and nxt > 1.1 and 1.75 <= r[i] + nxt <= 2.3:
                found = "vorzeitig"
            elif 1.75 <= r[i] <= 2.3:
                found = "Puls fehlt"
            elif r[i] > 1.3 or r[i] < 0.75:
                found = "unregelmäßig"
            if found:
                dt = (win.epoch_ms.iloc[i] - m) / 1000
                break
        auto = events[(events.epoch_ms > m - before_s * 1000) & (events.epoch_ms <= m + after_s * 1000)] \
            if not events.empty else events
        rows.append({"epoch_ms": m, "muster": found or "nichts", "sekunden_vor_marke": dt,
                     "kandidat_automatisch": len(auto) > 0, "median_ibi_ms": med,
                     "beats_im_fenster": len(win)})
    return pd.DataFrame(rows)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("--channel", type=int)
    ap.add_argument("--plot", action="store_true")
    args = ap.parse_args()

    t_ms, vals = load_ppg(args.session)
    fs = 1000 / np.median(np.diff(t_ms))
    moving = motion_mask(args.session, t_ms)
    ch, sharp = (args.channel, np.nan) if args.channel is not None else pick_channel(vals, fs, ~moving)
    if ch is None:
        raise SystemExit("Kein Kanal mit erkennbarer Pulswelle.")
    y = bandpass(vals[ch].values.astype(float), fs)
    beats, events = analyse(t_ms, y, fs, moving)
    nn, (sdnn, rmssd) = hrv(beats)

    hours = (t_ms[-1] - t_ms[0]) / 3.6e6
    clean_h = beats.ibi_ms[beats.clean].sum() / 3.6e6
    lines = [
        f"PPG: Kanal v{ch}, {fs:.0f} Hz, {hours * 60:.1f} min Aufnahme, davon {clean_h / hours * 100:.0f} % "
        f"saubere Schlagfolge",
        f"Schläge: {len(beats)}, Puls aus Intervallen {60000 / nn.ibi_ms.mean():.1f} bpm" if len(nn) else "Schläge: zu wenige",
        f"HRV (nur saubere NN-Intervalle): SDNN {sdnn:.0f} ms, RMSSD {rmssd:.0f} ms",
    ]
    if (args.session / "hr.csv").exists():
        hr = pd.read_csv(args.session / "hr.csv")
        hr = hr[(hr.bpm > 30) & (hr.accuracy >= 2)]
        if len(hr) and len(nn):
            lines.append(f"Pulssensor der Uhr im selben Zeitraum: {hr.bpm.mean():.1f} bpm")
    if events.empty:
        lines.append("Extrasystolen-Kandidaten: keine")
    else:
        per_h = len(events) / max(clean_h, 1e-9)
        lines.append(f"Extrasystolen-Kandidaten: {len(events)} ({per_h:.0f} pro sauberer Stunde) – "
                     + ", ".join(f"{k} {n}" for k, n in events.art.value_counts().items()))
        for e in events.itertuples():
            ts = pd.to_datetime(e.epoch_ms, unit="ms", utc=True).tz_convert(TZ).strftime("%H:%M:%S")
            lines.append(f"  {ts} {e.art}: {e.ibi_ms:.0f} → {e.ibi_next_ms:.0f} ms (Median {e.ibi_median_ms:.0f}), "
                         f"Zwischenwelle {e.zwischenwelle_rel}, Folgeschlag ×{e.folgeschlag_amp_rel}")
        lines.append("Hinweis: Kandidaten, keine Diagnose. 'Puls fehlt' kann auch ein verpasster Schlag sein.")

    markers = felt_markers(args.session)
    felt = check_felt(markers, beats, events) if len(markers) else pd.DataFrame()
    if len(felt):
        hit = felt.muster.isin(["vorzeitig", "Puls fehlt"])
        irr = felt.muster == "unregelmäßig"
        # Wie oft fände man das Muster zufällig in einem 9-s-Fenster? Grob über die Kandidatenrate.
        minutes = len(beats) and (beats.epoch_ms.iloc[-1] - beats.epoch_ms.iloc[0]) / 60000
        chance = 1 - np.exp(-len(events) / max(minutes, 1e-9) * 9 / 60) if minutes else np.nan
        lines.append(f"Gespürt: {len(felt)}× – davon {hit.sum()} mit Extrasystolen-Muster in den 8 s davor, "
                     f"{irr.sum()} nur unregelmäßig, {(~hit & ~irr).sum()} ohne Auffälligkeit "
                     f"(Zufallstreffer-Wahrscheinlichkeit pro Fenster ≈ {chance * 100:.0f} %)")
        for f in felt.itertuples():
            ts = pd.to_datetime(f.epoch_ms, unit="ms", utc=True).tz_convert(TZ).strftime("%H:%M:%S")
            lines.append(f"  {ts}: {f.muster}" + (f" ({-f.sekunden_vor_marke:.1f} s vorher)"
                                                  if np.isfinite(f.sekunden_vor_marke) else ""))
        auto_hit = sum(((markers > e - 1000) & (markers < e + 8000)).any() for e in events.epoch_ms) \
            if not events.empty else 0
        lines.append(f"Automatische Kandidaten ohne Gespürt-Marke in den 8 s danach: {len(events) - auto_hit}")
        felt.to_csv(args.session / "ppg_felt.csv", index=False)

    text = "\n".join(lines)
    print(text)
    (args.session / "ppg_summary.txt").write_text(text + "\n", encoding="utf-8")
    beats.to_csv(args.session / "ppg_beats.csv", index=False)
    events.to_csv(args.session / "ppg_events.csv", index=False)

    if args.plot:
        import matplotlib
        matplotlib.use("Agg")
        import matplotlib.pyplot as plt
        snips = [(e.epoch_ms, e.art, False) for e in events.itertuples()]
        snips += [(m, "Gespürt", True) for m in markers]
        snips = sorted(snips)[:12]
        n_ev = len(snips)
        fig = plt.figure(figsize=(12, 4 + 2 * ((n_ev + 1) // 2)))
        gs = fig.add_gridspec(2 + (n_ev + 1) // 2, 2)
        ax = fig.add_subplot(gs[0:2, :])
        tt = pd.to_datetime(beats.epoch_ms, unit="ms", utc=True).dt.tz_convert(TZ).dt.tz_localize(None)
        ax.plot(tt[beats.clean], beats.ibi_ms[beats.clean], ".", ms=2, label="sauber")
        ax.plot(tt[~beats.clean], beats.ibi_ms[~beats.clean], ".", ms=2, color="lightgrey", label="Bewegung/unsicher")
        f = beats.flag != ""
        ax.plot(tt[f], beats.ibi_ms[f], "rx", ms=6, label="Kandidat")
        ax.set_ylim(300, 2000)
        ax.set_ylabel("Schlagintervall ms")
        for m in markers:
            ax.axvline(pd.to_datetime(m, unit="ms", utc=True).tz_convert(TZ).tz_localize(None),
                       color="tab:green", lw=0.8)
        ax.legend(fontsize=8)
        ax.set_title("grüne Linie = Gespürt", fontsize=8)
        for k, (t0, label, is_marker) in enumerate(snips):
            a = fig.add_subplot(gs[2 + k // 2, k % 2])
            lo, hi = (8000, 2000) if is_marker else (4000, 3000)
            sel = (t_ms > t0 - lo) & (t_ms < t0 + hi)
            a.plot((t_ms[sel] - t0) / 1000, y[sel], lw=0.8)
            bp = beats[(beats.epoch_ms > t0 - lo) & (beats.epoch_ms < t0 + hi)]
            a.plot((bp.epoch_ms - t0) / 1000, np.interp(bp.epoch_ms, t_ms, y), "r.", ms=4)
            if is_marker:
                a.axvline(0, color="tab:green", lw=1)
            a.set_title(f"{pd.to_datetime(t0, unit='ms', utc=True).tz_convert(TZ):%H:%M:%S} {label}", fontsize=8)
            a.tick_params(labelsize=7)
        fig.tight_layout()
        out = args.session / "ppg.png"
        fig.savefig(out, dpi=100)
        print(f"Plot: {out}")


if __name__ == "__main__":
    main()
