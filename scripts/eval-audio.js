// End-to-end noisy-audio eval (needs GNANI_API_KEY in .env):
//   eval text -> Timbre v3.0 TTS (16 kHz) -> + noise at a chosen SNR -> Prisma streaming STT
//   (real-time cadence, same VAD settings as the app) -> agent -> score.
// Usage: npm run eval:audio -- [snrDb=10] [limit=all] [noise=street|babble] [set=all|danger|regional|<lang>]
//   babble = several other people talking at once (the judging room), the hardest case.
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry, registryKeyterms } from '../public/js/nlu/registry.js';
import { CASES, EVAL_TODAY } from './eval-cases.js';
import { KEY, tts, stt, street, babble, addNoise } from './audio-lib.js';

if (!KEY) { console.error('Set GNANI_API_KEY in .env first.'); process.exit(1); }
const SNR_DB = Number(process.argv[2] ?? 10);
const LIMIT = Number(process.argv[3] || CASES.length);
const NOISE = process.argv[4] || 'street';
const SET = process.argv[5] || 'all';
const NOW = new Date(...EVAL_TODAY);
const registry = buildRegistry(NOW);
// different voices from the app's, so the eval doesn't only hear the voice the app speaks with
const VOICES = { hi: 'Shivani', en: 'Sohini', kn: 'Shruthi' };
const voiceFor = (lang) => VOICES[lang] || 'Shivani';

let fieldsTotal = 0; let fieldsOk = 0; let signsExpected = 0; let signsMissed = 0; let falseFlags = 0;
const lat = [];
const REGIONAL = ['mr', 'ta', 'te', 'bn', 'gu', 'ml', 'pa'];
const pool = SET === 'danger' ? CASES.filter((c) => c.dangers.length)
  : SET === 'regional' ? CASES.filter((c) => REGIONAL.includes(c.lang))
  : SET !== 'all' ? CASES.filter((c) => c.lang === SET) : CASES;
const cases = pool.slice(0, LIMIT);
console.log(`Noisy audio eval: ${cases.length} cases, ${NOISE} noise at SNR ${SNR_DB} dB\n`);
for (const c of cases) {
  try {
    const clean = await tts(c.text, c.lang, voiceFor(c.lang));
    const noise = NOISE === 'babble' ? await babble(clean.length) : street(clean.length);
    const segs = await stt(addNoise(clean, noise, SNR_DB), c.lang, registryKeyterms(registry));
    const text = segs.map((s) => s.text).join(' ');
    lat.push(...segs.map((s) => s.latency).filter(Boolean));
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
