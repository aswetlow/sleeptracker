#!/usr/bin/env python3
"""
Sleep position from the watch accelerometer, calibrated per person.

The watch only sees how the WRIST lies, not the torso. So the model is personal: during a
recording tap Back / Left / Right / Stomach on the watch (events.csv: "pose <label>"), lie still
until it buzzes (25 s), and repeat every position with 2–4 different arm placements.

    python position.py calibrate <session> [<session> ...] [--model pose_model.json]
    python position.py classify  <session> [--model pose_model.json] [--plot]
    python position.py validate  <session> --phone <folder|csv> [--model ...] [--offset-s N] [--plot]

calibrate  collects one template (gravity direction of the wrist) per calibration tap and adds it to
           the model file. Taps in the night's own session are always used as well.
classify   splits the night at movement events (same detector as analyze.py), assigns each still
           segment the position of the closest template and writes positions.csv,
           position_summary.txt and, if analyze.py ran before, per-position statistics
           (heart-rate spike episodes, breathing, SpO2, sleep stages).
validate   compares this with a phone on the chest as ground truth (e.g. Sensor Logger export:
           Gravity.csv / TotalAcceleration.csv). The phone's position comes from the same
           calibration taps, or, without taps, from its axes (screen facing out, top edge
           towards the head).
"""
import argparse
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).parent))
import analyze as A  # noqa: E402

TZ = "Europe/Berlin"
LABELS = ["back", "left", "right", "stomach"]
POSE_SKIP_S, POSE_HOLD_S = 5, 25     # template window after the tap (watch buzzes at 25 s)
POSE_MAX_SPREAD_DEG = 12             # wrist moved during the hold -> template discarded
MAX_ANGLE_DEG = 35                   # farther from every template -> "unknown"
MIN_MARGIN_DEG = 8                   # closer than this to a second position -> "uncertain"
MIN_SEGMENT_S = 20
EPOCH_S = 30                         # validation resolution
CALIB_EXCLUDE_S = 60                 # validation ignores the calibration phase (trivially right)
# phone on the sternum, screen facing out, top edge towards the head (Android axes):
# back = screen up (+z), stomach = -z, right side = +x up, left side = -x up
PHONE_AXES = {"back": (0, 0, 1), "stomach": (0, 0, -1), "right": (1, 0, 0), "left": (-1, 0, 0),
              "upright": (0, 1, 0)}


def unit(v):
    v = np.asarray(v, float)
    return v / (np.linalg.norm(v, axis=-1, keepdims=True) + 1e-12)


def angle_deg(a, b):
    return np.degrees(np.arccos(np.clip(np.sum(unit(a) * unit(b), axis=-1), -1, 1)))


def local(ms):
    return pd.to_datetime(ms, unit="ms", utc=True).tz_convert(TZ)


# ---------------------------------------------------------------- calibration

def pose_markers(session: Path):
    p = session / "events.csv"
    if not p.exists():
        return pd.DataFrame(columns=["epoch_ms", "label"])
    ev = pd.read_csv(p)
    ev = ev[ev.event.astype(str).str.startswith("pose ")]
    return pd.DataFrame({"epoch_ms": ev.epoch_ms.values,
                         "label": ev.event.str.split().str[1].values})


def templates_from(markers: pd.DataFrame, t_ms: np.ndarray, xyz: np.ndarray, source: str):
    """One template per tap: median gravity direction 5–25 s after it, if the wrist stayed still."""
    out, rejected = [], []
    for _, m in markers.iterrows():
        sel = (t_ms >= m.epoch_ms + POSE_SKIP_S * 1000) & (t_ms <= m.epoch_ms + POSE_HOLD_S * 1000)
        seg = xyz[sel]
        seg = seg[~np.isnan(seg).any(axis=1)]
        if len(seg) < 50:
            rejected.append((m.label, m.epoch_ms, "no data")); continue
        g = unit(np.median(seg, axis=0))
        spread = float(np.percentile(angle_deg(seg, g), 90))
        if spread > POSE_MAX_SPREAD_DEG:
            rejected.append((m.label, m.epoch_ms, f"moved ({spread:.0f}°)")); continue
        out.append({"label": m.label, "vector": [round(float(c), 4) for c in g],
                    "epoch_ms": int(m.epoch_ms), "source": source, "spread_deg": round(spread, 1)})
    return out, rejected


