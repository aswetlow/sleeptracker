"""
Fitbit-Export neben die Sekunden-Daten legen.

Erwartet im Session-Ordner eine Datei fitbit.json (oder eine andere .json/.md/.txt, die das
Export-JSON mit einem "fitbit"-Block enthält; Text vor der ersten "{" wird ignoriert).
Genutzt werden: Schlafphasen, Vitalwerte, Puls/min, SpO2/min, HRV/5 min und, falls
vorhanden, Raumklima (tado).
"""
import json
from pathlib import Path

import numpy as np
import pandas as pd

TZ = "Europe/Berlin"
LOW_SPO2 = 90
LOW_SPO2_MIN_MINUTES = 5
ODI_DROP = 3                 # Entsättigung: ≥3 Punkte unter dem Median der 5 min davor
POSE_STILL_DEG = 10          # Armlage gilt als unverändert, solange sie weniger kippt
STAGE_ORDER = ["wake", "rem", "light", "deep"]


def find_export(session: Path, explicit: Path | None = None):
    candidates = [explicit] if explicit else \
        [session / "fitbit.json"] + sorted(p for p in session.iterdir()
                                           if p.suffix.lower() in (".json", ".md", ".txt"))
    for p in candidates:
        if p is None or not p.exists():
            continue
        text = p.read_text(encoding="utf-8", errors="ignore")
        if "{" not in text:
            continue
        try:
            data = json.loads(text[text.index("{"):])
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "fitbit" in data:
            return data, p
    return None, None


def _local(series):
    return pd.to_datetime(series).dt.tz_localize(TZ, ambiguous="NaT", nonexistent="shift_forward")


def load(data: dict):
    fb = data["fitbit"]
    out = {"vitals": fb.get("vitals") or {}, "sleep": fb.get("sleep") or {}}
    tl = pd.DataFrame(out["sleep"].get("timeline") or [])
    if not tl.empty:
        tl["start"] = _local(tl.start)
        tl["end"] = tl.start + pd.to_timedelta(tl.minutes, unit="min")
    out["stages"] = tl
    for key, src, col in (("hr", "heartRatePerMinute", "bpm"), ("spo2", "spo2PerMinute", "value"),
                          ("hrv", "hrvPer5Minutes", "value")):
        df = pd.DataFrame(fb.get(src) or [])
        out[key] = (df.assign(t=_local(df.time).dt.floor("min")).dropna(subset=["t"])
                    .set_index("t")[col].groupby(level=0).mean()) if not df.empty else pd.Series(dtype=float)
    room = pd.DataFrame((data.get("tado") or {}).get("readings") or [])
    out["room"] = room
    return out


def stage_at(stages: pd.DataFrame, times):
    times = pd.DatetimeIndex(times)
    out = np.full(len(times), None, dtype=object)
    for _, r in stages.iterrows():
        out[(times >= r.start) & (times < r.end)] = r.level
    return out


def wrist_pose(acc: pd.DataFrame):
    """Schwerkraftrichtung pro Minute (Einheitsvektor) und Winkeländerung zur Vorminute."""
    t = pd.to_datetime(acc.epoch_ms, unit="ms", utc=True).dt.tz_convert(TZ)
    g = acc.set_index(t)[["x", "y", "z"]].resample("1min").median()
    g = g.div(np.linalg.norm(g.values, axis=1), axis=0)
    prev = g.shift()
    cos = (g * prev).sum(axis=1).clip(-1, 1)
    g["pose_change_deg"] = np.degrees(np.arccos(cos))
    return g


def annotate(minutes: pd.DataFrame, fb: dict, pose: pd.DataFrame):
    m = minutes.copy()
    if not fb["stages"].empty:
        m["stage"] = stage_at(fb["stages"], m.index)
    m["fitbit_hr"] = fb["hr"].reindex(m.index)
    m["spo2"] = fb["spo2"].reindex(m.index)
    m["hrv"] = fb["hrv"].reindex(m.index, method="ffill", limit=4) if len(fb["hrv"]) else np.nan
    m = m.join(pose, how="left")
    return m


def low_spo2_episodes(m: pd.DataFrame, events: pd.DataFrame):
    """
    Minuten mit SpO2 < LOW_SPO2, Lücken bis 3 min (fehlend oder knapp darüber) werden überbrückt.
    Pro Episode: Dauer, Minimum, wie stark sich die Armlage währenddessen änderte,
    ob sie mit einer Bewegung endete und ob der Puls reagierte.
    """
    low_t = m.spo2[m.spo2 < LOW_SPO2].index
    rows, cur = [], []
    for t in low_t:
        if cur and (t - cur[-1]) > pd.Timedelta("3min"):
            rows.append(cur); cur = []
        cur.append(t)
    rows.append(cur)
    rows = [ep for ep in rows if len(ep) >= LOW_SPO2_MIN_MINUTES]

    mv_t = pd.to_datetime(events.start_ms, unit="ms", utc=True).dt.tz_convert(TZ) \
        if not events.empty else pd.Series(dtype="datetime64[ns, Europe/Berlin]")
    out = []
    for ep in rows:
        a, b = ep[0], ep[-1] + pd.Timedelta("1min")
        seg = m.loc[a:b - pd.Timedelta("1min")]
        core = seg.iloc[:-2] if len(seg) > 4 else seg   # ohne die Endbewegung
        pose_change = core.pose_change_deg.iloc[1:].max() if len(core) > 1 else 0.0
        ends_with_move = bool(((mv_t >= b - pd.Timedelta("3min")) & (mv_t <= b + pd.Timedelta("2min"))).any())
        hr_rise = (core.hr_max.max() - core.hr_mean.median()) if "hr_max" in core else np.nan
        still = (pose_change or 0) < POSE_STILL_DEG
        verdict = ("vermutlich Lage-Artefakt (Arm unbewegt, endet mit Bewegung, Puls ruhig)"
                   if still and ends_with_move and (np.isnan(hr_rise) or hr_rise < 10) else "unklar")
        out.append({"start": a, "end": b, "minutes": len(ep), "spo2_min": seg.spo2.min(),
                    "spo2_mean": seg.spo2.mean(), "max_pose_change_deg": pose_change,
                    "ends_with_movement": ends_with_move, "hr_rise_bpm": hr_rise,
                    "stage": seg.stage.mode().iloc[0] if "stage" in seg and seg.stage.notna().any() else None,
                    "verdict": verdict})
    return pd.DataFrame(out)


