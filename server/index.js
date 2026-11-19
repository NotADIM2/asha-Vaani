// ASHA Vaani server: serves the PWA and relays one WebSocket per phone to Gnani.
//   phone mic (16 kHz PCM) --ws--> here --ws--> Prisma STT   (transcripts flow back)
//   agent reply text       --ws--> here --ws--> Timbre TTS   (PCM chunks stream back)
// Stateless by design: no transcript or audio is logged or stored on the server.
import 'dotenv/config';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { openStt, TtsPool, llmExtract, TTS_SAMPLE_RATE } from './gnani.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const KEY = process.env.GNANI_API_KEY || '';
const STT_MODEL = process.env.STT_MODEL || 'prisma-v3.0';
const STT_FORMAT = process.env.STT_FORMAT || 'transcribe';
// The challenge mandates Prisma v3.0 (STT) and Timbre v3.0 (TTS).
const TTS_MODEL = process.env.TTS_MODEL || 'timbre-v3.0';
const LLM_ENABLED = process.env.LLM_ENABLED !== '0';
const LLM_MODEL = process.env.LLM_MODEL || 'evon-v3.5';
// Every Timbre v3.0 voice speaks all 10 languages. Sunaina ("grounded and natural, rural
// outreach") is recommended for Hindi, English and Kannada, so the agent keeps one voice
// when the ASHA switches language.
const VOICES = {
  hi: process.env.TTS_VOICE_HI || 'Sunaina',
  en: process.env.TTS_VOICE_EN || 'Sunaina',
  kn: process.env.TTS_VOICE_KN || 'Sunaina',
};
const STT_LANG = { hi: 'hi-IN,en-IN', en: 'en-IN,hi-IN', kn: 'kn-IN,en-IN' };
const TTS_LANG = { hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN' };

const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; worker-src 'self'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: '1h' }));

app.get('/api/config', (_req, res) => {
  res.json({ gnani: Boolean(KEY), llm: Boolean(KEY) && LLM_ENABLED, sttModel: STT_MODEL, ttsModel: TTS_MODEL, ttsSampleRate: TTS_SAMPLE_RATE });
});
app.get('/healthz', (_req, res) => res.send('ok'));

// Evon allows one request at a time on the free plan, so calls queue here.
let llmChain = Promise.resolve();
app.post('/api/extract', (req, res) => {
  if (!KEY || !LLM_ENABLED) return res.status(503).json({ error: 'llm disabled' });
  const text = String(req.body?.text || '').slice(0, 1500);
  const lang = ['hi', 'en', 'kn'].includes(req.body?.lang) ? req.body.lang : 'hi';
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  llmChain = llmChain.then(async () => {
    try { res.json(await llmExtract({ apiKey: KEY, model: LLM_MODEL, text, lang })); } catch (e) { res.status(502).json({ error: e.message }); }
  });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024 });
let sessions = 0;

wss.on('connection', (client) => {
  if (sessions >= 50) { client.close(1013, 'busy'); return; }
  sessions++;
  let lang = 'hi';
  let keyterms = [];
  let stt = null;
  let sttReady = false;
  let pending = []; // audio frames buffered while the STT socket opens
  const tts = KEY ? new TtsPool(KEY) : null;
  const cancels = new Map();

  const send = (obj) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj)); };

  function connectStt() {
    if (!KEY) return;
    sttReady = false;
    const sock = openStt({
      apiKey: KEY,
      languageCode: STT_LANG[lang] || 'hi-IN,en-IN',
      keyterms,
      model: STT_MODEL,
      format: STT_FORMAT,
      onOpen: () => {
        if (stt !== sock) return;
        sttReady = true;
        for (const f of pending) sock.send(f);
        pending = [];
      },
      onMessage: (m) => { if (stt === sock) send({ ...m, type: `stt_${m.type}` }); },
      onClose: (code) => {
        if (stt !== sock) return;
        stt = null;
        sttReady = false;
        send({ type: 'stt_closed', code });
      },
    });
    stt = sock;
  }

  client.on('message', (data, isBinary) => {
    if (isBinary) {
      if (!KEY) return;
      if (!stt) connectStt(); // reopen after the 15-minute cap or idle close
      if (sttReady) stt.send(data);
      else if (pending.length < 100) pending.push(data);
      return;
    }
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }
    switch (msg.type) {
      case 'start':
      case 'lang': {
        lang = ['hi', 'en', 'kn'].includes(msg.lang) ? msg.lang : 'hi';
        if (Array.isArray(msg.keyterms)) keyterms = msg.keyterms.filter((k) => typeof k === 'string' && k.length < 60).slice(0, 200);
        if (stt) { const old = stt; stt = null; old.close(); }
        connectStt();
        send({ type: 'ready', gnani: Boolean(KEY), lang });
        break;
      }
      case 'commit':
        if (stt && sttReady) stt.send(JSON.stringify({ type: 'commit' }));
        break;
      case 'say': {
        const id = Number(msg.id) >>> 0;
        const text = String(msg.text || '').slice(0, 1200);
        const l = ['hi', 'en', 'kn'].includes(msg.lang) ? msg.lang : lang;
        if (!tts || !text) { send({ type: 'tts_error', id, message: 'tts unavailable' }); break; }
        const header = Buffer.alloc(4);
        header.writeUInt32LE(id);
        tts.speak({
          text,
          language: TTS_LANG[l],
          voice: VOICES[l],
          model: TTS_MODEL,
          onChunk: (pcm) => { if (client.readyState === WebSocket.OPEN && cancels.has(id)) client.send(Buffer.concat([header, pcm])); },
          onDone: () => { cancels.delete(id); send({ type: 'tts_end', id }); },
          onError: (e) => { cancels.delete(id); send({ type: 'tts_error', id, message: e.message }); },
        }).then((cancel) => { if (cancels.has(id)) cancels.set(id, cancel); else cancel(); });
        cancels.set(id, () => {});
        break;
      }
      case 'cancel': {
        const c = cancels.get(Number(msg.id) >>> 0);
        cancels.delete(Number(msg.id) >>> 0);
        if (c) c();
        break;
      }
      default:
    }
  });

  client.on('close', () => {
    sessions--;
    if (stt) stt.close();
    stt = null;
    for (const c of cancels.values()) c();
    cancels.clear();
    tts?.close();
  });
  client.on('error', () => {});
});

server.listen(PORT, () => {
  console.log(`ASHA Vaani on http://localhost:${PORT}  (Gnani ${KEY ? 'enabled' : 'NOT configured: browser speech fallback'})`);
});
