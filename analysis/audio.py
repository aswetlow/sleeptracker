#!/usr/bin/env python3
"""
Audio reference from the phone for one SleepLogger night.

    python audio.py <session-folder> <recording.m4a|wav> [--start "2026-10-30 23:05:12"]

Run analyze.py on the same session folder first; this script then compares the watch's
breathing rate and heart-rate spikes with what can be heard in the audio.

Detects per second: audible breathing, snoring, loud events; from that the breathing rate
(2-min windows), breathing pause candidates (10–120 s of silence right after audible breathing)
and loud events (coughing, talking, gasping, clapping).

Synchronisation: start time from --start, file metadata or file name; then fine alignment
via the clap at the beginning (bang in the audio ↔ spike in the accelerometer).

m4a/mp3 need ffmpeg on PATH (Windows: `winget install Gyan.FFmpeg` or `scoop install ffmpeg`).
WAV works without it.
"""
import argparse
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
from scipy import signal

import analyze as A

SR = 4000                    # enough for breathing sounds (<2 kHz) and snoring
FRAME = 400                  # 100 ms
FRAME_HZ = SR / FRAME
LOW_BAND = (60, 400)         # snoring fundamental
BREATH_BAND = (400, 1800)    # breathing sound (noise)
FLOOR_WINDOW_S = 300
AUDIBLE_DB = 6               # breathing band above noise floor = audible breathing
SNORE_DB = 15                # low band above noise floor
LOUD_DB = 30                 # broadband above noise floor (breathing is usually at 5–20 dB)
PAUSE_MIN_S = 10
PAUSE_MAX_S = 120            # longer = breathing just too quiet, not a pause
PAUSE_CONTEXT_S = 20         # breathing must have been audible right before
PAUSE_CONTEXT_SHARE = 0.4
CLAP_DB = 40
SNORE_TRAIN = 3              # snores only count in series at breathing rhythm …
SNORE_INTERVAL_S = (2.5, 8)  # … with this spacing; single low sounds are mostly rustling
CLAP_SEARCH_S = 15 * 60
CLAP_MAX_OFFSET_S = 20       # phone and watch clocks are network-synced; a larger offset = wrong pair
TZ = ZoneInfo("Europe/Berlin")


# ---------- decoding ----------

