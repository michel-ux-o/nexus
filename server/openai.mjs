import { ApiError, CAPTURE_SCHEMA, LIMITS, validateCaptureOutput } from './validation.mjs';
import { ASSIST_INSTRUCTIONS, captureInstructions } from './prompts.mjs';

async function boundedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new ApiError(502, 'UPSTREAM_RESPONSE', 'OpenAI hat keine lesbare Antwort geliefert.');
  const chunks = [];
  let bytes = 0;
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > LIMITS.upstream) throw new ApiError(502, 'UPSTREAM_RESPONSE', 'Die OpenAI-Antwort überschreitet die erlaubte Größe.');
      chunks.push(value);
    }
    signal.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ApiError || signal.aborted) throw error;
    throw new ApiError(502, 'UPSTREAM_RESPONSE', 'OpenAI hat keine gültige JSON-Antwort geliefert.');
  } finally { signal.removeEventListener('abort', abort); reader.releaseLock(); }
}

export function responseText(response) {
  if (!response || response.status !== 'completed' || response.error || response.incomplete_details) {
    throw new ApiError(502, 'INCOMPLETE_RESPONSE', 'Die KI-Antwort wurde nicht vollständig abgeschlossen. Bitte erneut versuchen.');
  }
  if (!Array.isArray(response.output)) throw new ApiError(502, 'UPSTREAM_RESPONSE', 'Die KI-Antwort enthält keinen Text.');
  const parts = [];
  for (const output of response.output) {
    if (output.type !== 'message') continue;
    if (output.status && output.status !== 'completed') throw new ApiError(502, 'INCOMPLETE_RESPONSE', 'Die KI-Nachricht ist unvollständig.');
    if (!Array.isArray(output.content)) continue;
    for (const content of output.content) {
      if (content.type === 'refusal') throw new ApiError(422, 'MODEL_REFUSAL', 'Die KI hat diesen Auftrag abgelehnt. Bitte den Inhalt prüfen.');
      if (content.type === 'output_text' && typeof content.text === 'string') parts.push(content.text);
    }
  }
  const text = parts.join('');
  if (!text.trim() || text.length > LIMITS.output) throw new ApiError(502, 'UPSTREAM_RESPONSE', 'Die KI-Antwort ist leer oder zu lang.');
  return text;
}

export function createOpenAIClient({ apiKey, transcriptionModel = 'gpt-transcribe', textModel = 'gpt-5.6-terra', fetchImpl = globalThis.fetch, timeoutMs = 60_000 } = {}) {
  async function request(path, body, parentSignal) {
    if (!apiKey) throw new ApiError(503, 'NOT_CONFIGURED', 'Das KI-Backend ist nicht eingerichtet. OPENAI_API_KEY muss nur im Serverprozess gesetzt sein.');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = parentSignal ? AbortSignal.any([parentSignal, timeout]) : timeout;
    try {
      signal.throwIfAborted();
      const isForm = body instanceof FormData;
      const response = await fetchImpl(`https://api.openai.com/v1/${path}`, {
        method: 'POST', redirect: 'error', signal,
        headers: { Authorization: `Bearer ${apiKey}`, ...(!isForm && { 'Content-Type': 'application/json' }) },
        body: isForm ? body : JSON.stringify(body),
      });
      // Never expose upstream bodies: they can echo private input or credentials.
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        const status = response.status === 429 ? 429 : 502;
        const code = response.status === 429 ? 'UPSTREAM_RATE_LIMIT' : response.status === 401 || response.status === 403 ? 'UPSTREAM_AUTH' : 'UPSTREAM_HTTP';
        const message = response.status === 429 ? 'OpenAI ist derzeit ausgelastet oder das API-Limit wurde erreicht. Bitte später erneut versuchen.' : code === 'UPSTREAM_AUTH' ? 'OpenAI hat den Serverzugang abgelehnt. Bitte die serverseitige API-Konfiguration prüfen.' : 'Die Anfrage an OpenAI ist fehlgeschlagen. Bitte erneut versuchen.';
        throw new ApiError(status, code, message);
      }
      return await boundedJson(response, signal);
    } catch (error) {
      if (parentSignal?.aborted) throw new ApiError(499, 'CANCELLED', 'Die Anfrage wurde abgebrochen.');
      if (timeout.aborted) throw new ApiError(504, 'UPSTREAM_TIMEOUT', 'OpenAI hat nicht rechtzeitig geantwortet. Die Anfrage wurde abgebrochen.');
      if (error instanceof ApiError) throw error;
      throw new ApiError(502, 'UPSTREAM_UNAVAILABLE', 'OpenAI ist nicht erreichbar. Bitte die Verbindung prüfen.');
    }
  }

  return {
    async transcribe(audio, signal) {
      const form = new FormData();
      form.set('model', transcriptionModel);
      form.set('file', audio, audio.name || 'recording.webm');
      form.set('response_format', 'json');
      if (transcriptionModel === 'gpt-transcribe') form.append('languages[]', 'de');
      else form.set('language', 'de');
      const result = await request('audio/transcriptions', form, signal);
      if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > LIMITS.transcript || result.text.includes('\u0000')) {
        throw new ApiError(502, 'INVALID_TRANSCRIPT', 'Die Transkription ist leer oder ungültig. Bitte die Aufnahme prüfen.');
      }
      return { transcript: result.text };
    },
    async interpret(context, signal) {
      const response = await request('responses', {
        model: textModel, store: false, max_output_tokens: 12_000,
        input: [
          { role: 'system', content: captureInstructions(context) },
          { role: 'user', content: JSON.stringify({ transcript: context.transcript }) },
        ],
        text: { format: { type: 'json_schema', name: 'nexus_capture', strict: true, schema: CAPTURE_SCHEMA } },
      }, signal);
      let parsed;
      try { parsed = JSON.parse(responseText(response)); } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(502, 'INVALID_MODEL_OUTPUT', 'Die KI-Antwort enthält kein gültiges Aufgaben-JSON.');
      }
      return validateCaptureOutput(parsed, context);
    },
    async assist(input, signal) {
      const response = await request('responses', {
        model: textModel, store: false, max_output_tokens: 12_000,
        input: [
          { role: 'system', content: ASSIST_INSTRUCTIONS },
          { role: 'user', content: JSON.stringify({ action: input.action, prompt: input.prompt }) },
        ],
      }, signal);
      return { text: responseText(response) };
    },
  };
}
