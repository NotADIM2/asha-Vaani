// Echo guard for speaker mode (no earbuds): the phone's mic hears the agent's own voice.
// Browser echo cancellation removes most of it, but the leftover still reaches STT, often
// garbled ("बावन किलो" comes back as "52 kg"). Left alone, the agent would answer itself,
// or take the "हाँ" inside its own prompt as the worker saying yes.
//
// stripEcho() aligns what STT heard against what the agent just said. Words that match a
// run of two or more of the agent's words, in order, are echo and are dropped; the rest is
// the worker. So "क्या सब सही है नहीं वजन 54" keeps "नहीं वजन 54".
import { tokenize } from './nlu/translit.js';
import { findNumbers } from './nlu/numbers.js';
import { monthIndex } from './nlu/dates.js';

// Spoken acronyms ("ए एन सी") must meet their written form ("ANC"): both become letter names.
const LETTER_NAMES = { A: 'ए', B: 'बी', C: 'सी', D: 'डी', E: 'ई', F: 'एफ', G: 'जी', H: 'एच', I: 'आई', J: 'जे', K: 'के', L: 'एल', M: 'एम', N: 'एन', O: 'ओ', P: 'पी', Q: 'क्यू', R: 'आर', S: 'एस', T: 'टी', U: 'यू', V: 'वी', W: 'डब्ल्यू', X: 'एक्स', Y: 'वाई', Z: 'ज़ेड' };
let letterKeys = null;
function letterKey(ch) {
  if (!letterKeys) {
    letterKeys = {};
    for (const [l, name] of Object.entries(LETTER_NAMES)) letterKeys[l] = tokenize(name)[0]?.key || l.toLowerCase();
  }
  return letterKeys[ch.toUpperCase()];
}
const isAcronym = (w) => /^[A-Z]{2,4}$/.test(w) || /^(Td|Hb|Rs)$/.test(w);

// Ordinals: the agent says "दूसरा", STT may write "2nd".
const ORDINAL = { pahala: 1, pahali: 1, pehla: 1, first: 1, modala: 1, dusara: 2, dusari: 2, doosra: 2, second: 2, eradane: 2, tisara: 3, tisari: 3, teesra: 3, tird: 3, third: 3, muurane: 3, chautha: 4, cautha: 4, fourth: 4 };
const ORD_SUFFIX = new Set(['st', 'nd', 'rd', 'th']);

const UNIT = { kilo: 'kg', kg: 'kg', kilogram: 'kg', kilogrem: 'kg', gram: 'g', gm: 'g' };

// Words the worker uses to cut in. Heard alone while the agent talks they still count,
// unless the agent itself just said them.
const BARGE_WORDS = new Set(['nahi', 'nahin', 'na', 'ruko', 'ruk', 'ruki', 'stop', 'bas', 'wait', 'galat', 'no', 'illa', 'beda', 'nillisi', 'ek', 'minat']);

function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0];
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j];
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length];
}

function same(a, b) {
  if (a === b) return true;
  return a.length >= 4 && b.length >= 4 && a[0] === b[0] && lev(a, b) <= 1;
}

// Word-level units: each original word with its comparison keys. A spoken number spread
// over several words ("दो पॉइंट आठ") collapses to one unit keyed by its value.
export function units(text) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const toks = [];
  words.forEach((w, wi) => {
    const bare = w.replace(/[^\p{L}\p{N}]/gu, '');
    if (isAcronym(bare)) { for (const ch of bare) toks.push({ key: letterKey(ch), rom: ch, wi, letter: true }); return; }
    for (const t of tokenize(w)) if (t.key) toks.push({ ...t, wi });
  });
  const out = [];
  const nums = findNumbers(toks);
  let n = 0;
  for (let i = 0; i < toks.length;) {
    if (n < nums.length && nums[n].start === i) {
      const r = nums[n++];
      const ws = new Set(toks.slice(i, r.end).map((t) => t.wi));
      // "2nd" -> ordinal 2
      if (toks[r.end] && ORD_SUFFIX.has(toks[r.end].key) && toks[r.end].wi === toks[r.end - 1].wi) {
        out.push({ key: `#${r.value}`, words: ws });
        i = r.end + 1;
      } else {
        out.push({ key: `#${r.value}`, words: ws });
        i = r.end;
      }
    } else if (ORDINAL[toks[i].key]) {
      out.push({ key: `#${ORDINAL[toks[i].key]}`, words: new Set([toks[i].wi]) });
      i++;
    } else {
      const mi = toks[i].letter ? -1 : monthIndex(toks[i]);
      const k = mi >= 0 ? `@m${mi}` : (UNIT[toks[i].key] || toks[i].key);
      out.push({ key: k, words: new Set([toks[i].wi]) });
      i++;
    }
  }
  return { words, units: out };
}

// Returns { echo, rest, restUnits }. `said` is a list of the agent's recent utterances.
export function stripEcho(heardText, said, { playing = false } = {}) {
  const h = units(heardText);
  const H = h.units;
  if (!H.length) return { echo: true, rest: '', restUnits: [] };
  const sayUnits = said.filter(Boolean).flatMap((s) => [...units(s).units, { key: '\u0000' }]);
  const S = sayUnits.map((u) => u.key);
  if (!S.length) return { echo: false, rest: heardText.trim(), restUnits: H.map((u) => u.key) };

  // fwd[i][p]: length of an in-order run ending at heard i matched to said p (one skipped
  // word allowed on either side for STT slips); bwd: same run seen from the other end.
  const m = H.length;
  const n = S.length;
  const match = H.map((u) => S.map((s) => same(u.key, s)));
  const fwd = H.map(() => new Array(n).fill(0));
  const bwd = H.map(() => new Array(n).fill(0));
  for (let i = 0; i < m; i++) {
    for (let p = 0; p < n; p++) {
      if (!match[i][p]) continue;
      let best = 0;
      for (const [di, dp] of [[1, 1], [1, 2], [2, 1]]) {
        if (i - di >= 0 && p - dp >= 0) best = Math.max(best, fwd[i - di][p - dp]);
      }
      fwd[i][p] = best + 1;
    }
  }
  for (let i = m - 1; i >= 0; i--) {
    for (let p = n - 1; p >= 0; p--) {
      if (!match[i][p]) continue;
      let best = 0;
      for (const [di, dp] of [[1, 1], [1, 2], [2, 1]]) {
        if (i + di < m && p + dp < n) best = Math.max(best, bwd[i + di][p + dp]);
      }
      bwd[i][p] = best + 1;
    }
  }
  const isEcho = H.map((u, i) => {
    let run = 0;
    for (let p = 0; p < n; p++) if (match[i][p]) run = Math.max(run, fwd[i][p] + bwd[i][p] - 1);
    if (run >= 2) return true;
    // a lone word heard while the agent is still talking is echo if the agent said it,
    // unless it is a cut-in word the agent did not just say
    if (playing && m <= 2 && match[i].some(Boolean)) return true;
    return false;
  });

  const keepWords = new Set();
  H.forEach((u, i) => { if (!isEcho[i]) for (const w of u.words) keepWords.add(w); });
  const rest = h.words.filter((_, wi) => keepWords.has(wi)).join(' ');
  const restUnits = H.filter((_, i) => !isEcho[i]).map((u) => u.key);
  return { echo: restUnits.length === 0, rest, restUnits };
}

// Should what the worker has said so far stop the agent mid-sentence?
export function isBargeIn(restUnits) {
  const real = restUnits.filter((k) => k.length > 1 || k.startsWith('#'));
  return real.length >= 2 || real.some((k) => BARGE_WORDS.has(k) || k.startsWith('#'));
}