def load_model(path: Path):
    if path and path.exists():
        return json.loads(path.read_text())
    return {"version": 1, "wrist": "left", "templates": []}


def watch_templates(session: Path):
    acc = pd.read_csv(session / "accel.csv").sort_values("epoch_ms")
    return templates_from(pose_markers(session), acc.epoch_ms.values,
                          acc[["x", "y", "z"]].values, session.name)


def cmd_calibrate(args):
    model = load_model(args.model)
    have = {(t["source"], t["epoch_ms"]) for t in model["templates"]}
    for s in args.sessions:
        new, rejected = watch_templates(s)
        for lab, ms, why in rejected:
            print(f"  {s.name} {local(ms):%H:%M:%S} {lab}: discarded, {why}")
        added = [t for t in new if (t["source"], t["epoch_ms"]) not in have]
        model["templates"] += added
        print(f"{s.name}: {len(added)} new templates")
    model["wrist"] = args.wrist
    args.model.write_text(json.dumps(model, indent=1))
    print_model(model)
    print(f"Model: {args.model}")


def print_model(model):
    T = model["templates"]
    for lab in sorted({t["label"] for t in T}):
        print(f"  {lab:8s} {sum(t['label'] == lab for t in T)} templates")
    missing = [lab for lab in LABELS if lab not in {t["label"] for t in T}]
    if missing:
        print(f"  missing: {', '.join(missing)}")
    # templates of different positions that look the same -> the watch cannot tell them apart
    for i, a in enumerate(T):
        for b in T[i + 1:]:
            if a["label"] != b["label"]:
                d = angle_deg(a["vector"], b["vector"])
                if d < MIN_MARGIN_DEG * 2:
                    print(f"  warning: {a['label']} and {b['label']} templates only {d:.0f}° apart "
                          f"(arm placement looks the same in both positions)")


# ---------------------------------------------------------------- classification

def classify_vectors(vecs: np.ndarray, templates: list):
    """Nearest template by angle. Returns label, angle to it, margin to the next other position."""
    tv = unit(np.array([t["vector"] for t in templates]))
    tl = np.array([t["label"] for t in templates])
    labs = sorted(set(tl))
    ang = angle_deg(unit(vecs)[:, None, :], tv[None, :, :])          # (n, templates)
    per = np.column_stack([ang[:, tl == lab].min(axis=1) for lab in labs])
    order = np.argsort(per, axis=1)
    best = per[np.arange(len(per)), order[:, 0]]
    second = per[np.arange(len(per)), order[:, 1]] if len(labs) > 1 else np.full(len(per), 180.0)
    label = np.array(labs, dtype=object)[order[:, 0]]
    label[best > MAX_ANGLE_DEG] = "unknown"
    return label, best, second - best


def still_segments(session: Path, fs=25.0):
    acc, _, _ = A.load(session)
    grid = np.arange(acc.epoch_ms.iloc[0], acc.epoch_ms.iloc[-1], 1000.0 / fs)
    xyz = A.resample(acc, grid)
    events, _, _ = A.movement_events(grid, xyz, fs)
    bounds = [grid[0]]
    for _, e in events.iterrows():
        bounds += [e.start_ms, e.end_ms]
    bounds.append(grid[-1])
    rows = []
    for a, b in zip(bounds[0::2], bounds[1::2]):
        if (b - a) / 1000 < MIN_SEGMENT_S:
            continue
        seg = xyz[(grid >= a) & (grid < b)]
        seg = seg[~np.isnan(seg).any(axis=1)]
        if len(seg) < fs * 5:
            continue
        g = unit(np.median(seg, axis=0))
        rows.append({"start_ms": a, "end_ms": b, "x": g[0], "y": g[1], "z": g[2]})
    return pd.DataFrame(rows), events


