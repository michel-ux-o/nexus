# Optionales lokales KI-Backend

Node **24** genügt; das Backend verwendet ausschließlich eingebaute Module, `fetch`, `File` und `FormData`. Es greift weder auf IndexedDB noch auf Notizen oder Planungsdateien zu. Es sendet nur ausdrücklich vom Client übermittelte Audioaufnahmen beziehungsweise Texte an die OpenAI-API. Modellantworten werden in Produktion niemals simuliert.

## Einrichtung und Start

`OPENAI_API_KEY` wird ausschließlich in der Umgebung des Serverprozesses hinterlegt. Den Schlüssel weder in `VITE_*`, Browsercode, eine JSON-Sicherung noch in den Chat kopieren. Eine ChatGPT-Anmeldung ersetzt keinen API-Zugang; API-Verbrauch wird separat abgerechnet.

```powershell
# OPENAI_API_KEY zuvor sicher in der Server-Prozessumgebung bereitstellen.
node server/index.mjs
```

Standardadresse: `http://127.0.0.1:8787`. Der Server liefert zugleich den vorhandenen Produktionsbuild aus `dist/`; davor `npm run build` ausführen. Ohne Build sind API-Endpunkte verwendbar, die App-Seite meldet ausdrücklich den fehlenden Build. Der durch die App eingebundene API-/Startbefehl ruft ebenfalls diese Datei auf.

| Umgebungsvariable | Standard | Bedeutung |
| --- | --- | --- |
| `OPENAI_API_KEY` | keiner | Nur serverseitiger API-Zugang; ohne Schlüssel liefern KI-POSTs 503. |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-transcribe` | Modell für `/v1/audio/transcriptions`. |
| `OPENAI_TEXT_MODEL` | `gpt-5.6-terra` | Modell für `/v1/responses`. |
| `NEXUS_API_PORT` | `8787` | Lokaler Port, 1–65535. |
| `NEXUS_ALLOWED_ORIGINS` | leer | Zusätzliche exakte lokale HTTP-Origins, durch Komma getrennt, etwa `http://127.0.0.1:5174`. Keine Pfade, Wildcards oder öffentlichen Hosts. |

Die Frontend-Ports 5173, 4173 und 4175 sind für `localhost`, `127.0.0.1` und `[::1]` freigegeben; ebenso die eigene Server-Origin. Bei einem Vite-Proxy `changeOrigin: true` setzen: Der `Host` muss den tatsächlichen Backend-Port enthalten. Andere Hosts und Origins, einschließlich `Origin: null`, werden abgewiesen. Das Backend bindet beim direkten Start ausschließlich an `127.0.0.1`. Es ist für diesen lokalen Betrieb vorgesehen.

## HTTP-Vertrag

Jeder API-Aufruf benötigt `X-Nexus-Client: nexus-ui`, auch der Status. Ein Browser-Preflight prüft stattdessen Origin, Methode und angeforderte Header. Es gibt keine Cookie-Authentifizierung und keine CORS-Credentials. Fehler haben die Form `{ "error": "Deutsche Erklärung", "code": "MASCHINENCODE" }`.

| Endpunkt | Anfrage | Erfolg |
| --- | --- | --- |
| `GET /api/status` | kein Body | `{ configured, transcriptionModel, textModel }` |
| `POST /api/transcribe` | `multipart/form-data` mit genau `audio` (Datei), `operationId`, `capturedAt`, `timeZone` | `{ transcript: string }` |
| `POST /api/interpret` | JSON mit genau `{ operationId, transcript, capturedAt, timeZone }` | `{ items: CaptureItem[] }` |
| `POST /api/assist` | JSON mit genau `{ operationId, action, prompt }` | `{ text: string }` |

`configured` bestätigt ausschließlich das Vorhandensein einer Serverkonfiguration, keinen erfolgreich geprüften Zugang, Modellzugriff oder Guthabenstand. Ohne Zugang funktionieren die lokalen Notizen und der manuelle KI-Modus weiter.

`operationId`: 1–128 Zeichen, Beginn Buchstabe/Ziffer, danach Buchstaben/Ziffern/`._:-`. `capturedAt`: gültiger UTC-ISO-Zeitpunkt mit `Z`. `timeZone`: gültige IANA-Zeitzone. Relative Angaben werden auf den Aufnahmezeitpunkt in dieser Zeitzone bezogen. Kalenderdaten sind `YYYY-MM-DD`, Uhrzeiten `HH:mm`; Wochen beginnen montags. Planungsdatum und Fälligkeit bleiben getrennt.

Das genaue DTO entspricht `src/planning/types.ts`:

```typescript
interface CaptureItem {
  itemId: string;
  intent: 'create' | 'change' | 'delete' | 'unclear';
  sourceText: string;
  title: string;
  description: string;
  priority: 'low' | 'normal' | 'high' | null;
  estimatedMinutes: number | null;
  dueDate: string | null;
  plannedDate: string | null;
  plannedWeek: string | null;
  startTime: string | null;
  durationMinutes: number | null;
  questions: string[];
  suggestions: string[];
}
```

Die Responses-Anfrage verwendet `text.format` mit `json_schema`, `strict: true`, allen Feldern als Pflichtfeldern und `additionalProperties: false`. Nicht genannte optionale Werte sind `null`. `store: false` ist für Responses gesetzt. Es werden keine Tools oder Datenquellen freigegeben. Vertrauenswürdiger Zeit-/Zeitzonenkontext steht getrennt vom unzuverlässigen Transkript. Bei `/api/assist` wird nur der explizite Client-Prompt mit der gewählten Aktion weitergegeben; der Server sammelt keine weiteren Inhalte.

