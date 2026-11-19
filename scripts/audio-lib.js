// Shared helpers for the audio evals: Timbre TTS to 16 kHz PCM, noise and echo mixing,
// and Prisma streaming STT at real-time cadence with the app's VAD settings.
import 'dotenv/config';
import WebSocket from 'ws';
import { openStt } from '../server/gnani.js';

export const KEY = process.env.GNANI_API_KEY;
const TTS_LANG = { hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN' };
// The live API takes exactly one locale per stream; Prisma v3.0 still transcribes English
// words inside Hindi or Kannada speech (code-mix) with a single locale.
const STT_LANG = { hi: 'hi-IN', en: 'en-IN', kn: 'kn-IN' };
const RATE = 16000;

export function tts(text, lang, voice) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('wss://api.vachana.ai/api/v1/tts', { headers: { 'X-API-Key-ID': KEY } });
    const chunks = [];
    ws.on('open', () => ws.send(JSON.stringify({
      text, voice, model: 'timbre-v3.0', language: TTS_LANG[lang], speed: 1.0,
      audio_config: { sample_rate: RATE, num_channels: 1, sample_width: 2, encoding: 'linear_pcm', container: 'raw' },
    })));
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'audio' && m.data?.audio) chunks.push(Buffer.from(m.data.audio, 'base64'));
      else if (m.type === 'complete' || m.data?.is_final) { ws.close(); resolve(toF32(Buffer.concat(chunks))); } else if (m.type === 'error') { ws.close(); reject(new Error(m.message)); }
    });
    ws.on('error', reject);
  });
}

export function toF32(pcm) {
  const n = pcm.length >> 1;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = pcm.readInt16LE(i * 2) / 32768;
  return out;
}

export function toPcm(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(f32[i] * 32767))), i * 2);
  return out;
}

const power = (x) => { let p = 0; for (const v of x) p += v * v; return p / Math.max(1, x.length); };
export const silence = (ms) => new Float32Array(Math.round((RATE * ms) / 1000));
export function concat(...parts) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// Adds `other` into `base` starting at `atMs`, scaled to `relDb` relative to base's speech power.
export function overlay(base, other, atMs, relDb, refPower = power(base)) {
  const out = Float32Array.from(base);
  const g = Math.sqrt((refPower * 10 ** (relDb / 10)) / Math.max(1e-12, power(other)));
  const at = Math.round((RATE * atMs) / 1000);
  for (let i = 0; i < other.length && at + i < out.length; i++) out[at + i] += other[i] * g;
  return out;
}

// Street noise: pink noise with intermittent horn bursts.
export function street(n) {
  const out = new Float32Array(n);
  let b0 = 0; let b1 = 0; let b2 = 0;
  for (let i = 0; i < n; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + w * 0.099046; b1 = 0.963 * b1 + w * 0.2965164; b2 = 0.57 * b2 + w * 1.0526913;
    let v = b0 + b1 + b2 + w * 0.1848;
    if (i % 32000 < 4000) v += 0.6 * Math.sin((2 * Math.PI * 440 * i) / 16000);
    out[i] = v;
  }
  return out;
}

// Babble: several people talking at once (other voices, unrelated chatter), looped.
const CHATTER = [
  ['hi', 'Shivani', 'अरे सुनो, कल बाज़ार में सब्ज़ी बहुत महंगी थी, टमाटर तो अस्सी रुपये किलो हो गया है।'],
  ['en', 'Sohini', 'So the meeting got moved to Friday and nobody told the accounts team about it at all.'],
  ['hi', 'Sunaina', 'बच्चों का स्कूल अगले हफ्ते से खुल रहा है, बस का पास बनवाना पड़ेगा।'],
  ['hi', 'Shivani', 'मैंने कहा था ना कि बारिश होगी, छाता लेकर चलो, पर कोई सुनता ही नहीं।'],
];
let babbleCache = null;
export async function babble(n) {
  if (!babbleCache) {
    const voices = await Promise.all(CHATTER.map(([l, v, t]) => tts(t, l, v)));
    babbleCache = voices;
  }
  const out = new Float32Array(n);
  babbleCache.forEach((v, k) => {
    const off = Math.floor((k * v.length) / babbleCache.length);
    for (let i = 0; i < n; i++) out[i] += v[(i + off) % v.length];
  });
  return out;
}

export function addNoise(sig, noise, snrDb) {
  const g = Math.sqrt(power(sig) / (Math.max(1e-12, power(noise)) * 10 ** (snrDb / 10)));
  const out = new Float32Array(sig.length);
  for (let i = 0; i < sig.length; i++) out[i] = sig[i] + noise[i % noise.length] * g;
  return out;
}

// Streams audio to Prisma like the app does; returns every final segment with timing.
export function stt(f32, lang, keyterms = []) {
  return new Promise((resolve) => {
    const segs = [];
    let done = false;
    let quiet = null;
    const t0 = Date.now();
    const ws = openStt({
      apiKey: KEY, languageCode: STT_LANG[lang], keyterms, model: 'prisma-v3.0', format: 'transcribe',
      onOpen: async () => {
        const all = toPcm(concat(silence(500), f32, silence(1200)));
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
          segs.push({ text: m.text, at: Date.now() - t0 - 500, latency: m.latency });
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
      resolve(segs);
    }
  });
}
