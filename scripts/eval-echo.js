// Speaker-mode eval (needs GNANI_API_KEY): the phone plays the agent's read-back out loud
// and the mic hears it again, while the worker cuts in with a correction.
//   agent read-back (Timbre, the app's voice) leaked at -15 dB (typical after browser echo
//   cancellation) or -6 dB (echo cancellation off) + worker speech + optional babble
//   -> Prisma streaming STT -> the app's echo guard -> agent.
// Pass = echo alone never becomes input, and the correction lands.
// Usage: npm run eval:echo
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry, registryKeyterms } from '../public/js/nlu/registry.js';
import { stripEcho } from '../public/js/echo.js';
import { EVAL_TODAY } from './eval-cases.js';
import { KEY, tts, stt, babble, addNoise, overlay, concat, silence } from './audio-lib.js';

if (!KEY) { console.error('Set GNANI_API_KEY in .env first.'); process.exit(1); }
const NOW = new Date(...EVAL_TODAY);
const registry = buildRegistry(NOW);
const keyterms = registryKeyterms(registry);

function agentAtReadback() {
  const a = new VisitAgent({ lang: 'hi', registry, now: () => NOW });
  const r = a.handle('सुनीता देवी, आईडी 1042, ए एन सी विज़िट, वज़न 52 किलो, अगली विज़िट 3 दिसंबर');
  return { a, readback: r.say.join(' ') };
}

const { readback } = agentAtReadback();
console.log(`Agent read-back:\n  ${readback}\n`);
const echoAudio = await tts(readback, 'hi', 'Sunaina');
const worker = await tts('नहीं, वज़न चौवन किलो।', 'hi', 'Shivani');
const workerPower = worker.reduce((p, v) => p + v * v, 0) / worker.length;

let pass = 0;
let safeN = 0;
let total = 0;
async function scenario(name, { echoDb, withWorker, babbleDb }) {
  total++;
  // timeline: the agent talks; the worker starts 2.5 s in (barge-in)
  let mix = concat(silence(0), new Float32Array(echoAudio.length + 16000 * 1));
  mix = overlay(mix, echoAudio, 0, echoDb, workerPower);
  if (withWorker) mix = overlay(mix, worker, 2500, 0, workerPower);
  if (babbleDb != null) mix = addNoise(mix, await babble(mix.length), babbleDb);
  const segs = await stt(mix, 'hi', keyterms);
  const { a } = agentAtReadback();
  const used = [];
  for (const s of segs) {
    // every segment here overlaps the agent's speech, so all go through the echo guard
    const g = stripEcho(s.text, [readback], { playing: true });
    if (!g.echo) { used.push(g.rest); a.handle(g.rest); }
  }
  // correct: the correction landed (or, with no worker, nothing changed).
  // safe: whatever STT garbled, no wrong value was recorded (the agent asks again instead).
  const ok = withWorker ? a.form.weightKg === 54 && a.form.beneficiaryId === '1042' : used.length === 0 && a.form.weightKg === 52 && a.form.beneficiaryId === '1042';
  const safe = a.form.beneficiaryId === '1042' && [52, 54].includes(a.form.weightKg);
  if (ok) pass++;
  if (safe) safeN++;
  console.log(`${ok ? '✓' : safe ? '~' : '✗'} ${name}${!ok && safe ? '  (not understood, but nothing wrong recorded)' : ''}`);
  for (const s of segs) console.log(`    heard: ${s.text}`);
  console.log(`    used as worker input: ${used.length ? used.map((u) => `"${u}"`).join(', ') : '(nothing)'}  -> weight ${a.form.weightKg}, person ${a.form.beneficiaryId}`);
}

await scenario('echo alone (-15 dB): agent must not answer itself', { echoDb: -15, withWorker: false });
await scenario('echo alone, echo cancellation off (-6 dB)', { echoDb: -6, withWorker: false });
await scenario('worker cuts in over echo (-15 dB): correction lands', { echoDb: -15, withWorker: true });
await scenario('worker cuts in over loud echo (-6 dB)', { echoDb: -6, withWorker: true });
await scenario('worker cuts in over echo + room babble at 10 dB', { echoDb: -15, withWorker: true, babbleDb: 10 });
console.log(`\nspeaker-mode scenarios: ${pass}/${total} correct, ${safeN}/${total} safe (no wrong data recorded)`);
