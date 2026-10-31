# SleepLogger für Pixel Watch 1

Wear-OS-App, die nachts Beschleunigung und Gyroskop (je 25 Hz) und Puls (~1 Hz) mit Zeitstempel in CSV schreibt,
plus ein Python-Skript zur Auswertung.

## 1. Uhr vorbereiten
1. Einstellungen › System › Info › Versionen › 7× auf **Build-Nummer** tippen.
2. Einstellungen › Entwickleroptionen › **ADB-Debugging** und **Kabelloses Debugging** an.
3. Uhr und Rechner ins selbe WLAN. Unter „Kabelloses Debugging“ › **Neues Gerät koppeln**:
   ```
   adb pair <IP>:<Pairing-Port> <Code>
   adb connect <IP>:<Debug-Port>      # Port steht oben unter "Kabelloses Debugging"
   adb devices
   ```

## 2. App bauen und installieren
- Ordner in Android Studio öffnen, Gradle-Sync abwarten (lädt SDK 35 nach, falls es fehlt).
- Uhr oben als Zielgerät wählen, **Run**. Oder per Terminal: `./gradlew installDebug`.
- App auf der Uhr öffnen, **Start**, Berechtigungen erlauben. Läuft, solange die Benachrichtigung da ist.
- Morgens App öffnen, **Stopp**.

Tipp: Kabelloses Debugging nachts aus, und vor der ersten Nacht einen 30-Minuten-Test machen.

## 3. Daten exportieren
Die Dateien liegen im privaten App-Ordner; bei einem Debug-Build kommt man per `run-as` dran:
```
adb devices          # Uhr taucht beim WLAN-Debugging oft doppelt auf -> mit -s <Name> wählen
adb -s <IP:Port> shell run-as de.alex.sleeplogger ls files/sessions
```
Export (unter Windows über `cmd`, weil PowerShell bei `>` Binärdaten als UTF-16 zerstört):
```
cmd /c "adb -s <IP:Port> exec-out run-as de.alex.sleeplogger tar c -C files sessions > sessions.tar"
tar xf sessions.tar
```
Konkret für Alex' Uhr (der Port ändert sich, sobald kabelloses Debugging neu startet; aktuellen
Port unter „Kabelloses Debugging“ auf der Uhr oder per `adb devices` nachsehen):
```
cmd /c "adb -s 192.168.178.35:44691 exec-out run-as de.alex.sleeplogger tar c -C files sessions > sessions.tar"
```

Pro Nacht entsteht `sessions/<Startzeit>/` mit:
- `accel.csv` – `epoch_ms,x,y,z` (m/s², inkl. Schwerkraft)
- `gyro.csv` – `epoch_ms,x,y,z` (rad/s)
- `hr.csv` – `epoch_ms,bpm,accuracy` (accuracy 0–3, <2 wird bei der Analyse verworfen)
- `events.csv` – Start/Stopp, verwendete Sensoren, ob Wake-up-Sensor/Wakelock aktiv war, Akkustand alle 10 min

Größe: ~25 MB pro 8 h und Sensor-CSV.

## 4. Auswerten
```
pip install -r analysis/requirements.txt
python analysis/analyze.py sessions/20261030_230512 --plot
```
Ergebnis im Session-Ordner:
- `summary.txt` – Überblick
- `movement_events.csv` – Start, Dauer, Lagewechsel in Grad, Puls vorher/Spitze danach
- `breathing.csv` – Atemfrequenz pro 2-min-Fenster (alle 30 s), Qualität 0–1, Quelle (accel/gyro/beide)
- `cvhr_episodes.csv` – Episoden periodischer Pulsspitzen (siehe unten)
- `per_minute.csv`, `night.png`

Stellschrauben oben im Skript: `THRESHOLD_K`, `MIN_THRESHOLD` (Bewegung), `BREATH_MIN_QUALITY`,
`CVHR_MIN_RISE_BPM`, `CVHR_CYCLE_S`, `CVHR_MIN_CYCLES`.

### Fitbit-Export (optional)
Liegt im Session-Ordner eine `fitbit.json` (der Nacht-Export mit `"fitbit": {...}`), liest `analyze.py`
sie automatisch mit ein (oder `--fitbit pfad/zur/datei`). Dann kommen dazu:
- Atemfrequenz der Uhr pro Schlafphase neben den Fitbit-Werten, Puls-Abgleich, Bewegung pro Phase
- SpO2: Minuten unter 90 %, Entsättigungen, und `spo2_episodes.csv` mit Episoden ≥5 min unter 90 %.
  Pro Episode wird geprüft, ob der Arm währenddessen unbewegt lag, ob sie mit einer Bewegung endet
  und ob der Puls reagiert. Alle drei = „vermutlich Lage-Artefakt“ (z. B. Arm eingeklemmt).
- Raumklima (tado), Plot mit Hypnogramm, Fitbit-Puls und SpO2

