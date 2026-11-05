# SleepLogger for Pixel Watch 1

A Wear OS app that writes acceleration and gyroscope (25 Hz each) and heart rate (~1 Hz) with timestamps
to CSV at night, plus Python scripts for analysis.

## 1. Prepare the watch
1. Settings › System › About › Versions › tap **Build number** 7×.
2. Settings › Developer options › turn on **ADB debugging** and **Wireless debugging**.
3. Put the watch and the computer on the same Wi-Fi. Under "Wireless debugging" › **Pair new device**:
   ```
   adb pair <IP>:<pairing-port> <code>
   adb connect <IP>:<debug-port>      # the port is shown at the top under "Wireless debugging"
   adb devices
   ```

## 2. Build and install the app
- Open the folder in Android Studio and wait for the Gradle sync (downloads SDK 35 if missing).
- Pick the watch as the target device at the top, **Run**. Or from a terminal: `./gradlew installDebug`.
- Open the app on the watch, **Start**, allow the permissions. It runs as long as the notification is shown.
- In the morning open the app, **Stop**.

Tip: turn wireless debugging off at night, and do a 30-minute test before the first night.

## 3. Export the data
The files are in the app's private folder; with a debug build you can reach them via `run-as`:
```
adb devices          # with Wi-Fi debugging the watch often shows up twice -> pick one with -s <name>
adb -s <IP:port> shell run-as de.alex.sleeplogger ls files/sessions
```
Export (on Windows via `cmd`, because PowerShell's `>` corrupts binary data as UTF-16):
```
cmd /c "adb -s <IP:port> exec-out run-as de.alex.sleeplogger tar c -C files sessions > sessions.tar"
tar xf sessions.tar
```
Concretely for Alex's watch (the port changes whenever wireless debugging restarts; look up the current
port under "Wireless debugging" on the watch or with `adb devices`):
```
cmd /c "adb -s 192.168.178.35:44691 exec-out run-as de.alex.sleeplogger tar c -C files sessions > sessions.tar"
```

Fetch a single night instead of all:
```
cmd /c "adb -s <IP:port> exec-out run-as de.alex.sleeplogger tar c -C files sessions/20261103_225540 > session.tar"
tar xf session.tar
```