def pcm_chunks(path: Path, chunk_s=60):
    """Yields mono samples (float32, SR Hz) in blocks without loading the whole night into RAM."""
    n = SR * chunk_s
    if shutil.which("ffmpeg"):
        proc = subprocess.Popen(
            ["ffmpeg", "-v", "error", "-i", str(path), "-ac", "1", "-ar", str(SR),
             "-f", "s16le", "-"], stdout=subprocess.PIPE)
        while True:
            buf = proc.stdout.read(n * 2)
            if not buf:
                break
            yield np.frombuffer(buf, dtype="<i2").astype(np.float32) / 32768
        proc.wait()
        return
    if path.suffix.lower() != ".wav":
        raise SystemExit("ffmpeg not found – install it for m4a/mp3 or export as WAV.")
    from scipy.io import wavfile
    rate, data = wavfile.read(path, mmap=True)
    step = rate * chunk_s
    for i in range(0, len(data), step):
        x = np.asarray(data[i:i + step], dtype=np.float32)
        if x.ndim > 1:
            x = x.mean(axis=1)
        if np.issubdtype(data.dtype, np.integer):
            x /= np.iinfo(data.dtype).max
        g = np.gcd(SR, rate)
        yield signal.resample_poly(x, SR // g, rate // g).astype(np.float32)


def frame_features(path: Path):
    """Per 100-ms frame: total, low-band and breathing-band level in dB."""
    freqs = np.fft.rfftfreq(FRAME, 1 / SR)
    low = (freqs >= LOW_BAND[0]) & (freqs < LOW_BAND[1])
    breath = (freqs >= BREATH_BAND[0]) & (freqs < BREATH_BAND[1])
    win = np.hanning(FRAME).astype(np.float32)
    rest = np.empty(0, np.float32)
    out = []
    for chunk in pcm_chunks(path):
        x = np.concatenate([rest, chunk])
        k = len(x) // FRAME
        rest = x[k * FRAME:]
        frames = x[:k * FRAME].reshape(k, FRAME)
        p = np.abs(np.fft.rfft(frames * win, axis=1)) ** 2
        db = lambda m: 10 * np.log10(p[:, m].sum(axis=1) + 1e-12)
        out.append(np.column_stack([10 * np.log10((frames ** 2).mean(axis=1) + 1e-12),
                                    db(low), db(breath)]))
    if not out:
        raise SystemExit(f"No audio data in {path}")
    return np.vstack(out)


# ---------- start time ----------

# German month abbreviations, as written by the Pixel recorder on a German phone

GERMAN_MONTHS = {"jan": 1, "feb": 2, "mär": 3, "mar": 3, "apr": 4, "mai": 5, "jun": 6, "jul": 7,
                 "aug": 8, "sep": 9, "okt": 10, "nov": 11, "dez": 12}


def name_time(stem: str, year: int):
    """Start time from the file name: ISO-like or like the German Pixel recorder ("30. Okt. um 22-49")."""
    m = re.search(r"(\d{4})-?(\d{2})-?(\d{2})[ _T-]?(\d{2})[.:-]?(\d{2})[.:-]?(\d{2})", stem)
    if m:
        return datetime(*map(int, m.groups()), tzinfo=TZ)
    m = re.search(r"(\d{1,2})\.\s*([A-Za-zä]{3})\w*\.?\s*(?:um\s*)?(\d{1,2})[-:.](\d{2})(?:[-:.](\d{2}))?",
                  stem)
    if m and m.group(2).lower() in GERMAN_MONTHS:
        d, mon, h, mi, sec = m.groups()
        return datetime(year, GERMAN_MONTHS[mon.lower()], int(d), int(h), int(mi), int(sec or 0),
                        tzinfo=TZ)
    return None


def audio_start(path: Path, cli_start: str | None, duration_s: float, watch_start_ms=None):
    """
    Collects candidates for the recording start and takes the one closest to the watch start.
    Needed because phones write creation_time sometimes as the start, sometimes as the end of the recording
    (the Pixel recorder writes the end).
    """
    if cli_start:
        return datetime.fromisoformat(cli_start).replace(tzinfo=TZ), "--start"
    cands = []
    if shutil.which("ffprobe"):
        meta = subprocess.run(["ffprobe", "-v", "error", "-show_entries", "format_tags",
                               "-of", "json", str(path)], capture_output=True, text=True)
        tags = json.loads(meta.stdout or "{}").get("format", {}).get("tags", {})
        ct = tags.get("creation_time") or tags.get("date")
        if ct and not ct.startswith("1970"):
            try:
                t = datetime.fromisoformat(ct.replace("Z", "+00:00"))
                cands += [(t, "metadata (start)"),
                          (datetime.fromtimestamp(t.timestamp() - duration_s, tz=timezone.utc),
                           "metadata (end − duration)")]
            except ValueError:
                pass
    mtime_end = datetime.fromtimestamp(os.path.getmtime(path), tz=timezone.utc)
    ref_year = (cands[0][0] if cands else mtime_end).astimezone(TZ).year
    t = name_time(path.stem, ref_year)
    if t:
        cands.insert(0, (t, "file name"))
    cands.append((datetime.fromtimestamp(mtime_end.timestamp() - duration_s, tz=timezone.utc),
                  "file time (inaccurate)"))
    if watch_start_ms is None:
        return cands[0]
    return min(cands, key=lambda c: abs(c[0].timestamp() * 1000 - watch_start_ms))


def clap_offset_ms(frame_ms, rel_db, session: Path):
    """Clap in the audio (first very loud bang) against the largest accelerometer spike nearby."""
    first = frame_ms < frame_ms[0] + CLAP_SEARCH_S * 1000
    cand = np.where(first & (rel_db > CLAP_DB))[0]
    if not len(cand):
        return None
    t_audio = frame_ms[cand[np.argmax(rel_db[cand])]]
    acc = pd.read_csv(session / "accel.csv")
    win = CLAP_MAX_OFFSET_S * 1000
    near = acc[(acc.epoch_ms > t_audio - win) & (acc.epoch_ms < t_audio + win)]
    if len(near) < 10:
        return None
    jerk = np.linalg.norm(np.diff(near[["x", "y", "z"]].values, axis=0), axis=1)
    if jerk.max() < 5:  # m/s² jump between two samples, otherwise not a real clap
        return None
    t_watch = near.epoch_ms.values[1:][np.argmax(jerk)]
    off = float(t_watch - t_audio)
    return off if abs(off) <= CLAP_MAX_OFFSET_S * 1000 else None


# ---------- analysis ----------

def runs(mask):
    """Start/end (exclusive) of contiguous True runs."""
    d = np.diff(np.concatenate([[0], mask.astype(np.int8), [0]]))
    return np.column_stack([np.where(d == 1)[0], np.where(d == -1)[0]])


def analyse(feat, t0_ms):
    n = len(feat)
    frame_ms = t0_ms + np.arange(n) * 1000 / FRAME_HZ
    total, low, breath = feat.T

    # noise floor: low percentile over 5 min, computed on a 1-s basis (fast enough)
    def floor(x):
        sec = pd.Series(x[: n // 10 * 10].reshape(-1, 10).min(axis=1))
        f = sec.rolling(FLOOR_WINDOW_S, center=True, min_periods=30).quantile(0.1)
        return np.repeat(f.bfill().ffill().values, 10)[:n] if len(f) else x

    pad = lambda a: np.concatenate([a, np.full(n - len(a), a[-1] if len(a) else 0)])
    f_total, f_low, f_breath = (pad(floor(x)) for x in (total, low, breath))
    rel_total, rel_low, rel_breath = total - f_total, low - f_low, breath - f_breath

    snore_f = (rel_low > SNORE_DB) & (low - breath > 3)
    loud_f = (rel_total > LOUD_DB) & ~snore_f

    # per second
    k = n // 10
    sec = lambda a, how: getattr(a[:k * 10].reshape(k, 10), how)(axis=1)
    per_s = pd.DataFrame({
        "epoch_ms": frame_ms[:k * 10:10],
        "db_total": sec(total, "mean"), "db_breath_rel": sec(rel_breath, "max"),
        "db_low_rel": sec(rel_low, "max"),
        "audible_breath": sec(rel_breath, "max") > AUDIBLE_DB,
        "snore": sec(snore_f, "any"), "loud": sec(loud_f, "any"),
    })

    events = []
    sn = np.array([(frame_ms[a], frame_ms[b - 1]) for a, b in runs(snore_f) if 3 <= b - a <= 40])
    if len(sn):
        ok = (np.diff(sn[:, 0]) >= SNORE_INTERVAL_S[0] * 1000) & (np.diff(sn[:, 0]) <= SNORE_INTERVAL_S[1] * 1000)
        keep = np.zeros(len(sn), bool)
        for a, b in runs(ok):          # b - a gaps = b - a + 1 snores in a row
            if b - a + 1 >= SNORE_TRAIN:
                keep[a:b + 1] = True
        events += [("snore", x, y, "") for x, y in sn[keep]]
    for a, b in runs(loud_f):
        events.append(("loud", frame_ms[a], frame_ms[b - 1], f"{rel_total[a:b].max():.0f} dB"))

    # pauses: 10–120 s of nothing audible, audible breathing right before
    aud = per_s.audible_breath.values
    for a, b in runs(~aud):
        if not PAUSE_MIN_S <= b - a <= PAUSE_MAX_S or a < PAUSE_CONTEXT_S:
            continue
        if aud[a - PAUSE_CONTEXT_S:a].mean() < PAUSE_CONTEXT_SHARE:
            continue
        end_loud = per_s.loud.values[b:b + 5].any() or per_s.snore.values[b:b + 5].any()
        events.append(("pause", per_s.epoch_ms[a], per_s.epoch_ms[b - 1] + 1000,
                       f"{b - a} s" + (", ends loud" if end_loud else "")))
    ev = pd.DataFrame(events, columns=["type", "start_ms", "end_ms", "detail"]) \
        .sort_values("start_ms", ignore_index=True)

    # breathing rate from the envelope of the breathing band
    env = pd.Series(np.maximum(rel_breath, 0)).rolling(3, center=True, min_periods=1).mean().values
    sos = signal.butter(2, A.BREATH_BAND_HZ, btype="band", fs=FRAME_HZ, output="sos")
    w, step = int(A.BREATH_WINDOW_S * FRAME_HZ), int(A.BREATH_STEP_S * FRAME_HZ)
    rows = []
    for i in range(0, n - w, step):
        seg_aud = aud[i // 10:(i + w) // 10]
        if seg_aud.mean() < 0.5 or loud_f[i:i + w].mean() > 0.05:
            continue
        rate, q = A.autocorr_rate(signal.sosfiltfilt(sos, env[i:i + w] - env[i:i + w].mean()), FRAME_HZ)
        if not np.isnan(rate):
            rows.append({"epoch_ms": frame_ms[i + w // 2], "breaths_per_min": rate, "quality": q})
    br = pd.DataFrame(rows)
    return per_s, ev, br, frame_ms, rel_total


def compare(session: Path, br_audio, ev, lines):
    p = session / "breathing.csv"
    if p.exists() and not br_audio.empty:
        w = pd.read_csv(p)
        if not w.empty:
            ref = br_audio[br_audio.quality >= A.BREATH_MIN_QUALITY].sort_values("epoch_ms")
            m = pd.merge_asof(w.sort_values("epoch_ms"), ref, on="epoch_ms",
                              direction="nearest", tolerance=15_000, suffixes=("", "_audio"))
            m = m.dropna(subset=["breaths_per_min_audio"])
            if len(m):
                m["err"] = (m.breaths_per_min - m.breaths_per_min_audio).abs()
                lines.append(f"Watch vs. audio breathing rate ({len(m)} shared windows):")
                for lo, hi in ((0, .2), (.2, .4), (.4, .6), (.6, .8), (.8, 1.01)):
                    s = m[(m.quality >= lo) & (m.quality < hi)]
                    if len(s):
                        lines.append(f"  watch quality {lo:.1f}–{min(hi, 1):.1f}: n={len(s)}, "
                                     f"mean error {s.err.mean():.1f}/min, "
                                     f"≤2/min: {(s.err <= 2).mean() * 100:.0f} %")
                lines.append("  → set BREATH_MIN_QUALITY where the error becomes small.")
                m.to_csv(session / "breathing_vs_audio.csv", index=False)

    p = session / "cvhr_peaks.csv"
    pauses = ev[ev.type == "pause"]
    if p.exists() and p.stat().st_size > 1:
        pk = pd.read_csv(p)
        if len(pk) and len(pauses):
            ends = pauses.end_ms.values
            hit = lambda t: ((t - ends >= -5000) & (t - ends <= 20000)).any()
            share = np.mean([hit(t) for t in pk.epoch_ms])
            grid = np.arange(pk.epoch_ms.min(), pk.epoch_ms.max(), 5000)
            chance = np.mean([hit(t) for t in grid]) if len(grid) else 0
            lines.append(f"HR spikes shortly after an audible breathing pause: {share * 100:.0f} % "
                         f"(chance level {chance * 100:.0f} %, n={len(pk)})")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", type=Path)
    ap.add_argument("audio", type=Path)
    ap.add_argument("--start", help='local start time of the recording, e.g. "2026-10-30 23:05:12"')
    ap.add_argument("--no-clap", action="store_true", help="no fine synchronisation via clap")
    ap.add_argument("--skip-min", type=float, default=0,
                    help="ignore the first N minutes (falling asleep, audiobook, talking)")
    args = ap.parse_args()

    print("Reading audio …")
    feat = frame_features(args.audio)
    dur_s = len(feat) / FRAME_HZ
    acc_path = args.session / "accel.csv"
    watch_start = float(pd.read_csv(acc_path, nrows=1).epoch_ms[0]) if acc_path.exists() else None
    start, how = audio_start(args.audio, args.start, dur_s, watch_start)
    t0 = start.timestamp() * 1000
    per_s, ev, br, frame_ms, rel_total = analyse(feat, t0)

    lines = [f"Audio: {dur_s / 3600:.2f} h, Start {start.astimezone(TZ):%Y-%m-%d %H:%M:%S} ({how})"]
    off = None if args.no_clap or not (args.session / "accel.csv").exists() \
        else clap_offset_ms(frame_ms, rel_total, args.session)
    if off is not None:
        lines.append(f"Clap synchronisation: audio shifted by {off / 1000:+.2f} s")
        per_s["epoch_ms"] += off
        ev[["start_ms", "end_ms"]] += off
        if not br.empty:
            br["epoch_ms"] += off
    else:
        lines.append("Clap synchronisation: not found clearly, start time from file (± a few s)")

    # ignore the beginning and drop sounds during watch movement (rustling ≠ snoring/pause)
    cut = per_s.epoch_ms.iloc[0] + args.skip_min * 60_000
    per_s = per_s[per_s.epoch_ms >= cut]
    ev = ev[ev.start_ms >= cut]
    if not br.empty:
        br = br[br.epoch_ms >= cut]
    mv_path = args.session / "movement_events.csv"
    if mv_path.exists() and mv_path.stat().st_size > 1:
        mv = pd.read_csv(mv_path)[["start_ms", "end_ms"]].values
        during = [((mv[:, 0] - 2000 <= e) & (mv[:, 1] + 2000 >= s)).any()
                  for s, e in zip(ev.start_ms, ev.end_ms)]
        dropped = ev[np.array(during, bool) & ev.type.isin(["snore", "pause"])]
        ev = ev.drop(dropped.index)
        if len(dropped):
            lines.append(f"Dropped due to simultaneous movement: {len(dropped)} snores/pauses")
    dur_s = len(per_s)
    hours = max(dur_s / 3600, 1e-9)
    counts = ev.type.value_counts()
    good = br[br.quality >= A.BREATH_MIN_QUALITY] if not br.empty else br
    lines += [
        f"Breathing audible: {per_s.audible_breath.mean() * 100:.0f} % of the time",
        f"Snores: {counts.get('snore', 0)} ({counts.get('snore', 0) / hours:.0f}/h)",
        f"Breathing pause candidates ({PAUSE_MIN_S}–{PAUSE_MAX_S} s): {counts.get('pause', 0)} "
        f"({counts.get('pause', 0) / hours:.1f}/h), of which ended loud: "
        f"{ev[ev.type == 'pause'].detail.str.contains('loud').sum()}",
        f"Loud events: {counts.get('loud', 0)}",
        f"Breathing rate from audio: {len(good)} windows" +
        (f", median {good.breaths_per_min.median():.1f}/min" if len(good) else ""),
        "Note: quiet breathing is often inaudible – a pause here is a candidate, not a finding.",
    ]
    compare(args.session, br, ev, lines)

    summary = "\n".join(lines)
    print(summary)
    (args.session / "audio_summary.txt").write_text(summary + "\n")
    per_s.to_csv(args.session / "audio_per_second.csv", index=False)
    ev.to_csv(args.session / "audio_events.csv", index=False)
    br.to_csv(args.session / "audio_breathing.csv", index=False)


if __name__ == "__main__":
    main()