### Atemfrequenz
Nur in ruhigen Fenstern. Pro Sensor Bandpass 0,1–0,5 Hz, Hauptkomponente über alle drei Achsen,
Periode per Autokorrelation. Qualität = Höhe des Autokorrelations-Peaks. Reines Rauschen liegt
in Tests bei ≤0,25, daher die Schwelle 0,4. Gyro und Accelerometer werden getrennt geschätzt und
bei Übereinstimmung gemittelt; Ausreißer gegen den geglätteten Verlauf werden abgewertet.

### Periodische Pulsspitzen (CVHR)
Am Ende einer Atempause kommt typischerweise eine kurze Weckreaktion mit Pulssprung um 10–20 bpm.
Wiederholt sich das alle 25–100 s mindestens 4-mal, markiert das Skript eine Episode, inkl. Anteil
der Spitzen mit gleichzeitiger Bewegung. Das ist ein Hinweis, kein Apnoe-Nachweis und kein AHI.

## 5. Audio-Referenz vom Handy (optional, aber der größte Hebel)
Ohne Referenz lassen sich die Schwellen nicht seriös einstellen. Die Handy-Aufnahme liefert sie.

**Aufnahme:** Jede Sprachaufnahme-App, die stundenlang mit ausgeschaltetem Bildschirm aufnimmt
(Pixel: „Rekorder“). Handy auf den Nachttisch, Mikro Richtung Kopf, ans Ladekabel.
1. Uhr-App starten, dann Aufnahme starten.
2. **Einmal kräftig mit der Uhrhand klatschen.** Knall im Audio + Spitze im Accelerometer
   = Synchronisation auf ~0,1 s.
3. Morgens beides stoppen, Audiodatei neben den Session-Ordner legen.

**Auswerten** (m4a/mp3 brauchen ffmpeg: `winget install Gyan.FFmpeg` oder `scoop install ffmpeg`):
```
python analysis/analyze.py sessions/20261030_230512
python analysis/audio.py sessions/20261030_230512 "Aufnahme.m4a"
```
Startzeit kommt aus den Datei-Metadaten oder dem Dateinamen; notfalls `--start "2026-10-30 23:05:12"`.

Ergebnis: `audio_summary.txt` plus CSVs:
- `audio_events.csv` – Schnarcher, Atempausen-Kandidaten (10–120 s still direkt nach hörbarem
  Atmen, mit „endet laut“ bei Japsen/Schnarcher), laute Ereignisse
- `audio_breathing.csv` – Atemfrequenz aus dem Atemgeräusch
- `breathing_vs_audio.csv` – Uhr gegen Audio. Die Zusammenfassung zeigt den Fehler pro
  Qualitätsstufe der Uhr: Setz `BREATH_MIN_QUALITY` dort, wo der Fehler klein wird.
- Anteil der Pulsspitzen, die kurz nach einer hörbaren Pause kommen, mit Zufallsniveau zum Vergleich.

Wer nicht allein schläft, nimmt die andere Person mit auf. Vorher absprechen.

### Testen ohne Uhr
```
python analysis/simulate.py testnacht --audio
python analysis/analyze.py testnacht --plot
python analysis/audio.py testnacht "testnacht/Aufnahme 2025-10-30 19.46.27.wav"
```
Erzeugt 3 h mit Atmung 15→12/min, drei Bewegungen, Klatschen, Schnarchphase, 20 apnoe-artigen
Zyklen und einer passenden Handy-Aufnahme (~170 MB WAV).

## Grenzen (ehrlich)
- **Atemfrequenz** wird nur in ruhigen Phasen geschätzt und hat einen Qualitätswert. Am Handgelenk
  ist das Signal sehr klein; erwarte viele unbrauchbare Fenster. Die Parameter sind nur an
  synthetischen Daten geprüft. Für echtes Tuning braucht es eine Referenz (Audioaufnahme der
  Atmung oder Brustgurt). Eine Testnacht mit der Uhr am Brustkorb zeigt, was das Signal hergibt.
- **Audio-Pausen** sind Kandidaten: Leises Atmen ist oft unhörbar. Darum zählen nur Stillen direkt
  nach hörbarem Atmen, und Stillen über 120 s gelten als „zu leise“, nicht als Pause.
- **CVHR** ersetzt keine Polysomnographie. Die Uhr glättet ihre BPM, Betablocker dämpfen die
  Pulsreaktion, und auch Schnarchen ohne Apnoe oder normale Weckreaktionen erzeugen Spitzen.
- Wear OS liefert Drittanbieter-Apps nur BPM, keine RR-Intervalle oder PPG-Rohdaten. HRV geht also nicht.
- Akku: Puls dauerhaft + Wakelock kostet spürbar. `events.csv` zeigt, ob ein Wake-up-Accelerometer
  verfügbar war.
