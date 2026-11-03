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

Nur eine Nacht holen statt aller:
```
cmd /c "adb -s <IP:Port> exec-out run-as de.alex.sleeplogger tar c -C files sessions/20261103_225540 > session.tar"
tar xf session.tar
```

Aufräumen auf der Uhr (endgültig, vorher prüfen, dass die Nacht lokal in `sessions\` liegt):
```
adb -s <IP:Port> shell run-as de.alex.sleeplogger rm -r files/sessions/20261030_224900   # eine Nacht
adb -s <IP:Port> shell run-as de.alex.sleeplogger rm -r files/sessions                   # alle (nicht während einer Aufnahme)
```
Der Ordner `sessions` wird beim nächsten Start automatisch neu angelegt.

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

### Mehrere Nächte vergleichen
Erst jede Nacht mit `analyze.py` auswerten, dann:
```
python nights.py ..\sessions\20261030_224900 ..\sessions\20261031_235707 ..\sessions\20261101_231037 --out nights.csv
```
Pro Nacht eine Spalte: Schlaf und Phasen (Fitbit), HRV, Ruhepuls, Puls im Schlaf und im Tiefschlaf,
Atemfrequenz pro Phase, Bewegungen/h, Lagewechsel, SpO2, CVHR, Akku, Raumklima, Schritte am Vortag.
Für A/B-Vergleiche (z. B. Mundpflaster) eine `notes.txt` in den Session-Ordner legen:
```
pflaster=ja
notiz=Toilette 04:00
```

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

## 6. PPG-Rohdaten testen (experimentell)
`adb shell dumpsys sensorservice` zeigt auf der Pixel Watch 1 undokumentierte Google-Sensoren:
`com.google.wear.sensor.ppg` (PPG Sensor, TI), `com.google.sensor.heart_rate_extended` und
`com.google.sensor.ppg_controller`. Der Knopf **Start + PPG** schreibt sie zusätzlich roh mit
(`raw_ppg.csv`, `raw_hr_ext.csv`, `raw_ppg_ctrl.csv`, Format `epoch_ms,accuracy,n,values` mit
leerzeichengetrennten Werten) und legt `sensors.txt` mit allen Sensoren an.

Erst kurz testen, nicht über Nacht (Datenmenge und Akku unbekannt): Uhr fest anlegen, **Start + PPG**,
1–2 Minuten ruhig sitzen, Stopp, exportieren wie in Abschnitt 3, dann
```
python ppg_probe.py ..\sessions\<session> --plot
```
Das Skript zeigt Abtastrate, Werte pro Event, Statistik pro Kanal, ob ein Kanal eine Pulswelle
enthält (Peak im Pulsband vs. HeartRate-Sensor) und ob Werte wie Schlagintervalle in ms aussehen.

**Ergebnis des ersten Tests (03.11.2026):** `raw_ppg.csv` liefert 100 Hz mit 16 Werten pro Event, davon
7 belegt. v6 zeigt die Pulswelle am saubersten (v1, v3, v4 ebenfalls Licht-Kanäle, v0 vermutlich
Umgebungslicht, v2/v5 Status mit Sentinel-Werten −59000/−23000). `raw_hr_ext.csv` enthält nur bpm und einen
Statuswert, keine Schlagintervalle. Nullen am Ende werden inzwischen nicht mehr geschrieben (~40 → ~20 MB/h).

Schlag-zu-Schlag-Auswertung:
```
python ppg.py ..\sessions\<session> --plot
```
Wählt den Kanal mit der deutlichsten Pulswelle, erkennt jeden Schlag, verwirft Abschnitte mit Bewegung
und Schläge mit untypischer Form, berechnet SDNN/RMSSD aus sauberen Intervallen und listet
Extrasystolen-Kandidaten: „vorzeitig“ (kurzes Intervall + Pause, zusammen ≈ 2 Intervalle) und
„Puls fehlt“ (ein Intervall ≈ doppelt so lang). Ausgabe: `ppg_summary.txt`, `ppg_beats.csv`,
`ppg_events.csv`, `ppg.png` mit Ausschnitt pro Kandidat. Ohne zeitgleiches EKG sind das Kandidaten,
keine Befunde.

**Gespürte Extrasystolen als Referenz:** Während einer Aufnahme erscheint der Knopf **Gespürt**. Jedes
Mal, wenn du ein Stolpern spürst, sofort mit der anderen Hand antippen (der Arm mit der Uhr bleibt
liegen). Das schreibt `felt` mit Zeitstempel in `events.csv`. Im PPG-Modus bleibt der Bildschirm die
ersten 20 min an. `ppg.py` prüft dann pro Marke die 8 s davor auf das Muster (vorzeitig / Puls fehlt),
nennt die Zufallstreffer-Wahrscheinlichkeit und zählt automatische Kandidaten ohne Marke (`ppg_felt.csv`).

## 7. Atempausen-Test (willkürliches Luftanhalten)
Prüft, ob die Uhr eine Atempause überhaupt sieht. Ablauf (~9 min, am besten mit **Start + PPG**):
1. Auf dem Rücken liegen, Uhrarm locker neben dem Körper, starten, 2 min ruhig atmen.
2. Handgelenk 2 s kräftig schütteln und gleichzeitig eine Stoppuhr starten (Zeitmarke).
3. Ab 0:30 fünfmal: 20 s Luft anhalten (nach normalem Ausatmen), 40 s normal atmen.
4. Bei ~5:30 nochmal schütteln, Stopp.
```
python breath_hold.py ..\sessions\<session> --plot
```
Findet die Zeitmarke automatisch (sonst `--marker HH:MM:SS`), filtert die Atembewegung (0,1–0,7 Hz,
Gyro und Accelerometer getrennt), berechnet die Amplitude über 5 s und markiert Pausen, in denen sie
unter 35 % des normalen Atmens fällt (≥ 8 s). Ausgabe: erkannte Pausen von 5, Fehlalarme, Zeitversatz,
Puls vor/während/nach den Pausen und, falls PPG-Rohdaten vorhanden, dasselbe für die Atemmodulation
der Pulswelle. Andere Abläufe: `--first-s`, `--hold-s`, `--cycle-s`, `--holds`.

Grenze: Luftanhalten heißt, der Brustkorb steht still (wie bei einer zentralen Pause). Bei einer
obstruktiven Apnoe arbeitet der Brustkorb weiter gegen die verschlossenen Atemwege. Besteht die Uhr
den Test nicht, erkennt sie auch keine echten Apnoen. Besteht sie ihn, ist das nur ein erster Schritt.

## 8. Live-Dashboard
Die Uhr schickt ihre Messwerte live über den ADB-Tunnel an den Laptop (kein Bluetooth, keine
Firewall-Freigabe nötig, Verzögerung < 1 s). Die Aufzeichnung auf der Uhr läuft unabhängig davon weiter.
```
python live.py --serial 192.168.178.35:<Port>     # richtet adb reverse ein, öffnet den Browser
python live.py --demo                              # ohne Uhr, synthetische Daten
python live.py --replay ..\sessions\<session>      # gespeicherte Session abspielen (--speed 4)
```
Auf der Uhr **Start + PPG** (ohne PPG fehlt die Pulswelle). Nach spätestens 3 s steht auf der Uhr
„Live ✓“ (und „PPG …k“, falls mit PPG gestartet). Angezeigt: Pulswelle mit erkannten Schlägen, Schlagintervalle der letzten
5 min (rot = Extrasystolen-Kandidat, grau = Bewegung, grün = Gespürt, lila = Pulssensor),
Atembewegung, Bewegung, Puls, RMSSD (60 s), Atemzüge/min. Die Live-Erkennung ist einfacher als
`ppg.py` und meldet mehr Fehlalarme. Maßgeblich ist die Auswertung hinterher.

Der PPG-Kanal wird automatisch gewählt (der mit der deutlichsten Pulsperiode, `--channel 6` legt ihn fest).
Unter der Pulswelle steht eine Diagnosezeile: Kanal und Güte je Kanal, Pufferlänge, Verzögerung von
PPG und Accel gegenüber der Laptop-Uhr, Ausschlag der gefilterten Welle, Fehler und die zuletzt
empfangene PPG-Zeile. Alles Empfangene schreibt `live.py` nach `sessions/live/live_<Zeit>.txt`.
Diese Datei hilft bei der Fehlersuche.

Kostet Akku (WLAN bleibt aktiv), also nicht über Nacht. Geht der Uhr-Bildschirm aus, kann das WLAN
schlafen. Dann bricht die Live-Verbindung ab, die Aufzeichnung läuft aber weiter.

## Grenzen (ehrlich)
- **Atemfrequenz** wird nur in ruhigen Phasen geschätzt und hat einen Qualitätswert. Am Handgelenk
  ist das Signal sehr klein; erwarte viele unbrauchbare Fenster. Die Parameter sind nur an
  synthetischen Daten geprüft. Für echtes Tuning braucht es eine Referenz (Audioaufnahme der
  Atmung oder Brustgurt). Eine Testnacht mit der Uhr am Brustkorb zeigt, was das Signal hergibt.
- **Audio-Pausen** sind Kandidaten: Leises Atmen ist oft unhörbar. Darum zählen nur Stillen direkt
  nach hörbarem Atmen, und Stillen über 120 s gelten als „zu leise“, nicht als Pause.
- **CVHR** ersetzt keine Polysomnographie. Die Uhr glättet ihre BPM, Betablocker dämpfen die
  Pulsreaktion, und auch Schnarchen ohne Apnoe oder normale Weckreaktionen erzeugen Spitzen.
- Offiziell liefert Wear OS nur BPM. Die Pixel Watch meldet aber zusätzlich einen rohen „PPG Sensor“
  und „HeartRate-Extended“ (nur `BODY_SENSORS` nötig). Ob die Daten an Dritt-Apps gehen und was drinsteht,
  klärt der PPG-Test (Abschnitt 6). Bis dahin: keine HRV, keine Extrasystolen.
- Akku: Puls dauerhaft + Wakelock kostet spürbar. `events.csv` zeigt, ob ein Wake-up-Accelerometer
  verfügbar war.