def odi(m: pd.DataFrame):
    s = m.spo2.dropna()
    if len(s) < 10:
        return 0, np.nan
    base = s.rolling("5min", closed="left").median()
    drops = (s <= base - ODI_DROP)
    # aufeinanderfolgende Minuten zählen als eine Entsättigung
    n = int((drops & ~drops.shift(fill_value=False)).sum())
    return n, n / (len(s) / 60)


def summary_lines(fb, m, breath, events, min_quality):
    lines = ["", "— Abgleich mit Fitbit —"]
    v, sl = fb["vitals"], fb["sleep"]
    if sl:
        lines.append(f"Schlaf laut Fitbit: {sl.get('minutesAsleep')} min, Effizienz {sl.get('efficiency')} %, "
                     f"Tief {sl.get('deepMinutes')} / leicht {sl.get('lightMinutes')} / "
                     f"REM {sl.get('remMinutes')} / wach {sl.get('wakeMinutes')} min")

    if not breath.empty and not fb["stages"].empty:
        b = breath[breath.quality >= min_quality].copy()
        b["stage"] = stage_at(fb["stages"], pd.to_datetime(b.epoch_ms, unit="ms", utc=True).dt.tz_convert(TZ))
        ref = {"deep": v.get("breathingDeep"), "light": v.get("breathingLight"), "rem": v.get("breathingRem")}
        parts = []
        for st in ("deep", "light", "rem"):
            s = b[b.stage == st].breaths_per_min
            if len(s):
                parts.append(f"{st} {s.median():.1f} ±{s.std():.1f} (Fitbit {ref[st] if ref[st] is not None else '–'})")
        lines.append(f"Atemfrequenz Uhr pro Phase: " + ", ".join(parts) +
                     f"; gesamt Fitbit {v.get('breathingRate', '–')}")

    both = m[["hr_mean", "fitbit_hr"]].dropna() if "hr_mean" in m else pd.DataFrame()
    if len(both) > 30:
        lines.append(f"Puls Uhr vs. Fitbit: r = {both.corr().iloc[0, 1]:.3f}, "
                     f"mittl. Differenz {(both.hr_mean - both.fitbit_hr).mean():+.1f} bpm")

    if "stage" in m and not events.empty:
        st_min = m.stage.value_counts()
        ev_st = m.loc[m.movement_events > 0].groupby("stage").movement_events.sum()
        lines.append("Bewegung pro Phase: " + ", ".join(
            f"{s} {ev_st.get(s, 0) / st_min[s] * 60:.1f}/h" for s in STAGE_ORDER if s in st_min))

    if m.spo2.notna().any():
        n_odi, odi_h = odi(m)
        lines.append(f"SpO2: Mittel {m.spo2.mean():.1f} %, min {m.spo2.min():.1f} %, "
                     f"{(m.spo2 < LOW_SPO2).sum()} min unter {LOW_SPO2} %, "
                     f"Entsättigungen ≥{ODI_DROP} Punkte: {n_odi} ({odi_h:.1f}/h)")
        if v.get("hrv") is not None:
            lines.append(f"HRV (Fitbit): {v.get('hrv')} ms, Ruhepuls {v.get('restingHeartRate')}")
    room = fb["room"]
    if not room.empty:
        hum = room.humidity.mean()
        lines.append(f"Raum: {room.temperature.mean():.1f} °C, {hum:.0f} % Luftfeuchte"
                     + (" (über 60 %)" if hum > 60 else ""))
    return lines


def plot_extra(ax_stage, ax_spo2, fb, m, episodes):
    st = fb["stages"]
    if not st.empty:
        y = {s: i for i, s in enumerate(STAGE_ORDER)}
        for _, r in st.iterrows():
            ax_stage.hlines(y.get(r.level, 0), r.start, r.end, lw=6,
                            color={"wake": "tab:red", "rem": "tab:purple", "light": "tab:cyan",
                                   "deep": "tab:blue"}.get(r.level, "grey"))
        ax_stage.set_yticks(range(len(STAGE_ORDER)), STAGE_ORDER)
        ax_stage.invert_yaxis()
        ax_stage.set_ylabel("Phase (Fitbit)")
    if m.spo2.notna().any():
        ax_spo2.plot(m.index, m.spo2, ".", ms=3)
        ax_spo2.axhline(LOW_SPO2, color="tab:red", lw=0.8, ls="--")
        for _, e in episodes.iterrows():
            ax_spo2.axvspan(e.start, e.end, color="tab:orange" if "Artefakt" in e.verdict else "tab:red",
                            alpha=0.25)
        ax_spo2.set_ylabel("SpO2 %")
