// End-to-end noisy-audio eval (needs GNANI_API_KEY in .env):
//   eval text -> Timbre v3.0 TTS (16 kHz PCM) -> + noise at a chosen SNR -> Prisma streaming STT
//   (real-time cadence, same VAD settings as the app) -> agent -> score.
// Usage: npm run eval:audio -- [snrDb=10] [limit=all]
import 'dotenv/config';
import WebSocket from 'ws';
import { openStt } from '../server/gnani.js';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry, registryKeyterms } from '../public/js/nlu/registry.js';
import { CASES, EVAL_TODAY } from './eval-cases.js';

const KEY = process.env.GNANI_API_KEY;
if (!KEY) { console.error('Set GNANI_API_KEY in .env first.'); process.exit(1); }
const SNR_DB = Number(process.argv[2] ?? 10);
const LIMIT = Number(process.argv[3] ?? CASES.length);
const NOW = new Date(...EVAL_TODAY);
const registry = buildRegistry(NOW);
// a different voice from the app's, so the eval doesn't only hear the voice the app speaks with
const VOICES = { hi: 'Shivani', en: 'Sohini', kn: 'Shruthi' };
const TTS_LANG = { hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN' };
// The live API takes exactly one locale per stream; Prisma v3.0 still transcribes English
// words inside Hindi or Kannada speech (code-mix) with a single locale.
const STT_LANG = { hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN' };

function tts(text, lang) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.vachana.ai/api/v1/tts', { headers: { 'X-API-Key-ID': KEY } });
    const chunks = [];
    ws.on('open', () => ws.send(JSON.stringify({
      text, voice: VOICES[lang], model: 'timbre-v3.0', language: TTS_LANG[lang], speed: 1.0,
      audio_config: { sample_rate: 16000, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'raw' },
    })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'audio' && m.data?.audio) chunks.push(Buffer.from(m.data.audio, 'base64'));
      else if (m.type === 'complete' || m.data?.is_final) { ws.close(); resolve(Buffer.concat(chunks)); } else if (m.type === 'error') { ws.close(); reject(new Error(m.message)); }
    });
    ws.on('error', reject);
  });
}

// Pink-ish noise plus intermittent "horn" bursts, scaled to the requested SNR.
function addNoise(pcm, snrDb) {
  const n = pcm.length / 2;
  const sig = new Int16Array(pcm.buffer, pcm.byteOffset, n);
  let ps = 0;
  for (let i = 0; i < n; i++) ps += sig[i] * sig[i];
  ps /= n;
  const noise = new Float32Array(n);
  let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    let v = b0 + b1 + b2 + w * 0.1848;
    if (i % 32000 < 4000) v += 0.6 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    noise[i] = v;
  }
  let pn = 0;
  for (let i = 0; i < n; i++) pn += noise[i] * noise[i];
  pn /= n;
  const gain = Math.sqrt(ps / (pn * 10 ** (snrDb / 10)));
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < n; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(sig[i] + noise[i] * gain))), i * 2);
  return out;
}

function stt(pcm, lang) {
  return new Promise((resolve) => {
    const texts = [];
    const latencies = [];
    let done = false;
    let quiet = null;
    const ws = openStt({
      apiKey: KEY, languageCode: STT_LANG[lang], keyterms: registryKeyterms(registry), model: 'prisma-v3.0', format: 'transcribe',
      onOpen: async () => {
        // 0.5 s lead-in, the clip, 1.2 s tail, all at real-time cadence (32 ms per 1024-byte frame)
        const pad = (ms) => Buffer.alloc(Math.round((16000 * ms) / 1000) * 2);
        const all = Buffer.concat([pad(500), pcm, pad(1200)]);
        for (let o = 0; o + 1024 <= all.length; o += 1024) {
          if (done) return;
          ws.send(all.subarray(o, o + 1024));
          await new Promise((r) => setTimeout(r, 32));
        }
        ws.send(JSON.stringify({ type: 'commit' }));
        quiet = setTimeout(finish, 2500);
      },
      onMessage: (m) => {
        if ((m.type === 'transcript' || m.type === 'final_transcript') && m.text) {
          texts.push(m.text);
          if (m.latency) latencies.push(m.latency);
          if (quiet) { clearTimeout(quiet); quiet = setTimeout(finish, 1200); }
        }
        if (m.type === 'error') console.error('  stt error:', m.message);
      },
      onClose: () => finish(),
    });
    function finish() {
      if (done) return;
      done = true;
      try { ws.close(); } catch { /* closed */ }
      resolve({ text: texts.join(' '), latencies });
    }
  });
}

let fieldsTotal = 0; let fieldsOk = 0; let signsExpected = 0; let signsMissed = 0; let falseFlags = 0;
const lat = [];
const cases = CASES.slice(0, LIMIT);
console.log(`Noisy audio eval: ${cases.length} cases, SNR ${SNR_DB} dB\n`);
for (const c of cases) {
  try {
    const clean = await tts(c.text, c.lang);
    const { text, latencies } = await stt(addNoise(clean, SNR_DB), c.lang);
    lat.push(...latencies);
    const a = new VisitAgent({ lang: c.lang, registry, now: () => NOW });
    a.handle(text);
    const f = a.form;
    const errs = [];
    for (const [k, v] of Object.entries(c.expect)) { fieldsTotal++; if (f[k] === v) fieldsOk++; else errs.push(`${k}=${JSON.stringify(f[k])}≠${JSON.stringify(v)}`); }
    for (const d of c.dangers) { signsExpected++; if (!f.dangers.includes(d)) { signsMissed++; errs.push(`missed ${d}`); } }
    for (const d of f.dangers) if (!c.dangers.includes(d)) { falseFlags++; errs.push(`false ${d}`); }
    console.log(`${errs.length ? '✗' : '✓'} ${c.text}\n    heard: ${text}${errs.length ? `\n    ${errs.join(', ')}` : ''}`);
  } catch (e) {
    console.log(`! ${c.text}\n    ${e.message}`);
  }
}
const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '100.0');
lat.sort((x, y) => x - y);
console.log(`\nfield accuracy:     ${fieldsOk}/${fieldsTotal} (${pct(fieldsOk, fieldsTotal)}%)`);
console.log(`danger-sign recall: ${signsExpected - signsMissed}/${signsExpected} (${pct(signsExpected - signsMissed, signsExpected)}%)`);
console.log(`false flags:        ${falseFlags}`);
if (lat.length) console.log(`STT segment latency p50 ${lat[Math.floor(lat.length / 2)]} ms, p90 ${lat[Math.floor(lat.length * 0.9)]} ms`);