Der Server validiert die Modellantwort erneut: exakte Feldmenge und Typen, Grenzen, echte Kalenderdaten, Wochenbeginn, lokale DST-Lücken/Mehrdeutigkeiten, unvollständige Zeitblöcke, Datumswidersprüche und Quelltext-Herkunft. `sourceText` muss eine exakte zusammenhängende Stelle im Transkript sein. Ohne diese Herkunft wird `intent: unclear` samt Rückfrage zurückgegeben. Erkannte unbelegte Zeitangaben oder doppelte Extraktion derselben Quellstelle erhalten ebenfalls Rückfragen. Diese Prüfung ergänzt den Prompt; sie ist keine allgemeine semantische Beweisführung für beliebige Sprache. Änderungs-/Löschwünsche sind immer Vorschläge mit Rückfrage. Der Server speichert oder ändert keine Aufgaben.

`itemId` wird ausschließlich aus einem SHA-256-Hash der exakten Quellstelle und ihrem Auftretensindex erzeugt; die vom Modell gelieferte ID wird ignoriert. Exakte Wiederholungen desselben Verarbeitungsschritts mit gleicher `operationId` und gleichem Nutzdatenhash teilen einen laufenden oder erfolgreichen Request. Ein bearbeitetes Transkript darf mit derselben Aufnahme-ID neu interpretiert werden; unveränderte Quellstellen behalten ihre IDs. Die dauerhafte Vermeidung doppelter Aufgaben liegt zusätzlich im lokalen Capture-Ledger der App.

## Grenzen, Abbruch und Datenhaltung

- Audio maximal **20 MiB**, Multipart-Body maximal zusätzliche 64 KiB; erlaubte Formate WebM, MP4/M4A, Ogg, WAV und MPEG/MP3 mit passendem Dateikopf. Der Benutzerdateiname wird durch einen festen Namen ersetzt.
- JSON maximal 256 KiB; Transkript maximal 60.000 Zeichen, Assistenzprompt 100.000 Zeichen, Ausgabe 120.000 Zeichen; maximal 100 Capture-Items. Minutenwerte sind ganze Zahlen zwischen 1 und 1440 oder `null`.
- OpenAI-Antworten maximal 2 MiB; OpenAI-Zeitlimit 60 Sekunden, gesamter lokaler Request 90 Sekunden. Browserabbruch oder Verbindungsende bricht den Upstream-Aufruf ab. Langsame Uploads und Antwortstreams unterliegen demselben Limit.
- Maximal vier gleichzeitig verarbeitete KI-Anfragen; weitere erhalten 429. Keine automatische versteckte Wiederholung kostenpflichtiger Aufrufe. Der Nutzer kann einen fehlgeschlagenen Request erneut auslösen.
- Kurzlebiger Arbeitsspeichercache: zehn Minuten, maximal 100 Einträge und 8 MiB. Nur Hashes und erfolgreiche begrenzte Antworten, keine Audio-Dateien oder rohen Audio-Bytes. Transkriptionstext ist Teil der kurzlebig zwischengespeicherten Antwort. Abbrüche/Fehler werden nicht gespeichert. Neustart entfernt den Cache; er ist kein dauerhaftes Journal.
- Audio wird ausschließlich im Arbeitsspeicher verarbeitet und nach Verarbeitung freigegeben. Der Server schreibt keine Audioaufnahmen, Transkripte, Prompts, Antworten oder Schlüssel in Dateien oder Logs. Native Speicherfreigabe erfolgt durch den Garbage Collector; es gibt keine Zusicherung physischer Sofortlöschung von RAM.
- Upstream-Fehlertexte werden nicht an den Browser durchgereicht. Nicht eingerichteter Zugang: 503; Eingabefehler: 400/413/415; unzulässiger lokaler Zugriff: 403; Auslastung: 429; OpenAI-/Schemafehler: 502; Zeitlimit: 504; Modellablehnung: 422. Unvollständige Responses werden nicht als Erfolg übernommen.

## Prüfung und Quellen

```powershell
node --test tests/server/*.test.mjs
```

Die Tests starten echte lokale HTTP-Server und injizieren ausschließlich für Tests einen Fetch-Stub. Sie prüfen die tatsächlich erzeugten REST-Payloads, sichere HTTP-Grenzen, Validierung, Cache, Fehler, Größen, Timeouts und Verbindungsabbruch. **Kein echter OpenAI-Aufruf wurde ohne verfügbaren API-Zugang getestet.** Die Implementierung enthält keine Produktions-Stubs.

Offizielle OpenAI-Dokumentation, am 12.11.2026 geöffnet: [Dateitranskription](https://developers.openai.com/api/docs/guides/speech-to-text), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), [GPT-Transcribe](https://developers.openai.com/api/docs/models/gpt-transcribe) und [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra). Die Transkriptionsanfrage verwendet für `gpt-transcribe` den aktuellen Sprachhinweis `languages[]=de`; bei einem explizit konfigurierten anderen Transkriptionsmodell wird der ältere Einzelhinweis `language=de` verwendet, dessen Modellkompatibilität der Betreiber prüfen muss.

`createAppServer(options?)` liefert einen regulären `http.Server`; der Import startet keinen Listener. Test-/Einbettungsoptionen sind `env`, `apiKey`, `fetchImpl`, `transcriptionModel`, `textModel`, `allowedOrigins`, `distDir`, `timeoutMs`, `requestTimeoutMs`, `maxActiveRequests`, `cacheOptions` sowie nach unten begrenzbare `maxAudioBytes` und `maxJsonBytes`. Endpunkt und TLS der echten OpenAI-API sind fest verdrahtet; es gibt keinen vom Browser steuerbaren Upstream oder Schlüssel.
