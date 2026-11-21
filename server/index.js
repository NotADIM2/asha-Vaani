// ASHA Vaani server: serves the PWA and relays one WebSocket per phone to Gnani.
//   phone mic (16 kHz PCM) --ws--> here --ws--> Prisma STT   (transcripts flow back)
//   agent reply text       --ws--> here --ws--> Timbre TTS   (PCM chunks stream back)
// Stateless by design: no transcript or audio is logged or stored on the server.
import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';
import { openStt, TtsPool, llmExtract, llmInterpret, TTS_SAMPLE_RATE } from './gnani.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
// Local runs listen on this computer only; the deploy sets HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
// GNANI_ENABLED=0 is the kill switch: everyone gets the free browser voice.
const KEY = process.env.GNANI_ENABLED === '0' ? '' : (process.env.GNANI_API_KEY || '');
// Credits are spent only for visitors who bring this code (?code=... once; the page keeps it).
// This computer itself never needs the code; without a code set, nobody else gets Gnani.
const ACCESS_CODE = process.env.ACCESS_CODE || '';
const STT_MODEL = process.env.STT_MODEL || 'prisma-v3.0';
const STT_FORMAT = process.env.STT_FORMAT || 'transcribe';
// The challenge mandates Prisma v3.0 (STT) and Timbre v3.0 (TTS).
const TTS_MODEL = process.env.TTS_MODEL || 'timbre-v3.0';
const LLM_ENABLED = process.env.LLM_ENABLED !== '0';
const LLM_MODEL = process.env.LLM_MODEL || 'evon-v3.5';
// All ten Prisma / Timbre languages. Prisma writes numbers as digits in every one of them.
const LANGS = ['hi', 'en', 'kn', 'mr', 'ta', 'te', 'bn', 'gu', 'ml', 'pa'];
const okLang = (l) => LANGS.includes(l);
// Every Timbre v3.0 voice speaks all 10 languages. Sunaina ("grounded and natural, rural
// outreach") is the default everywhere, so the agent keeps one voice when the ASHA
// switches language. TTS_VOICE_TA etc. override per language.
const VOICES = Object.fromEntries(LANGS.map((l) => [l, process.env[`TTS_VOICE_${l.toUpperCase()}`] || 'Sunaina']));
// The live API takes exactly one locale per stream; Prisma v3.0 still transcribes English
// words inside any Indic speech (code-mix), and follows the speaker into another language.
const STT_LANG = Object.fromEntries(LANGS.map((l) => [l, `${l}-IN`]));

// ---- credit guard -------------------------------------------------------------------
// Hard daily ceiling across all visitors (India date), kept in usage.json so a restart
// does not reset it. Past the ceiling the app falls back to the browser's free voice.
const BUDGET = {
  sttSec: Number(process.env.DAILY_STT_MINUTES || 45) * 60,
  ttsChars: Number(process.env.DAILY_TTS_CHARS || 30000),
  llm: Number(process.env.DAILY_LLM_CALLS || 150),
};
const USAGE_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'usage.json');
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const freshUsage = () => ({ day: today(), sttSec: 0, ttsChars: 0, llm: 0 });
let usage = (() => {
  try { const u = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); if (u.day === today()) return u; } catch { /* first run */ }
  return freshUsage();
})();
let usageDirty = false;
const warned = new Set();
function spend(kind, amount) {
  if (usage.day !== today()) { usage = freshUsage(); warned.clear(); }
  if (usage[kind] + amount > BUDGET[kind]) {
    if (!warned.has(kind)) { warned.add(kind); console.warn(`Daily ${kind} budget reached; Gnani paused until midnight IST.`); }
    return false;
  }
  usage[kind] += amount;
  usageDirty = true;
  return true;
}
const budgetLeft = () => { if (usage.day !== today()) return true; return usage.sttSec < BUDGET.sttSec && usage.ttsChars < BUDGET.ttsChars; };
setInterval(() => {
  if (!usageDirty) return;
  usageDirty = false;
  fs.writeFile(USAGE_FILE, JSON.stringify(usage), () => {});
}, 5000).unref();

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
function codeOk(code) {
  const a = Buffer.from(String(code || ''));
  const b = Buffer.from(ACCESS_CODE);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// socketAddr is the TCP peer, which a client cannot fake (unlike X-Forwarded-For).
function gnaniAllowed(socketAddr, code) {
  if (!KEY || !budgetLeft()) return false;
  return LOOPBACK.has(socketAddr) || (Boolean(ACCESS_CODE) && codeOk(code));
}
const TTS_LANG = STT_LANG;

// Per-key sliding-window limiter. The deployed link is public, so every route that spends
// Gnani credits is capped per IP and per connection.
function limiter(max, windowMs) {
  const hits = new Map();
  setInterval(() => { const cut = Date.now() - windowMs; for (const [k, v] of hits) { const keep = v.filter((t) => t > cut); if (keep.length) hits.set(k, keep); else hits.delete(k); } }, windowMs).unref();
  return (key) => {
    const now = Date.now();
    const list = (hits.get(key) || []).filter((t) => t > now - windowMs);
    if (list.length >= max) { hits.set(key, list); return false; }
    list.push(now);
    hits.set(key, list);
    return true;
  };
}
const extractLimit = limiter(12, 60_000); // LLM calls per IP per minute
const connectLimit = limiter(20, 60_000); // new sockets per IP per minute
const MAX_SOCKETS_PER_IP = 4;
const socketsByIp = new Map();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1); // Render/Railway put one proxy in front; needed for per-IP limits
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; media-src 'self' blob:; worker-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  res.setHeader('X-Frame-Options', 'DENY');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
  next();
});
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'], maxAge: 0 }));

