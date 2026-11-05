# SleepLogger-Auswertung in TypeScript

TypeScript-Fassung von `../analysis/` (analyze, ppg, fitbit, live). Keine Laufzeit-Abhängigkeiten,
die Signalverarbeitung (Butterworth, sosfiltfilt, find_peaks, Welch, rollende Mediane) steckt in
`src/lib/` und ist nach scipy/pandas nachgebaut. Bedienung: Abschnitt 9 der Haupt-README.

| Datei | entspricht | Ausgaben |
|---|---|---|
| `src/analyze.ts` + `src/fitbit.ts` | `analyze.py` + `fitbit.py` | summary.txt, per_minute.csv, movement_events.csv, breathing.csv, cvhr_*.csv, spo2_episodes.csv |
| `src/ppg.ts` | `ppg.py` | ppg_summary.txt, ppg_beats.csv, ppg_events.csv, ppg_felt.csv |
| `src/live.ts` + `src/live_page.html` | `live.py` | Dashboard auf http://localhost:8765 |

Gleichstände bei `find_peaks(distance=…)`: numpy sortiert dort nicht stabil, bei exakt gleich hohen
Peaks kann die Wahl abweichen. Bei echten (nicht ganzzahligen) Signalen kommt das praktisch nicht vor.
