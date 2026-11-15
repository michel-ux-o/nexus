# Nexus für Android und lokaler Wecker

Stand: 15.11.2026, OP-0186. Diese Anleitung beschreibt den Android-Quellstand und
die vorgesehene Auslieferung. Ein erfolgreicher APK-Build, die Release-Signatur,
ein öffentlicher Download und die Prüfung auf einem echten Telefon sind hier
noch nicht bestätigt. Die vorhandene Browser-/PWA-Installation bleibt eine
eigene Installationsform.

## Installieren und aktualisieren

Die Android-App wird als **signierte Release-APK** bereitgestellt. Eine
Play-Store-Veröffentlichung ist damit nicht verbunden. Der endgültige
Download-Link und der SHA-256-Dateihash müssen nach der Bereitstellung ergänzt
werden; derzeit gibt es in dieser Anleitung keinen bestätigten Download.

1. Die freigegebene Nexus-APK auf dem Telefon herunterladen. Der aktuelle
   Quellstand verlangt Android 8.0 oder neuer (API 26).
2. Die Datei im Download-Ordner öffnen. Falls Android nachfragt, für den
   verwendeten Browser oder Dateimanager **Apps aus dieser Quelle installieren**
   erlauben. Die Bezeichnung kann je nach Gerät abweichen.
