# SleepLogger für Pixel Watch 1

Wear-OS-App, die nachts Beschleunigung (25 Hz) und Puls (~1 Hz) mit Zeitstempel in CSV schreibt,
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
- `hr.csv` – `epoch_ms,bpm,accuracy` (accuracy 0–3, <2 wird bei der Analyse verworfen)
- `events.csv` – Start/Stopp, verwendete Sensoren, ob Wake-up-Sensor/Wakelock aktiv war

Größe: ~25 MB pro 8 h Accelerometer-CSV.

## 4. Auswerten
```
pip install -r analysis/requirements.txt
python analysis/analyze.py sessions/20261030_230512 --plot
```
Ergebnis im Session-Ordner: `summary.txt`, `movement_events.csv` (Start, Dauer, Lagewechsel in Grad,
Puls vorher/Spitze danach), `per_minute.csv`, `night.png`.

Stellschrauben oben im Skript: `THRESHOLD_K`, `MIN_THRESHOLD` (Empfindlichkeit), `MERGE_GAP_S`.

## Grenzen (ehrlich)
- **Atemfrequenz** wird nur in komplett ruhigen Minuten geschätzt und hat einen Qualitätswert.
  Am Handgelenk ist das Signal sehr klein; erwarte viele unbrauchbare Minuten. Apnoe-Erkennung
  ist damit nicht möglich.
- Wear OS liefert Drittanbieter-Apps nur BPM, keine RR-Intervalle oder PPG-Rohdaten. HRV geht also nicht.
- Akku: Puls dauerhaft + Wakelock kostet spürbar. `events.csv` zeigt, ob ein Wake-up-Accelerometer
  verfügbar war.
