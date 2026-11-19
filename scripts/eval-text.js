// Scores the understanding layer the way the judges do: field accuracy on names and
// numbers, and danger-sign flags (a missed sign counts double).
// Usage: npm run eval:text
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry } from '../public/js/nlu/registry.js';
import { CASES, EVAL_TODAY } from './eval-cases.js';

const NOW = new Date(...EVAL_TODAY);
const registry = buildRegistry(NOW);

let fieldsTotal = 0;
let fieldsOk = 0;
let signsExpected = 0;
let signsMissed = 0;
let falseFlags = 0;
const failures = [];

for (const c of CASES) {
  const a = new VisitAgent({ lang: c.lang, registry, now: () => NOW });
  a.handle(c.text);
  const f = a.form;
  for (const [k, v] of Object.entries(c.expect)) {
    fieldsTotal++;
    if (f[k] === v) fieldsOk++; else failures.push(`FIELD ${k}: got ${JSON.stringify(f[k])}, want ${JSON.stringify(v)}  <- ${c.text}`);
  }
  for (const d of c.dangers) {
    signsExpected++;
    if (!f.dangers.includes(d)) { signsMissed++; failures.push(`MISSED ${d}  <- ${c.text}`); }
  }
  for (const d of f.dangers) {
    if (!c.dangers.includes(d)) { falseFlags++; failures.push(`FALSE FLAG ${d}  <- ${c.text}`); }
  }
}

const pct = (a, b) => (b ? ((100 * a) / b).toFixed(1) : '100.0');
console.log(`cases: ${CASES.length}`);
console.log(`field accuracy:      ${fieldsOk}/${fieldsTotal} (${pct(fieldsOk, fieldsTotal)}%)`);
console.log(`danger-sign recall:  ${signsExpected - signsMissed}/${signsExpected} (${pct(signsExpected - signsMissed, signsExpected)}%)`);
console.log(`false flags:         ${falseFlags}`);
console.log(`judge-style penalty: ${signsMissed * 2 + falseFlags} (missed x2 + false)`);
if (failures.length) {
  console.log('\nfailures:');
  for (const x of failures) console.log(`  ${x}`);
  process.exitCode = 1;
}
