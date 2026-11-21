// Checks the language model's reading of a reply before the agent sees it. The model only
// rewrites her words into fixed phrases ("weight 50 kilo", "name Kamla"); anything it could
// have made up is dropped here: a weight, ID or name she did not say.
import { tokenize } from './translit.js';
import { findNumbers } from './numbers.js';

function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  }
  return d[a.length][b.length];
}

// Returns the phrases that survive, joined with commas ('' when none do).
export function checkLine(line, heard) {
  if (typeof line !== 'string' || !line.trim()) return '';
  const toks = tokenize(heard);
  const nums = findNumbers(toks);
  const values = new Set(nums.map((n) => n.value));
  // IDs are read digit by digit, as one number, or in pairs ("das bayalis")
  const digits = new Set(nums.map((n) => n.digitString).filter(Boolean));
  for (let k = 0; k + 1 < nums.length; k++) {
    if (nums[k].digitString && nums[k + 1].digitString) digits.add(nums[k].digitString + nums[k + 1].digitString.padStart(2, '0'));
  }
  digits.add(nums.map((n) => n.digitString || '').join(''));
  const keys = toks.filter((t) => !t.isDigits).map((t) => t.key);

  const keep = [];
  for (const raw of line.split(',')) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    let m = p.match(/^weight (\d+(?:\.\d+)?) kilo$/);
    if (m) { const kg = Number(m[1]); if (values.has(kg) || values.has(kg * 1000)) keep.push(p); continue; }
    m = p.match(/^id (\d{3,6})$/);
    if (m) { if (digits.has(m[1])) keep.push(p); continue; }
    m = p.match(/^name (.+)$/);
    if (m) {
      const words = tokenize(m[1]).filter((t) => !t.isDigits);
      if (words.length && words.every((w) => keys.some((k) => editDistance(k, w.key) <= Math.max(1, Math.floor(w.key.length / 3))))) keep.push(p);
      continue;
    }
    // dates are read back before saving; the rest are fixed words with no value in them
    if (/^next visit \d{1,2}\/\d{1,2}$/.test(p) || /^in \d{1,3} days$/.test(p)) { keep.push(p); continue; }
    if (/^(yes|no|not known|weight not taken|anc visit|pnc visit|hbnc visit|immunisation visit|no vaccine due|weight wrong|date wrong|name wrong|repeat|help)$/.test(p)) { keep.push(p); continue; }
    if (/^(td|bcg|opv|penta|rota|pcv|ipv|mr|je|vitamin a|hepatitis b|dpt) (due|given)$/.test(p)) keep.push(p);
  }
  return keep.join(', ');
}
