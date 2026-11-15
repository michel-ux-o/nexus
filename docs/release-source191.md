# OP0191 – vollständige Render-Quellen

Der erste Render-Build scheiterte an fünf nicht auflösbaren Imports aus
`src/menu/MainMenu.tsx`. Die Quelldateien waren lokal vorhanden, wurden aber durch
die pauschale Verzeichnissperre `artifacts` im Uploadmanifest ausgeschlossen.

Die Ausnahme gilt jetzt ausschließlich für `src/menu/artifacts`. Alle neun dortigen
Anwendungsdateien sind in den Releasecheckout übernommen; generierte Artefakte,
Tests, lokale Daten und Schlüssel bleiben ausgeschlossen. Das Manifestskript selbst
ist ebenfalls Bestandteil der veröffentlichten Quellen, damit diese Auswahl
nachvollziehbar bleibt.

Prüfung am 15.11.2026:

- Manifest: 196 freigegebene Dateien, 2.012.240 Bytes; kein Secret-Scan-Befund,
  keine Manifestfehler. SHA-256 des Inhaltsmanifests:
  `031e4b614b80cf59b254a0200cafe50a5db2cc453f4ebc2222b28e88f59c5f22`.
- Alle 196 Manifestdateien sind im Releasecheckout vorhanden und stimmen byteweise
  mit den geprüften Quellversionen überein.
- TypeScript im Releasecheckout erfolgreich.
- Nativer Vite-Produktionsbuild im Releasecheckout erfolgreich:
  `index-siGkcEpu.js` und `index-DCK4xwtO.css`. Bestehender Chunkgrößenhinweis.
- Vorhandene übergeordnete `node_modules` verwendet; keine Abhängigkeiten geändert
  oder neu installiert.

Diese Prüfung bestätigt die Vollständigkeit und Baubarkeit der hochgeladenen
Quellen. Ein erfolgreicher Render-Deploy und die öffentliche Erreichbarkeit werden
von der Leitung separat geprüft. Die lokalen Buildausgaben werden nicht committed.