Clean up on the watch (permanent – first check that the night is in your local `sessions\`):
```
adb -s <IP:port> shell run-as de.alex.sleeplogger rm -r files/sessions/20261030_224900   # one night
adb -s <IP:port> shell run-as de.alex.sleeplogger rm -r files/sessions                   # all (not during a recording)
```
The `sessions` folder is recreated automatically on the next start.

Each night produces `sessions/<start time>/` with:
- `accel.csv` – `epoch_ms,x,y,z` (m/s², including gravity)
- `gyro.csv` – `epoch_ms,x,y,z` (rad/s)
- `hr.csv` – `epoch_ms,bpm,accuracy` (accuracy 0–3, <2 is discarded in the analysis)
- `events.csv` – start/stop, sensors used, whether a wake-up sensor/wakelock was active, battery level every 10 min

Size: ~25 MB per 8 h and sensor CSV.

## 4. Analysis
```
pip install -r analysis/requirements.txt
python analysis/analyze.py sessions/20261030_230512 --plot
```
Results in the session folder:
- `summary.txt` – overview
- `movement_events.csv` – start, duration, posture change in degrees, heart rate before / peak after
- `breathing.csv` – breathing rate per 2-min window (every 30 s), quality 0–1, source (accel/gyro/both)
- `cvhr_episodes.csv` – episodes of periodic heart-rate spikes (see below)
- `per_minute.csv`, `night.png`

Tuning knobs at the top of the script: `THRESHOLD_K`, `MIN_THRESHOLD` (movement), `BREATH_MIN_QUALITY`,
`CVHR_MIN_RISE_BPM`, `CVHR_CYCLE_S`, `CVHR_MIN_CYCLES`.

### Fitbit export (optional)
If the session folder contains a `fitbit.json` (the night export with `"fitbit": {...}`), `analyze.py`
reads it automatically (or `--fitbit path/to/file`). That adds:
- the watch's breathing rate per sleep stage next to the Fitbit values, heart-rate comparison, movement per stage
- SpO2: minutes below 90 %, desaturations, and `spo2_episodes.csv` with episodes of ≥5 min below 90 %.
  Each episode is checked for whether the arm stayed still, whether it ends with a movement
  and whether the heart rate reacts. All three = "probably a pose artifact" (e.g. arm pinned).
- room climate (tado), plot with hypnogram, Fitbit heart rate and SpO2

### Breathing rate
Only in quiet windows. Per sensor a band-pass of 0.1–0.5 Hz, principal component across all three axes,
period via autocorrelation. Quality = height of the autocorrelation peak. Pure noise scores
≤0.25 in tests, hence the threshold of 0.4. Gyro and accelerometer are estimated separately and
averaged when they agree; outliers against the smoothed trend are down-weighted.

### Periodic heart-rate spikes (CVHR)
At the end of a breathing pause there is typically a brief arousal with a heart-rate jump of 10–20 bpm.
If this repeats every 25–100 s at least 4 times, the script flags an episode, including the share
of spikes with simultaneous movement. This is a hint, not proof of apnea and not an AHI.

### Compare several nights
First analyse each night with `analyze.py`, then:
```
python nights.py ..\sessions\20261030_224900 ..\sessions\20261031_235707 ..\sessions\20261101_231037 --out nights.csv
```
One column per night: sleep and stages (Fitbit), HRV, resting heart rate, heart rate asleep and in deep sleep,
breathing rate per stage, movements/h, posture changes, SpO2, CVHR, battery, room climate, steps the day before.
For A/B comparisons (e.g. mouth tape) put a `notes.txt` into the session folder:
```
mouth_tape=yes
note=toilet 04:00
```

## 5. Audio reference from the phone (optional, but the biggest lever)
Without a reference the thresholds cannot be tuned seriously. The phone recording provides one.

**Recording:** any voice recorder app that records for hours with the screen off
(Pixel: "Recorder"). Phone on the bedside table, microphone towards your head, plugged in.
1. Start the watch app, then start the recording.
2. **Clap once firmly with the watch hand.** Bang in the audio + spike in the accelerometer
   = synchronisation to ~0.1 s.
3. In the morning stop both and put the audio file next to the session folder.

**Analysis** (m4a/mp3 need ffmpeg: `winget install Gyan.FFmpeg` or `scoop install ffmpeg`):
```
python analysis/analyze.py sessions/20261030_230512
python analysis/audio.py sessions/20261030_230512 "Recording.m4a"
```
The start time comes from the file metadata or the file name; if needed `--start "2026-10-30 23:05:12"`.

Result: `audio_summary.txt` plus CSVs:
- `audio_events.csv` – snores, breathing pause candidates (10–120 s of silence right after audible
  breathing, with "ends loud" for gasps/snores), loud events
- `audio_breathing.csv` – breathing rate from the breathing sound
- `breathing_vs_audio.csv` – watch against audio. The summary shows the error per
  watch quality level: set `BREATH_MIN_QUALITY` where the error becomes small.
- the share of heart-rate spikes that come shortly after an audible pause, with the chance level for comparison.

If you don't sleep alone, the other person is recorded too. Agree on it beforehand.

### Testing without a watch
```
python analysis/simulate.py testnight --audio
python analysis/analyze.py testnight --plot
python analysis/audio.py testnight "testnight/Recording 2025-10-30 19.46.27.wav"
```
Generates 3 h with breathing 15→12/min, three movements, a clap, a snoring phase, 20 apnea-like
cycles and a matching phone recording (~170 MB WAV).

## 6. Testing raw PPG data (experimental)
`adb shell dumpsys sensorservice` shows undocumented Google sensors on the Pixel Watch 1:
`com.google.wear.sensor.ppg` (PPG sensor, TI), `com.google.sensor.heart_rate_extended` and
`com.google.sensor.ppg_controller`. The **Start + PPG** button additionally records them raw
(`raw_ppg.csv`, `raw_hr_ext.csv`, `raw_ppg_ctrl.csv`, format `epoch_ms,accuracy,n,values` with
space-separated values) and writes `sensors.txt` listing all sensors.

Test briefly first, not overnight (data volume and battery unknown): wear the watch snugly, **Start + PPG**,
sit still for 1–2 minutes, Stop, export as in section 3, then
```
python ppg_probe.py ..\sessions\<session> --plot
```
The script shows the sample rate, values per event, statistics per channel, whether a channel contains a
pulse wave (peak in the pulse band vs. heart-rate sensor) and whether values look like beat intervals in ms.

**Result of the first test (2026-11-03):** `raw_ppg.csv` delivers 100 Hz with 16 values per event, of which
7 are used. v6 shows the pulse wave most cleanly (v1, v3, v4 are also light channels, v0 is probably
ambient light, v2/v5 are status with sentinel values −59000/−23000). `raw_hr_ext.csv` only contains bpm and a
status value, no beat intervals. Trailing zeros are no longer written (~40 → ~20 MB/h).

Beat-to-beat analysis:
```
python ppg.py ..\sessions\<session> --plot
```
Picks the channel with the clearest pulse wave, detects every beat, discards sections with movement
and beats with an atypical shape, computes SDNN/RMSSD from clean intervals and lists
ectopic beat candidates: "premature" (short interval + pause, together ≈ 2 intervals) and
"missed pulse" (one interval ≈ twice as long). Output: `ppg_summary.txt`, `ppg_beats.csv`,
`ppg_events.csv`, `ppg.png` with a snippet per candidate. Without a simultaneous ECG these are candidates,
not findings.

**Felt ectopic beats as a reference:** during a recording the **Felt** button appears. Every
time you feel a skipped beat, tap it immediately with the other hand (the arm with the watch stays
still). This writes `felt` with a timestamp to `events.csv`. In PPG mode the screen stays on for the
first 20 min. `ppg.py` then checks the 8 s before each marker for the pattern (premature / missed pulse),
reports the chance of a random hit and counts automatic candidates without a marker (`ppg_felt.csv`).

## 7. Breath-hold test (voluntary breath holding)
Checks whether the watch sees a breathing pause at all. Procedure (~9 min, preferably with **Start + PPG**):
1. Lie on your back, watch arm relaxed next to your body, start, breathe calmly for 2 min.
2. Shake the wrist firmly for 2 s and start a stopwatch at the same time (time marker).
3. From 0:30, five times: hold your breath for 20 s (after a normal exhale), breathe normally for 40 s.
4. At ~5:30 shake again, Stop.
```
python breath_hold.py ..\sessions\<session> --plot
```
Finds the time marker automatically (otherwise `--marker HH:MM:SS`), filters the breathing motion (0.1–0.7 Hz,
gyro and accelerometer separately), computes the amplitude over 5 s and marks pauses in which it
drops below 35 % of normal breathing (≥ 8 s). Output: detected pauses out of 5, false alarms, time offset,
heart rate before/during/after the pauses and, if raw PPG is present, the same for the breathing modulation
of the pulse wave. Other procedures: `--first-s`, `--hold-s`, `--cycle-s`, `--holds`.

Limit: holding your breath means the chest stands still (like a central pause). In an
obstructive apnea the chest keeps working against the closed airway. If the watch fails
the test, it won't detect real apneas either. If it passes, that is only a first step.

## 8. Live dashboard
The watch streams its measurements live to the laptop over the ADB tunnel (no Bluetooth, no
firewall rule needed, latency < 1 s). Recording on the watch continues independently.
```
python live.py --serial 192.168.178.35:<port>     # sets up adb reverse, opens the browser
python live.py --demo                              # without a watch, synthetic data
python live.py --replay ..\sessions\<session>      # play back a saved session (--speed 4)
```
On the watch use **Start + PPG** (without PPG there is no pulse wave). Within 3 s the watch shows
"Live ✓" (and "PPG …k" if started with PPG). Shown: pulse wave with detected beats, beat intervals of the last
5 min (red = ectopic beat candidate, grey = movement, green = felt, purple = heart-rate sensor),
breathing motion, movement, heart rate, RMSSD (60 s), breaths/min. The live detection is simpler than
`ppg.py` and reports more false alarms. The analysis afterwards is what counts.

The PPG channel is chosen automatically (the one with the clearest pulse period; `--channel 6` fixes it).
Below the pulse wave is a diagnostics line: channel and quality per channel, buffer length, lag of
PPG and accel relative to the laptop clock, range of the filtered wave, errors and the last
received PPG line. `live.py` records everything it receives to `sessions/live/live_<time>.txt`.
This file helps with debugging.

Costs battery (Wi-Fi stays on), so not overnight. When the watch screen turns off, Wi-Fi may
sleep. Then the live connection drops, but recording continues.

## 9. TypeScript version (`analysis-ts/`)
Parallel to the Python scripts, same rules, same output files. Only needs Node ≥ 20.
```
cd analysis-ts
npm install
npm run analyze -- ..\sessions\<session>       # like analyze.py (without plot)
npm run ppg -- ..\sessions\<session>           # like ppg.py (without plot)
npm run live -- --serial 192.168.178.35:<port>  # like live.py, title "SleepLogger live · TS"
npm run live -- --demo
npm run ui -- --demo                           # live analyzer with a React UI, same options as live
npm test                                       # DSP against scipy reference values
```
Checked against Python: `summary.txt` character-identical on three nights, `ppg_summary.txt` identical on the
test session and a PPG night (candidates, HRV). The only known difference: in flat signal stretches
(PPG LED off) Python finds a few hundred spurious beats with amplitude ~1e-9 (numerical noise),
TypeScript fewer. That only changes the beat count, nothing about HRV or candidates.
Not ported yet: plots (`--plot`), `audio.py`, `breath_hold.py`, `nights.py`, `ppg_probe.py`, `simulate.py`.

## 10. Sleep position (calibrated)
The watch sees how the **wrist** lies, not the torso. With the arm under the pillow or on the hip
the same body position looks completely different. So the model is personal and needs several arm
placements per position. Whether it is good enough for you is answered by the phone check below,
not by the calibration itself.

**Calibrate** (once, ~10 min, then now and then a few more taps): start a recording, scroll down to
"Calibrate position". Lie in the position, tap it (Back / Left / Right / Stomach), keep the watch arm
still until the watch buzzes (25 s). Then change the arm placement and tap the same position again.
2–4 placements per position, the ones you really sleep in. Watch on the left wrist: on your left
side the arm is usually under the body or under the pillow, calibrate exactly those.
```
python position.py calibrate ..\sessions\<session>          # adds the taps to analysis/pose_model.json
```
Taps in a moving hold are discarded. A warning appears if two positions have templates that look
the same; the watch cannot tell those apart.

**Classify a night** (after `analyze.py`, so the per-position statistics have data):
```
python position.py classify ..\sessions\<session> --plot
```
Splits the night at movement events, assigns each still segment the closest template
(`unknown` if none is within 35°, `uncertain` if two positions are within 8° of each other).
Output: `positions.csv`, `position_summary.txt`, `positions.png`. Per position: time, movements/h,
heart-rate spike episodes, breathing rate, heart rate and, with a Fitbit export, SpO2 and sleep stages.
This is where positional effects show up (e.g. spike episodes almost only on the back).

**Check it against the phone (do this before trusting the numbers):** one night with the phone on
the sternum (tight shirt pocket or tape), **screen facing out, top edge towards the head**, recording
the accelerometer, e.g. with the app "Sensor Logger" (enable Gravity and TotalAcceleration, export CSV).
Do the calibration taps in that night as well; the phone then learns its own templates from them.
```
python position.py validate ..\sessions\<session> --phone "..\sessions\<sensor-logger-export>" --plot
```
The clocks of phone and watch are aligned automatically via the roll-overs (±2 min, otherwise
`--offset-s`). Output: `position_validation.txt` with the share of time the watch gives a position,
accuracy, confusion matrix, back detection (hit rate / false alarms) and the chance level for comparison;
`position_validation.csv`, `position_validation.png`. Only if accuracy is clearly above chance and back
detection is reliable is a vibration alarm for the back position worth building.

## Limits (honestly)
- **Breathing rate** is only estimated in quiet phases and comes with a quality value. At the wrist
  the signal is very small; expect many unusable windows. The parameters have only been checked on
  synthetic data. Real tuning needs a reference (audio recording of the
  breathing or a chest strap). A test night with the watch on the chest shows what the signal can deliver.
- **Audio pauses** are candidates: quiet breathing is often inaudible. That's why only silences right
  after audible breathing count, and silences over 120 s count as "too quiet", not as a pause.
- **CVHR** does not replace polysomnography. The watch smooths its BPM, beta blockers dampen the
  heart-rate response, and snoring without apnea or normal arousals also produce spikes.
- Officially Wear OS only delivers BPM. The Pixel Watch, however, also reports a raw "PPG Sensor"
  and "HeartRate-Extended" (only `BODY_SENSORS` needed). Whether the data reaches third-party apps and what it contains
  is answered by the PPG test (section 6). Until then: no HRV, no ectopic beats.
- Battery: continuous heart rate + wakelock costs noticeably. `events.csv` shows whether a wake-up accelerometer
  was available.