app.get('/api/config', (req, res) => {
  const ok = gnaniAllowed(req.socket.remoteAddress, req.query.code);
  res.json({ gnani: ok, llm: ok && LLM_ENABLED && !llmDenied, sttModel: STT_MODEL, ttsModel: TTS_MODEL, ttsSampleRate: TTS_SAMPLE_RATE });
});
app.get('/healthz', (_req, res) => res.send('ok'));

// Evon allows one request at a time on the free plan, so calls queue here. A key without
// the LLM scope gets 403 on every call: after the first, the model is reported off so the
// app stops waiting on it.
let llmDenied = false;
const llmFailed = (res, e) => { if (e?.status === 403 || e?.status === 401) llmDenied = true; res.status(e?.status === 403 ? 403 : 502).json({ error: 'llm failed' }); };
let llmChain = Promise.resolve();
let llmQueued = 0;
app.post('/api/extract', (req, res) => {
  if (!LLM_ENABLED || llmDenied || !gnaniAllowed(req.socket.remoteAddress, req.get('x-access-code'))) return res.status(403).json({ error: 'llm disabled' });
  if (!extractLimit(req.ip) || llmQueued >= 5 || !spend('llm', 1)) return res.status(429).json({ error: 'busy' });
  const text = String(req.body?.text || '').slice(0, 1500);
  const lang = okLang(req.body?.lang) ? req.body.lang : 'hi';
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  llmQueued++;
  llmChain = llmChain.then(async () => {
    try { res.json(await llmExtract({ apiKey: KEY, model: LLM_MODEL, text, lang })); } catch (e) { llmFailed(res, e); } finally { llmQueued--; }
  });
});

// A reply the rule-based parser could not read: the model rewrites it into phrases it can.
const EXPECTS = ['beneficiary', 'visitType', 'weightKg', 'vaccinesDue', 'nextVisit', 'confirm'];
app.post('/api/interpret', (req, res) => {
  if (!LLM_ENABLED || llmDenied || !gnaniAllowed(req.socket.remoteAddress, req.get('x-access-code'))) return res.status(403).json({ error: 'llm disabled' });
  if (!extractLimit(req.ip) || llmQueued >= 5 || !spend('llm', 1)) return res.status(429).json({ error: 'busy' });
  const text = String(req.body?.text || '').slice(0, 600);
  const lang = okLang(req.body?.lang) ? req.body.lang : 'hi';
  const expect = EXPECTS.includes(req.body?.expect) ? req.body.expect : null;
  if (!text.trim()) return res.status(400).json({ error: 'empty' });
  llmQueued++;
  llmChain = llmChain.then(async () => {
    try { res.json(await llmInterpret({ apiKey: KEY, model: LLM_MODEL, text, lang, expect })); } catch (e) { llmFailed(res, e); } finally { llmQueued--; }
  });
});

// Errors (bad JSON, oversized body) get a short reply; stack traces never reach the client.
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err.message);
  res.status(status).json({ error: status === 413 ? 'too large' : 'bad request' });
});

const wss = new WebSocketServer({
  noServer: true,
  path: '/ws',
  maxPayload: 64 * 1024,
  // Only our own page may open the socket from a browser (blocks other sites from
  // borrowing it with a visitor's browser).
  verifyClient: ({ origin, req }) => {
    if (!origin) return true;
    try { return new URL(origin).host === req.headers.host; } catch { return false; }
  },
});
let sessions = 0;

