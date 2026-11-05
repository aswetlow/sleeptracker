# SleepLogger analysis in TypeScript

TypeScript version of `../analysis/` (analyze, ppg, fitbit, live, position). No runtime dependencies for the analysis;
the signal processing (Butterworth, sosfiltfilt, find_peaks, Welch, rolling medians) lives in
`src/lib/` and is modelled on scipy/pandas. Usage: section 9 of the main README.

| File | equivalent | outputs |
|---|---|---|
| `src/analyze.ts` + `src/fitbit.ts` | `analyze.py` + `fitbit.py` | summary.txt, per_minute.csv, movement_events.csv, breathing.csv, cvhr_*.csv, spo2_episodes.csv |
| `src/ppg.ts` | `ppg.py` | ppg_summary.txt, ppg_beats.csv, ppg_events.csv, ppg_felt.csv |
| `src/live.ts` + `src/live_page.html` | `live.py` | dashboard on http://localhost:8765 |
| `src/position.ts` | `position.py` | pose_model.json (shared with Python), positions.csv, position_summary.txt, position_validation.csv/.txt, `--plot` as SVG |
| `src/ecg_probe.ts` | – | ECG test: ecg_summary.txt, ecg_beats.csv, ecg_probe.svg (README section 10) |
| `server/live_server.ts` + `web/` | – | live analyzer (React, shadcn style) on http://localhost:8765 |

`src/live_core.ts` contains receiving, processing and the data sources; both dashboards use it.

## Live analyzer (React + Express)

```
npm run ui -- --demo                               # builds web/ and starts the server
npm run ui -- --serial 192.168.178.35:<port>       # real watch, same options as live.ts
npm run ui -- --replay ../sessions/<session> --speed 4
npm run ui:dev -- --demo                           # UI with hot reload (Vite inside Express)
```

Express sends a snapshot every 250 ms via server-sent events (`/api/stream`, single snapshot:
`/api/snapshot`). The UI (React 19, Tailwind 4, Radix, Recharts, components in shadcn/ui style
under `web/src/components/ui/`) shows key figures with history, the pulse wave with beats,
beat intervals (1/2/5 min), an event list, breathing, movement and diagnostics, and the live ECG while the
watch runs the ECG test. The "ECG test" tab shows the `ecg_probe` report for every session with `raw_ecg.csv`
under `../sessions` (or `--sessions <dir>`). Light/dark switchable,
display can be frozen (receiving and recording continue). Works fully offline.

Ties in `find_peaks(distance=…)`: numpy does not sort stably there, so with exactly equal
peaks the choice can differ. With real (non-integer) signals this practically never happens.
