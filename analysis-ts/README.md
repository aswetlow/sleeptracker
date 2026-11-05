# SleepLogger-Auswertung in TypeScript

TypeScript-Fassung von `../analysis/` (analyze, ppg, fitbit, live). Keine Laufzeit-Abhängigkeiten,
die Signalverarbeitung (Butterworth, sosfiltfilt, find_peaks, Welch, rollende Mediane) steckt in
`src/lib/` und ist nach scipy/pandas nachgebaut. Bedienung: Abschnitt 9 der Haupt-README.

| Datei | entspricht | Ausgaben |
|---|---|---|
| `src/analyze.ts` + `src/fitbit.ts` | `analyze.py` + `fitbit.py` | summary.txt, per_minute.csv, movement_events.csv, breathing.csv, cvhr_*.csv, spo2_episodes.csv |
| `src/ppg.ts` | `ppg.py` | ppg_summary.txt, ppg_beats.csv, ppg_events.csv, ppg_felt.csv |
| `src/live.ts` + `src/live_page.html` | `live.py` | Dashboard auf http://localhost:8765 |
| `server/live_server.ts` + `web/` | – | Live-Analyzer (React, shadcn-Stil) auf http://localhost:8765 |

`src/live_core.ts` enthält Empfang, Verarbeitung und Datenquellen; beide Dashboards nutzen es.

## Live-Analyzer (React + Express)

```
npm run ui -- --demo                               # baut web/ und startet den Server
npm run ui -- --serial 192.168.178.35:<Port>       # echte Uhr, gleiche Optionen wie live.ts
npm run ui -- --replay ../sessions/<session> --speed 4
npm run ui:dev -- --demo                           # Oberfläche mit Hot-Reload (Vite im Express)
```

Express liefert alle 250 ms einen Snapshot per Server-Sent Events (`/api/stream`, einzeln:
`/api/snapshot`). Die Oberfläche (React 19, Tailwind 4, Radix, Recharts, Komponenten im shadcn/ui-Stil
unter `web/src/components/ui/`) zeigt Kennzahlen mit Verlauf, Pulswelle mit Schlägen,
Schlagintervalle (1/2/5 min), Ereignisliste, Atmung, Bewegung und Diagnose. Hell/dunkel umschaltbar,
Anzeige einfrierbar (Empfang und Mitschrift laufen weiter). Läuft komplett offline.

Gleichstände bei `find_peaks(distance=…)`: numpy sortiert dort nicht stabil, bei exakt gleich hohen
Peaks kann die Wahl abweichen. Bei echten (nicht ganzzahligen) Signalen kommt das praktisch nicht vor.