wss.on('connection', (client, req) => {
  // the hosting proxy appends the real client IP last; earlier entries can be forged
  const ip = (req.headers['x-forwarded-for'] || '').split(',').pop().trim() || req.socket.remoteAddress || '?';
  const allowed = gnaniAllowed(req.socket.remoteAddress, new URL(req.url, 'http://x').searchParams.get('code'));
  if (sessions >= 50 || !connectLimit(ip) || (socketsByIp.get(ip) || 0) >= MAX_SOCKETS_PER_IP) { client.close(1013, 'busy'); return; }
  sessions++;
  socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
  const sayLimit = limiter(40, 60_000); // TTS requests per connection per minute
  let ttsChars = 0; // TTS characters this session (cap below)
  let lang = 'hi';
  let keyterms = [];
  let stt = null;
  let sttReady = false;
  let pending = []; // audio frames buffered while the STT socket opens
  const tts = allowed ? new TtsPool(KEY) : null;
  const cancels = new Map();

  const send = (obj) => { if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(obj)); };

  function connectStt() {
    if (!allowed) return;
    sttReady = false;
    const sock = openStt({
      apiKey: KEY,
      languageCode: STT_LANG[lang] || 'hi-IN',
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
      if (!allowed || data.length > 4096 || data.length % 2) return; // 16-bit PCM frames only
      if (!spend('sttSec', data.length / 32000)) { // 16 kHz x 2 bytes = 32000 bytes per second
        if (stt) { const old = stt; stt = null; old.close(); }
        send({ type: 'budget' });
        return;
      }
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
        lang = okLang(msg.lang) ? msg.lang : 'hi';
        if (Array.isArray(msg.keyterms)) keyterms = msg.keyterms.filter((k) => typeof k === 'string' && k.length < 60).slice(0, 200);
        if (stt) { const old = stt; stt = null; old.close(); }
        connectStt();
        send({ type: 'ready', gnani: allowed, lang });
        break;
      }
      case 'commit':
        if (stt && sttReady) stt.send(JSON.stringify({ type: 'commit' }));
        break;
      case 'say': {
        const id = Number(msg.id) >>> 0;
        const text = String(msg.text || '').slice(0, 1200);
        const l = okLang(msg.lang) ? msg.lang : lang;
        if (!tts || !text) { send({ type: 'tts_error', id, message: 'tts unavailable' }); break; }
        if (!sayLimit('say') || ttsChars + text.length > 60_000 || !spend('ttsChars', text.length)) { send({ type: 'tts_error', id, message: 'rate limited' }); break; }
        ttsChars += text.length;
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
    const n = (socketsByIp.get(ip) || 1) - 1;
    if (n > 0) socketsByIp.set(ip, n); else socketsByIp.delete(ip);
    if (stt) stt.close();
    stt = null;
    for (const c of cancels.values()) c();
    cancels.clear();
    tts?.close();
  });
  client.on('error', () => {});
});

// "localhost" may resolve to IPv6 (::1) or IPv4 (127.0.0.1) depending on the browser, so a
// local run listens on both loopback addresses; both are still this computer only.
const hosts = HOST === '127.0.0.1' ? ['127.0.0.1', '::1'] : [HOST];
for (const h of hosts) {
  const srv = http.createServer(app);
  srv.on('upgrade', (req, socket, head) => {
    if (!wss.shouldHandle(req)) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });
  srv.on('error', (e) => {
    if (h === '::1') return; // no IPv6 on this machine: IPv4 alone is fine
    console.error(`Cannot listen on ${h}:${PORT}: ${e.message}`);
    process.exit(1);
  });
  srv.listen(PORT, h, h === hosts[0] ? announce : undefined);
}

function announce() {
  const mode = !KEY ? 'OFF: browser speech fallback' : ACCESS_CODE ? 'enabled for this computer + visitors with the access code' : 'enabled for this computer only';
  console.log(`ASHA Vaani on http://localhost:${PORT}  (Gnani ${mode}; listening on ${hosts.join(' + ')})`);
  console.log(`Daily credit guard: ${Math.round(usage.sttSec / 60)}/${BUDGET.sttSec / 60} STT min, ${usage.ttsChars}/${BUDGET.ttsChars} TTS chars, ${usage.llm}/${BUDGET.llm} LLM calls used today`);
}
