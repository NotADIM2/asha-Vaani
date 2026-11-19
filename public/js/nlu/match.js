// Tiny phrase matcher over phonetic keys.
// Pattern syntax: words separated by spaces; "a|b" = alternatives; trailing "~" = prefix match.
// Pattern words may be in any script; they go through the same transliterate+phon pipeline.
// Latin and Devanagari words match tokens in any script (Hinglish, Marathi). A word written in
// a regional script (Tamil, Telugu, Kannada, Malayalam, Bengali, Gujarati, Gurmukhi) matches
// only tokens in that script: Malayalam "പനി" (fever) and Hindi "पानी" (water) share a key.
// Up to `gap` unrelated tokens may sit between pattern words ("khoon thoda aa raha").
import { transliterate, phon, scriptOf } from './translit.js';

const SHARED = new Set(['latn', 'deva']);
const lockOf = (word) => { const sc = scriptOf(word); return SHARED.has(sc) ? null : sc; };

function keyOf(word) {
  return phon(transliterate(word).toLowerCase());
}

function editDistanceLE1(a, b) {
  if (a === b) return true;
  const la = a.length;
  const lb = b.length;
  if (Math.abs(la - lb) > 1) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < la && j < lb) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (la > lb) i++; else if (lb > la) j++; else { i++; j++; }
  }
  return edits + (la - i) + (lb - j) <= 1;
}

export function compile(pattern) {
  return pattern.trim().split(/\s+/).map((w) =>
    w.split('|').map((alt) => {
      const prefix = alt.endsWith('~');
      const word = prefix ? alt.slice(0, -1) : alt;
      // a multi-word alternative in another script ("खून की") is split by the caller; keep simple
      return { key: keyOf(word), prefix, script: lockOf(word) };
    }),
  );
}

function tokMatches(tok, alts) {
  for (const a of alts) {
    if (!a.key) continue;
    if (a.script && tok.script !== a.script) continue;
    if (a.prefix ? tok.key.startsWith(a.key) : tok.key === a.key) return true;
    if (!a.prefix && a.key.length >= 6 && tok.key.length >= 5 && a.key.slice(0, 2) === tok.key.slice(0, 2) && editDistanceLE1(tok.key, a.key)) return true;
  }
  return false;
}

// Returns every match as { start, end } (end exclusive). Non-overlapping, leftmost first.
export function findAll(tokens, compiled, gap = 2) {
  const out = [];
  for (let s = 0; s < tokens.length; s++) {
    if (!tokMatches(tokens[s], compiled[0])) continue;
    let pos = s + 1;
    let ok = true;
    for (let p = 1; p < compiled.length; p++) {
      let found = -1;
      for (let q = pos; q < Math.min(tokens.length, pos + gap + 1); q++) {
        if (tokMatches(tokens[q], compiled[p])) { found = q; break; }
      }
      if (found < 0) { ok = false; break; }
      pos = found + 1;
    }
    if (ok) { out.push({ start: s, end: pos }); s = pos - 1; }
  }
  return out;
}

export function makeMatcher(patterns, gap = 2) {
  const compiled = patterns.map((p) => compile(p));
  return {
    findAll(tokens) {
      const res = [];
      for (const c of compiled) res.push(...findAll(tokens, c, gap));
      return res.sort((a, b) => a.start - b.start);
    },
    test(tokens) {
      return compiled.some((c) => findAll(tokens, c, gap).length > 0);
    },
  };
}

// A word set. has(token) applies the same script rule as patterns; has(string) checks a bare
// key against the script-neutral words only. A word ending in "~" matches as a prefix.
class KeySet extends Set {
  constructor() { super(); this.prefixes = []; }
  has(x) {
    if (x == null) return false;
    if (typeof x === 'string') return super.has(x) || this.prefixes.some((p) => !p.script && x.startsWith(p.key));
    if (super.has(x.key) || super.has(`${x.script}:${x.key}`)) return true;
    return this.prefixes.some((p) => (!p.script || p.script === x.script) && x.key.startsWith(p.key));
  }
}
export function keySet(words) {
  const s = new KeySet();
  for (const w of words) {
    const prefix = w.endsWith('~');
    const word = prefix ? w.slice(0, -1) : w;
    const sc = lockOf(word);
    if (prefix) s.prefixes.push({ key: keyOf(word), script: sc });
    else s.add(sc ? `${sc}:${keyOf(word)}` : keyOf(word));
  }
  return s;
}