3. Die Installation bestätigen und Nexus einmal über das App-Symbol starten.
   Die Erlaubnis für diese Installationsquelle kann danach wieder ausgeschaltet
   werden. Android beschreibt diesen Ablauf bei der
   [Installation über eine Website](https://developer.android.com/distribute/marketing-tools/alternative-distribution).
4. Die gehostete Nexus-Oberfläche beim ersten Start mit Internetverbindung laden
   und persönlich anmelden. Anschließend den Wecker einrichten und einen nahen
   Testalarm mit gesperrtem Bildschirm durchführen.

Ein Update wird über die vorhandene Installation installiert. Dafür müssen
Paketkennung und Signaturschlüssel zusammenpassen; Release-Versionen müssen eine
höhere `versionCode` besitzen. Aktueller Quellstand: Paket `de.nexus.app`,
Version `3.0.0`, `versionCode` 1. Eine Debug-APK ist keine freigegebene
Release-Version. Den ursprünglichen Signaturschlüssel sicher extern aufbewahren;
er gehört weder zum Download noch ins Repository. Ohne diesen Schlüssel lassen
sich weitere APKs nicht als normales Update dieser Installation verteilen.
[Android-App-Signaturen](https://developer.android.com/studio/publish/app-signing)

Vor einer Neuinstallation oder dem Löschen von App-Daten eine externe Sicherung
der Nexus-Daten erstellen. Browser/PWA und Android-WebView besitzen getrennte
lokale Datenspeicher. Die APK übernimmt vorhandene Browserdaten nicht
automatisch. Eine Anmeldung allein ist kein Nachweis einer geräteübergreifenden
Synchronisierung.

## Wecker auf diesem Gerät

Der Einstieg ist **Einstellungen → Morgenroutine → Wecker auf diesem Gerät**.
Die native Android-Ansicht verwaltet Montag bis Sonntag einzeln: jeden Tag
aktivieren oder deaktivieren und seine Uhrzeit festlegen. Die Weckzeiten richten
sich nach Datum und Zeitzone des Telefons. Weckplan, Schlummerdauer und Tonwahl
sind gerätebezogen und gehören nicht zu den synchronisierbaren Routinevorlagen.

Eine lokale MP3 wird über die Android-Dateiauswahl ausgewählt. Der native
Wecker verwendet eine private Kopie in der App; eine Datei bei einem
Cloud-Dateianbieter muss dafür zunächst heruntergeladen werden. Es wird kein
Zugriff auf die gesamte Musikbibliothek benötigt.
[Android-Dateiauswahl](https://developer.android.com/training/data-storage/shared/documents-files)

Vor der Nutzung die Tonprobe ausführen und die Android-Weckerlautstärke prüfen.
Bei einem nicht mehr abspielbaren eigenen Ton versucht der native Dienst einen
Systemton und danach einen einfachen Ersatzton. Diese Ausweichwege sind kein
Nachweis, dass ein bestimmtes Gerät hörbar weckt. Der klingelnde Alarm endet im
aktuellen Quellstand nach spätestens zehn Minuten.

**Schlummern** beendet den laufenden Ton erst, wenn der nächste Alarm erfolgreich
geplant wurde. Die Schlummerdauer ist auf 5–30 Minuten begrenzt.
**Aufstehen** beendet den Ton und öffnet den Übergang zur heutigen Morgenroutine.
Android-Gerätesperre und Nexus-Anmeldung bleiben dabei wirksam; persönliche
App-Inhalte werden nicht durch den Weckbildschirm freigeschaltet.

## Android-Freigaben und Grenzen

| Freigabe oder Zustand | Bedeutung |
| --- | --- |
| Alarme und Erinnerungen, ab Android 12 | Nexus benötigt die Freigabe für genaue Alarme. Fehlt sie, ist ein gespeicherter Wochentagsplan noch kein aktiver Wecker. Nach Änderung den nächsten geplanten Alarm in der App kontrollieren. |
| Benachrichtigungen, ab Android 13 | Für sichtbare Alarmmeldungen erlauben und den Wecker-Benachrichtigungskanal aktiviert lassen. |
| Vollbildmeldungen, ab Android 14 gesondert eingeschränkt | Eine Freigabe kann nötig sein. Android entscheidet über die Darstellung; bei aktiver Nutzung kann eine hervorgehobene Meldung anstelle des Weckbildschirms erscheinen. |
| Weckerlautstärke und „Nicht stören“ | Die Systemeinstellungen beeinflussen die Hörbarkeit. Tonprobe und echten Testalarm mit den eigenen Einstellungen durchführen. |
| Akku-/Hintergrundbeschränkungen des Herstellers | Beschränkte Apps können Alarme verpassen. Bei Problemen Nexus in den Geräte-Einstellungen prüfen; eine pauschale Zusage für alle Hersteller gibt es nicht. |
| Ausgeschaltetes Gerät oder „Beenden erzwingen“ | Darauf darf kein Weckversprechen gestützt werden. Nach erneutem App-Start den nächsten Alarm kontrollieren. |

Genaue Alarme und die Wiederherstellung nach einem Neustart folgen den
[Android-Alarmregeln](https://developer.android.com/develop/background-work/services/alarms).
Der Quellstand sieht eine Neuplanung nach Neustart, Uhrzeit-/Zeitzonenänderung
und App-Update vor. Nach einem Neustart das Gerät zunächst entsperren und den
angezeigten nächsten Alarm kontrollieren; vor der ersten Entsperrung wird hier
keine Funktion zugesichert. Die Anzeige unterliegt den
[Regeln für zeitkritische Benachrichtigungen](https://developer.android.com/develop/ui/views/notifications/time-sensitive)
und den [Vollbildbeschränkungen ab Android 14](https://developer.android.com/about/versions/14/behavior-changes-14#secure-fsi).
Hersteller können [zusätzliche Hintergrundbeschränkungen](https://developer.android.com/develop/background-work/background-tasks/bg-work-restrictions)
anwenden. Eine automatische Anzeige oder das Umgehen einer Gerätesperre wird
nicht zugesagt.

## Lokal wecken und Morgenroutine laden

Der native Weckplan und die importierte Audiodatei liegen auf dem Telefon. Ein
bereits eingerichteter Alarm benötigt beim Auslösen keine Verbindung zu Render,
Supabase oder zum Internet. Diese Trennung ist im Quellcode vorgesehen; die
tatsächliche Offline-Auslösung auf einem realen Gerät ist noch zu prüfen.

Die Morgenroutine ist Teil der gehosteten Nexus-Oberfläche. Der erste Start,
eine erforderliche Anmeldung oder ein fehlender Offline-Cache können eine
Internetverbindung verlangen. Ein offline klingelnder Alarm beweist keinen
Offline-Start der vollständigen WebView und keine Cloud-Synchronisierung.
MP3 und Weckeraktivierung werden nicht auf andere Geräte übertragen. Die
Browser-/PWA-Version erhält durch die Installation der APK keine nativen
Weckerrechte.

## Noch ausstehender Auslieferungsnachweis

Folgende Angaben erst nach tatsächlicher Prüfung ergänzen:

- bestätigte Render-Adresse und die damit fest verbundene APK;
- signierte Release-APK: Dateiname, Download-Adresse, Dateigröße und SHA-256;
- mit `apksigner verify --verbose --print-certs` bestätigte Signatur und
  öffentlicher Zertifikat-Fingerabdruck, ohne private Schlüssel oder Passwörter;
- echter Android-Test: Gerät/Version, Tonimport und Tonprobe, gesperrter
  Bildschirm, Schlummern, Aufstehen, verweigerte Freigaben, Flugmodus,
  Prozessende, Neustart sowie Uhrzeit-/Zeitzonenwechsel;
- Übergang zur Routine mit erforderlicher Anmeldung und ohne Netzwerk.

Diese Liste dokumentiert offene Nachweise. Sie ersetzt weder einen Build noch
eine Geräteprüfung. Die allgemeine
[Android-Realgeräteprüfung](android-pruefung.md) bleibt zusätzlich relevant.

## Deployment-Dateiliste für OP-0186

`node scripts/release186-manifest.mjs` erzeugt
`.work/release186-manifest.json`. Zulässig sind `src/`, `server/`, `public/` und
die acht ausdrücklich benannten Build-/Deployment-Konfigurationsdateien.
Verborgene Pfade, Geheimnisdateien, Testquellen und lokale Ergebnisse werden
ausgeschlossen. `public/downloads/` ist standardmäßig ausgeschlossen.

Eine tatsächlich vorhandene, separat signaturgeprüfte APK wird ausdrücklich
hinzugefügt:

```powershell
node scripts/release186-manifest.mjs --apk public/downloads/DATEINAME.apk
```

Grenzen: 8 MiB je Quelldatei, 64 MiB für eine APK, 96 MiB insgesamt und 5.000
Dateien. Eine fehlende APK, ein unzulässiger Pfad, symbolische Links im gewählten
Dateibaum oder Geheimnis-Muster lassen die Freigabe fehlschlagen. Das Manifest
enthält Dateipfad, Bytezahl und SHA-256 sowie einen Gesamtfingerabdruck; keine
Dateiinhalte oder Schlüsselwerte. Musterfunde nennen nur Pfad, Zeile und Regel.
Bei Fehlern bleibt die Upload-Dateiliste leer.

Die Musterprüfung erkennt nicht jedes mögliche Geheimnis und entpackt die APK
nicht. Ihr ZIP-Dateikopf wird geprüft; das ersetzt keine Signatur- oder
Inhaltsprüfung der APK. Vor dem Upload nach allen Änderungen neu erzeugen und
beim Einlesen der Upload-Dateien die Hashes erneut vergleichen. Das Skript
führt keinen Upload, Commit, Build oder Deploy aus.

## Ergänzender Integrationsstand OP0187

SDK nach bestätigter Lizenzannahme eingerichtet. Native Receiver, persistenter Morgenrequest, Größen-/Rotationsschutz und private Statusmeldungen integriert; Debugbuild nach den Korrekturen erfolgreich. Dateiimport und Text-/JSON-Export verwenden Androids Systemdateiauswahl; maximal 20 MiB UTF-8. Erst ein abgeschlossener Schreibvorgang bestätigt den Export. Abbruch oder Fehler verhindert nachfolgendes Ersetzen/Zurücksetzen im Einstellungsablauf. Mikrofonzugang verlangt die genaue App-Origin und die Android-Berechtigung. Ein aktiver Wecker kann auch über die native Leiste gestoppt werden.

Prüfungen: 19 Bridge-Unitfälle, 41 Scheduler-/Receiver-Hostchecks, sechs Manifestchecks und vier Chromium-Webfälle bestanden. Keine native Alarm-, Audio-, Mikrofon- oder Dateipickerprüfung behauptet. Endgültige Render-Adresse, SMTP-Anbindung und signierte Release-Datei fehlen weiterhin.

Die Upload-Dateiliste umfasst inzwischen zusätzlich android/app/src sowie die einzeln benannten Android-Gradledateien, den Toolchain-Bootstrap und diese Anleitung. Lokale SDKs, Buildausgaben und Signierschlüssel sind nicht enthalten.