def classify_session(session: Path, model_path: Path):
    model = load_model(model_path)
    own, _ = watch_templates(session)
    have = {(t["source"], t["epoch_ms"]) for t in model["templates"]}
    templates = model["templates"] + [t for t in own if (t["source"], t["epoch_ms"]) not in have]
    if len({t["label"] for t in templates}) < 2:
        sys.exit("Fewer than 2 calibrated positions. Calibrate first (see README, section 11).")
    seg, events = still_segments(session)
    lab, ang, margin = classify_vectors(seg[["x", "y", "z"]].values, templates)
    seg["position"] = lab
    seg["angle_deg"] = ang.round(1)
    seg["margin_deg"] = margin.round(1)
    seg["uncertain"] = (seg.position != "unknown") & (seg.margin_deg < MIN_MARGIN_DEG)
    seg["minutes"] = ((seg.end_ms - seg.start_ms) / 60000).round(2)
    return seg, templates, events


def per_minute_positions(seg: pd.DataFrame):
    """Position for every minute (the one covering most of that minute)."""
    rows = []
    for _, s in seg.iterrows():
        for m in range(int(s.start_ms // 60000), int(s.end_ms // 60000) + 1):
            a, b = max(s.start_ms, m * 60000), min(s.end_ms, (m + 1) * 60000)
            if b > a:
                rows.append((m * 60000, s.position, b - a))
    if not rows:
        return pd.Series(dtype=object)
    df = pd.DataFrame(rows, columns=["minute", "position", "ms"])
    df = df.sort_values("ms").drop_duplicates("minute", keep="last").set_index("minute").sort_index()
    return df.position


def position_stats(session: Path, seg: pd.DataFrame):
    lines = []
    total = seg.minutes.sum()
    lines.append(f"Classified still time: {total / 60:.2f} h in {len(seg)} segments")
    for pos, g in seg.groupby("position"):
        lines.append(f"  {pos:8s} {g.minutes.sum() / 60:5.2f} h ({g.minutes.sum() / total * 100:4.0f} %), "
                     f"{len(g)} segments, of which uncertain {g.uncertain.sum()}")
    pm_path = session / "per_minute.csv"
    if not pm_path.exists():
        lines.append("(run analyze.py first for per-position heart rate / breathing / SpO2)")
        return lines, None
    pm = pd.read_csv(pm_path)
    t = pd.to_datetime(pm.iloc[:, 0], utc=True)
    pm["minute"] = ((t - pd.Timestamp(0, tz="UTC")) // pd.Timedelta("1ms")).astype("int64")
    pos = per_minute_positions(seg[~seg.uncertain])
    pm["position"] = pm.minute.map(pos)
    pm = pm.dropna(subset=["position"])
    lines.append("")
    lines.append("Per position (uncertain segments left out):")
    cvhr_path = session / "cvhr_episodes.csv"
    cvhr = pd.read_csv(cvhr_path) if cvhr_path.exists() and cvhr_path.stat().st_size > 1 else pd.DataFrame()
    for p, g in pm.groupby("position"):
        h = len(g) / 60
        parts = [f"{h:4.1f} h"]
        if "movement_events" in g:
            parts.append(f"movements {g.movement_events.sum() / max(h, 1e-9):.1f}/h")
        if not cvhr.empty:
            mid = ((cvhr.start_ms + cvhr.end_ms) / 2 // 60000 * 60000).map(pos)
            sub = cvhr[mid == p]
            parts.append(f"HR spike episodes {len(sub)} ({sub.cycles.sum() / max(h, 1e-9):.1f} cycles/h)")
        if "breaths_per_min" in g and g.breaths_per_min.notna().any():
            parts.append(f"breathing {g.breaths_per_min.median():.1f}/min")
        if "hr_mean" in g and g.hr_mean.notna().any():
            parts.append(f"HR {g.hr_mean.median():.0f} bpm")
        if "spo2" in g and g.spo2.notna().any():
            parts.append(f"SpO2 median {g.spo2.median():.1f} %, <90 %: {(g.spo2 < 90).sum()} min")
        if "stage" in g and g.stage.notna().any():
            parts.append("stages " + " ".join(f"{k} {v * 100:.0f}%" for k, v in
                                              g.stage.value_counts(normalize=True).items()))
        lines.append(f"  {p:8s} " + ", ".join(parts))
    lines.append("Note: a position is only as good as the calibration; check it with "
                 "`position.py validate` (phone on the chest) before drawing conclusions.")
    return lines, pm


def cmd_classify(args):
    seg, templates, _ = classify_session(args.session, args.model)
    lines = [f"Templates: {len(templates)} ("
             + ", ".join(f"{lab} {sum(t['label'] == lab for t in templates)}"
                         for lab in sorted({t['label'] for t in templates})) + ")"]
    stats, _ = position_stats(args.session, seg)
    lines += stats
    text = "\n".join(lines)
    print(text)
    (args.session / "position_summary.txt").write_text(text + "\n")
    seg.to_csv(args.session / "positions.csv", index=False)
    if args.plot:
        plot_positions(args.session / "positions.png", [("watch", seg)])


# ---------------------------------------------------------------- phone reference

def read_xyz_csv(path: Path):
    df = pd.read_csv(path)
    cols = {c.lower().strip(): c for c in df.columns}
    tcol = next((cols[c] for c in ("epoch_ms", "time", "timestamp", "epoch", "t") if c in cols), df.columns[0])
    if not all(c in cols for c in "xyz"):
        sys.exit(f"{path}: needs columns x, y, z")
    t = df[tcol].astype(float).values
    med = np.nanmedian(t)
    t = t / 1e6 if med > 1e17 else t / 1e3 if med > 1e14 else t if med > 1e11 else t * 1000
    out = pd.DataFrame({"epoch_ms": t, "x": df[cols["x"]], "y": df[cols["y"]], "z": df[cols["z"]]})
    return out.dropna().sort_values("epoch_ms")


def load_phone(path: Path):
    """Returns (orientation data, activity data); both epoch_ms,x,y,z in m/s²."""
    if path.is_file():
        d = read_xyz_csv(path)
        return d, d
    files = {p.name.lower(): p for p in path.iterdir()}
    grav = next((files[n] for n in ("gravity.csv", "totalacceleration.csv", "accelerometer.csv", "accel.csv")
                 if n in files), None)
    if grav is None:
        sys.exit(f"{path}: no Gravity.csv / TotalAcceleration.csv / Accelerometer.csv")
    act = next((files[n] for n in ("totalacceleration.csv", "accelerometer.csv", "accel.csv") if n in files), grav)
    g, a = read_xyz_csv(grav), read_xyz_csv(act)
    if np.median(np.linalg.norm(g[["x", "y", "z"]].values, axis=1)) < 5:
        sys.exit(f"{grav.name} has gravity removed; export Gravity or TotalAcceleration as well")
    return g, a


def activity_1hz(df: pd.DataFrame, t0, t1):
    sec = ((df.epoch_ms - t0) // 1000).astype(int)
    mag = np.linalg.norm(df[["x", "y", "z"]].values, axis=1)
    s = pd.Series(mag).groupby(sec.values).std()
    return s.reindex(range(int((t1 - t0) // 1000))).fillna(0).values


def estimate_offset_s(watch: pd.DataFrame, phone: pd.DataFrame, max_lag=120):
    """Lag (s) to add to phone times so roll-overs line up. 0 if nothing clear."""
    t0 = max(watch.epoch_ms.iloc[0], phone.epoch_ms.iloc[0])
    t1 = min(watch.epoch_ms.iloc[-1], phone.epoch_ms.iloc[-1])
    if t1 - t0 < 600_000:
        return 0, 0.0
    w = np.log1p(activity_1hz(watch, t0, t1) * 10)
    p = np.log1p(activity_1hz(phone, t0, t1) * 10)
    w, p = (w - w.mean()) / (w.std() + 1e-9), (p - p.mean()) / (p.std() + 1e-9)
    best, best_c, cs = 0, -1.0, []
    for lag in range(-max_lag, max_lag + 1):
        a, b = (w[lag:], p[:len(p) - lag]) if lag >= 0 else (w[:lag], p[-lag:])
        c = float(np.mean(a * b))
        cs.append(c)
        if c > best_c:
            best, best_c = lag, c
    cs = np.array(cs)
    # only trust a clear peak
    return (best, best_c) if best_c > 0.15 and best_c > np.median(cs) + 2 * cs.std() else (0, best_c)


def epoch_vectors(df: pd.DataFrame, t0, t1):
    e = ((df.epoch_ms - t0) // (EPOCH_S * 1000)).astype(int)
    g = df.groupby(e.values)[["x", "y", "z"]].median()
    n = int((t1 - t0) // (EPOCH_S * 1000))
    return g.reindex(range(n))


def cmd_validate(args):
    seg, templates, events = classify_session(args.session, args.model)
    watch = pd.read_csv(args.session / "accel.csv").sort_values("epoch_ms")
    pg, pa = load_phone(args.phone)
    if args.offset_s is None:
        off, c = estimate_offset_s(watch, pa)
        print(f"Clock offset phone→watch: {off:+d} s (correlation {c:.2f})" +
              ("" if off else " – using 0, pass --offset-s if you know it"))
    else:
        off = args.offset_s
    pg = pg.assign(epoch_ms=pg.epoch_ms + off * 1000)

    # phone = ground truth: from the same calibration taps, else from its axes
    markers = pose_markers(args.session)
    ptemps, _ = templates_from(markers, pg.epoch_ms.values, pg[["x", "y", "z"]].values, "phone")
    if len({t["label"] for t in ptemps}) >= 2:
        how = f"phone templates from {len(ptemps)} calibration taps"
    else:
        ptemps = [{"label": k, "vector": list(v)} for k, v in PHONE_AXES.items()]
        how = "phone axes (screen facing out, top edge towards the head)"
    print(f"Ground truth: {how}")

    t0 = max(watch.epoch_ms.iloc[0], pg.epoch_ms.iloc[0])
    t1 = min(watch.epoch_ms.iloc[-1], pg.epoch_ms.iloc[-1])
    pv = epoch_vectors(pg, t0, t1).dropna()
    truth, tang, _ = classify_vectors(pv.values, ptemps)
    truth = pd.Series(truth, index=pv.index)
    truth[tang > 45] = "unknown"

    mid = t0 + (np.arange(int((t1 - t0) // (EPOCH_S * 1000))) + 0.5) * EPOCH_S * 1000
    pred = pd.Series("moving", index=range(len(mid)), dtype=object)
    for _, s in seg.iterrows():
        sel = (mid >= s.start_ms) & (mid < s.end_ms)
        pred[sel] = "uncertain" if s.uncertain else s.position
    calib = np.zeros(len(mid), bool)
    for ms in markers.epoch_ms:
        calib |= (mid >= ms - CALIB_EXCLUDE_S * 1000) & (mid <= ms + (POSE_HOLD_S + CALIB_EXCLUDE_S) * 1000)

    df = pd.DataFrame({"epoch_ms": mid, "truth": truth.reindex(range(len(mid))), "watch": pred,
                       "calibration": calib})
    df.to_csv(args.session / "position_validation.csv", index=False)
    ev = df[~df.calibration & df.truth.isin(LABELS)]
    scored = ev[ev.watch.isin(LABELS)]
    lines = [
        f"Validation: {len(ev) * EPOCH_S / 3600:.2f} h with a clear torso position "
        f"(calibration phase left out), {EPOCH_S}-s epochs",
        f"  watch gives a position in {len(scored) / max(len(ev), 1) * 100:.0f} % "
        f"(rest: moving / unknown / uncertain)",
        f"  of those correct: {(scored.truth == scored.watch).mean() * 100:.0f} %" if len(scored) else
        "  no epochs to score",
    ]
    if len(scored):
        cm = pd.crosstab(scored.truth, scored.watch, rownames=["torso (phone)"], colnames=["watch"])
        lines += ["", "Confusion (epochs):", cm.to_string()]
        # the question that matters for positional therapy: back vs. not back
        tb, wb = scored.truth == "back", scored.watch == "back"
        if tb.any():
            lines += ["", f"Back position: detected {(tb & wb).sum() / tb.sum() * 100:.0f} % of the real "
                      f"back time, false alarms {(~tb & wb).sum() / max((~tb).sum(), 1) * 100:.0f} % of the rest"]
        lines.append(f"Chance level (always the most common position): "
                     f"{scored.truth.value_counts(normalize=True).iloc[0] * 100:.0f} %")
    text = "\n".join(lines)
    print(text)
    (args.session / "position_validation.txt").write_text(text + "\n")
    if args.plot:
        tr = df.assign(start_ms=df.epoch_ms - EPOCH_S * 500, end_ms=df.epoch_ms + EPOCH_S * 500,
                       position=df.truth.fillna("unknown"))
        plot_positions(args.session / "position_validation.png", [("watch", seg), ("phone (torso)", tr)])


# ---------------------------------------------------------------- plot

COLORS = {"back": "tab:red", "left": "tab:blue", "right": "tab:green", "stomach": "tab:purple",
          "unknown": "lightgrey", "upright": "black"}


def plot_positions(out: Path, tracks):
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(14, 1.2 + 0.8 * len(tracks)))
    for i, (name, seg) in enumerate(tracks):
        for _, s in seg.iterrows():
            ax.barh(i, (s.end_ms - s.start_ms) / 86_400_000, left=local(s.start_ms),
                    color=COLORS.get(s.position, "lightgrey"),
                    alpha=0.4 if s.get("uncertain", False) else 1.0, height=0.7)
    ax.set_yticks(range(len(tracks)), [n for n, _ in tracks])
    ax.legend(handles=[plt.Rectangle((0, 0), 1, 1, color=c) for c in COLORS.values()],
              labels=list(COLORS), ncol=len(COLORS), loc="upper center", bbox_to_anchor=(0.5, -0.25))
    fig.tight_layout()
    fig.savefig(out, dpi=120)
    print(f"Plot: {out}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    default_model = Path(__file__).resolve().parents[2] / "sessions" / "pose_model.json"
    c = sub.add_parser("calibrate")
    c.add_argument("sessions", type=Path, nargs="+")
    c.add_argument("--model", type=Path, default=default_model)
    c.add_argument("--wrist", choices=["left", "right"], default="left")
    k = sub.add_parser("classify")
    k.add_argument("session", type=Path)
    k.add_argument("--model", type=Path, default=default_model)
    k.add_argument("--plot", action="store_true")
    v = sub.add_parser("validate")
    v.add_argument("session", type=Path)
    v.add_argument("--phone", type=Path, required=True)
    v.add_argument("--model", type=Path, default=default_model)
    v.add_argument("--offset-s", type=int, default=None)
    v.add_argument("--plot", action="store_true")
    args = ap.parse_args()
    {"calibrate": cmd_calibrate, "classify": cmd_classify, "validate": cmd_validate}[args.cmd](args)


if __name__ == "__main__":
    main()
