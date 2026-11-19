// Thin clients for Gnani Prisma (streaming STT), Timbre (streaming TTS) and Evon (LLM).
// The API key lives only here, server-side; browsers can't set WebSocket headers anyway.
import WebSocket from 'ws';

const STT_URL = 'wss://api.vachana.ai/stt/v3/stream';
const TTS_URL = 'wss://api.vachana.ai/api/v1/tts';
const LLM_URL = 'https://api.vachana.ai/v1/chat/completions';

export const TTS_SAMPLE_RATE = 24000;

// Prisma v3.0 wants non-ASCII keyterms JSON-escaped inside the header value.
function asciiJson(v) {
  return JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

export function openStt({ apiKey, languageCode, keyterms = [], model, format, onMessage, onClose, onOpen }) {
  const headers = {
    'x-api-key-id': apiKey,
    model,
    language_code: languageCode,
    format,
    'x-sample-rate': '16000',
    // Live partial transcripts every ~450 ms (not in the public docs; the `connected` frame
    // echoes partials_enabled). Messages then arrive as partial_transcript / final_transcript.
    'x-partials': 'true',
    // Household and street noise: a stricter speech gate, and a short stray-sound floor.
    'x-vad-threshold': '0.6',
    'x-min-speech-ms': '200',
    'x-min-segment-ms': '200',
    // Dictation has natural pauses ("wajan... 52 kilo"); 700 ms keeps phrases whole.
    // Short answers are cut faster by the client's own end-of-speech "commit".
    'x-min-silence-ms': '700',
    'x-max-speech-s': '20',
    'x-idle-timeout-sec': '600',
    topic: 'ASHA worker home visit notes: pregnancy (ANC), newborn (HBNC), immunisation, vaccines, weight, danger signs',
  };
  if (keyterms.length) headers.keyterms = asciiJson(keyterms.slice(0, 200));
  const ws = new WebSocket(STT_URL, { headers });
  ws.on('open', () => onOpen?.());
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try { onMessage(JSON.parse(data.toString())); } catch { /* ignore malformed frame */ }
  });
  ws.on('unexpected-response', (_req, res) => {
    onMessage({ type: 'error', message: `STT handshake failed (${res.statusCode})` });
  });
  ws.on('error', (err) => onMessage({ type: 'error', message: `STT: ${err.message}` }));
  ws.on('close', (code) => onClose?.(code));
  return ws;
}

// One TTS socket handles one synthesis at a time. We keep a warm spare so a new reply
// never pays the TLS + WebSocket handshake, and a cancelled reply just drops its socket.
export class TtsPool {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.idle = [];
    this.closed = false;
    this.warm();
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(TTS_URL, { headers: { 'X-API-Key-ID': this.apiKey } });
      const fail = (e) => reject(e instanceof Error ? e : new Error(String(e)));
      ws.on('error', () => {}); // a socket error after open must not crash the process
      ws.once('open', () => resolve(ws));
      ws.once('error', fail);
      ws.once('unexpected-response', (_q, res) => fail(new Error(`TTS handshake failed (${res.statusCode})`)));
    });
  }

  warm() {
    if (this.closed || this.idle.length >= 1) return;
    const p = this.open().catch(() => null);
    this.idle.push(p);
  }

  async take() {
    while (this.idle.length) {
      const ws = await this.idle.shift();
      if (ws && ws.readyState === WebSocket.OPEN) { this.warm(); return ws; }
    }
    const ws = await this.open();
    this.warm();
    return ws;
  }

  // Streams one utterance. Returns a cancel() function.
  async speak({ text, language, voice, model, onChunk, onDone, onError }) {
    let ws;
    try { ws = await this.take(); } catch (e) { onError(e); return () => {}; }
    let finished = false;
    const finish = () => { finished = true; ws.removeAllListeners('message'); };
    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); } catch { return; }
      if (msg.type === 'audio' && msg.data?.audio) onChunk(Buffer.from(msg.data.audio, 'base64'));
      else if (msg.type === 'complete' || msg.data?.is_final) {
        finish();
        onDone();
        if (!this.closed && this.idle.length < 2) this.idle.push(Promise.resolve(ws)); else ws.close();
      } else if (msg.type === 'error') { finish(); onError(new Error(msg.message || 'TTS error')); ws.close(); }
    });
    ws.once('close', () => { if (!finished) { finished = true; onDone(); } });
    ws.send(JSON.stringify({
      text,
      voice,
      model,
      language,
      speed: 1.0,
      audio_config: { sample_rate: TTS_SAMPLE_RATE, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'raw' },
    }));
    return () => { if (!finished) { finished = true; ws.removeAllListeners('message'); ws.close(); } };
  }

  close() {
    this.closed = true;
    for (const p of this.idle) p.then((ws) => ws?.close()).catch(() => {});
    this.idle = [];
  }
}

// Evon LLM: JSON extraction only. Its output never becomes speech directly; the client
// validates every value against the transcript and only fills empty fields.
export async function llmExtract({ apiKey, model, text, lang }) {
  const system = [
    'You extract fields from an Indian ASHA health worker\'s spoken home-visit notes. The notes may be in any Indian language mixed with English.',
    'Reply ONLY with JSON with these keys (use null when not said, never guess):',
    '"beneficiaryId" (string of digits), "name" (string), "visitType" (one of ANC, PNC, HBNC, IMM),',
    '"weightKg" (number, convert grams to kg), "nextVisit" (ISO date YYYY-MM-DD, relative to today ' + new Date().toISOString().slice(0, 10) + '),',
    '"dangerSigns" (array, only from: bleeding, convulsions, severe_headache_vision, fever, hypothermia, severe_abdominal_pain, swelling, reduced_fetal_movement, water_leak, breathing_difficulty, not_feeding, lethargy, jaundice, umbilical_infection, skin_pustules, vomiting_everything, foul_discharge; include a sign only if it is stated as present, not if it is denied).',
    'Do not give any medical advice.',
  ].join(' ');
  const res = await fetch(LLM_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key-ID': apiKey },
    body: JSON.stringify({
      model,
      reasoning_effort: 'none',
      temperature: 0,
      max_tokens: 300,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: `[${lang}] ${text}` }],
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`LLM ${res.status}`);
  const body = await res.json();
  const content = body.choices?.[0]?.message?.content;
  return JSON.parse(content);
}
