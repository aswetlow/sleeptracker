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

Pro Nacht entsteht `sessions/<Startzeit>/` mit:
- `accel.csv` – `epoch_ms,x,y,z` (m/s², inkl. Schwerkraft)
- `gyro.csv` – `epoch_ms,x,y,z` (rad/s)
- `hr.csv` – `epoch_ms,bpm,accuracy` (accuracy 0–3, <2 wird bei der Analyse verworfen)
- `events.csv` – Start/Stopp, verwendete Sensoren, ob Wake-up-Sensor/Wakelock aktiv war

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

### Atemfrequenz
Nur in ruhigen Fenstern. Pro Sensor Bandpass 0,1–0,5 Hz, Hauptkomponente über alle drei Achsen,
Periode per Autokorrelation. Qualität = Höhe des Autokorrelations-Peaks. Reines Rauschen liegt
in Tests bei ≤0,25, daher die Schwelle 0,4. Gyro und Accelerometer werden getrennt geschätzt und
bei Übereinstimmung gemittelt; Ausreißer gegen den geglätteten Verlauf werden abgewertet.

### Periodische Pulsspitzen (CVHR)
Am Ende einer Atempause kommt typischerweise eine kurze Weckreaktion mit Pulssprung um 10–20 bpm.
Wiederholt sich das alle 25–100 s mindestens 4-mal, markiert das Skript eine Episode, inkl. Anteil
der Spitzen mit gleichzeitiger Bewegung. Das ist ein Hinweis, kein Apnoe-Nachweis und kein AHI.

### Testen ohne Uhr
```
python analysis/simulate.py testnacht
python analysis/analyze.py testnacht --plot
```
Erzeugt 3 h mit Atmung 15→12/min, drei Bewegungen und 20 apnoe-artigen Zyklen.

## Grenzen (ehrlich)
- **Atemfrequenz** wird nur in ruhigen Phasen geschätzt und hat einen Qualitätswert. Am Handgelenk
  ist das Signal sehr klein; erwarte viele unbrauchbare Fenster. Die Parameter sind nur an
  synthetischen Daten geprüft. Für echtes Tuning braucht es eine Referenz (Audioaufnahme der
  Atmung oder Brustgurt). Eine Testnacht mit der Uhr am Brustkorb zeigt, was das Signal hergibt.
- **CVHR** ersetzt keine Polysomnographie. Die Uhr glättet ihre BPM, Betablocker dämpfen die
  Pulsreaktion, und auch Schnarchen ohne Apnoe oder normale Weckreaktionen erzeugen Spitzen.
- Wear OS liefert Drittanbieter-Apps nur BPM, keine RR-Intervalle oder PPG-Rohdaten. HRV geht also nicht.
- Akku: Puls dauerhaft + Wakelock kostet spürbar. `events.csv` zeigt, ob ein Wake-up-Accelerometer
  verfügbar war.
