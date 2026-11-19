// Romanises any Brahmic Indic script (Devanagari, Bengali, Gurmukhi, Gujarati, Odia,
// Tamil, Telugu, Kannada, Malayalam) with one table: Unicode lays these blocks out on the
// same ISCII grid, so a letter's offset inside its block is the same in every script.
// The parser then matches on a lossy phonetic key, so "वजन", "wajan" and "vajan" meet.

const BLOCKS = [
  [0x0900, 'deva'], [0x0980, 'beng'], [0x0a00, 'guru'], [0x0a80, 'gujr'], [0x0b00, 'orya'],
  [0x0b80, 'taml'], [0x0c00, 'telu'], [0x0c80, 'knda'], [0x0d00, 'mlym'],
];
// North Indian scripts drop the inherent "a" at the end of a word (कमल -> kamal).
const SCHWA_DROP = new Set(['deva', 'beng', 'guru', 'gujr']);

const VOWELS = {
  0x05: 'a', 0x06: 'aa', 0x07: 'i', 0x08: 'ii', 0x09: 'u', 0x0a: 'uu', 0x0b: 'ri', 0x0c: 'li',
  0x0d: 'e', 0x0e: 'e', 0x0f: 'e', 0x10: 'ai', 0x11: 'o', 0x12: 'o', 0x13: 'o', 0x14: 'au',
  0x60: 'rii', 0x61: 'lii',
};
const CONSONANTS = {
  0x15: 'k', 0x16: 'kh', 0x17: 'g', 0x18: 'gh', 0x19: 'ng', 0x1a: 'ch', 0x1b: 'chh', 0x1c: 'j',
  0x1d: 'jh', 0x1e: 'ny', 0x1f: 't', 0x20: 'th', 0x21: 'd', 0x22: 'dh', 0x23: 'n', 0x24: 't',
  0x25: 'th', 0x26: 'd', 0x27: 'dh', 0x28: 'n', 0x29: 'n', 0x2a: 'p', 0x2b: 'ph', 0x2c: 'b',
  0x2d: 'bh', 0x2e: 'm', 0x2f: 'y', 0x30: 'r', 0x31: 'r', 0x32: 'l', 0x33: 'l', 0x34: 'zh',
  0x35: 'v', 0x36: 'sh', 0x37: 'sh', 0x38: 's', 0x39: 'h',
  // precomposed nukta letters (क़ ख़ ग़ ज़ ड़ ढ़ फ़ य़) and Bengali/Odia equivalents
  0x58: 'q', 0x59: 'kh', 0x5a: 'g', 0x5b: 'z', 0x5c: 'r', 0x5d: 'rh', 0x5e: 'f', 0x5f: 'y',
};
const MATRAS = {
  0x3e: 'aa', 0x3f: 'i', 0x40: 'ii', 0x41: 'u', 0x42: 'uu', 0x43: 'ri', 0x44: 'rii', 0x45: 'e',
  0x46: 'e', 0x47: 'e', 0x48: 'ai', 0x49: 'o', 0x4a: 'o', 0x4b: 'o', 0x4c: 'au', 0x57: 'au',
  0x62: 'li', 0x63: 'lii',
};
const NUKTA_SHIFT = { k: 'q', kh: 'kh', g: 'g', j: 'z', d: 'r', dh: 'rh', ph: 'f', y: 'y' };
const VIRAMA = 0x4d;
const NUKTA = 0x3c;
const SIGNS = { 0x01: 'n', 0x02: 'n', 0x03: 'h' };
const MALAYALAM_CHILLU = { 0xd7a: 'n', 0xd7b: 'n', 0xd7c: 'r', 0xd7d: 'l', 0xd7e: 'l', 0xd7f: 'k' };

function blockOf(cp) {
  for (const [start, name] of BLOCKS) if (cp >= start && cp < start + 0x80) return [start, name];
  return null;
}

export function hasIndic(s) {
  return /[ऀ-ൿ]/.test(s);
}

export function transliterate(input) {
  const s = input.normalize('NFC');
  let out = '';
  let pending = false; // a consonant's inherent "a" not yet written
  let script = null;
  let lettersInWord = 0;

  const flush = (atWordEnd) => {
    if (!pending) return;
    if (!(atWordEnd && SCHWA_DROP.has(script) && lettersInWord > 1)) out += 'a';
    pending = false;
  };

  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200c || cp === 0x200d) continue; // ZWNJ / ZWJ
    if (MALAYALAM_CHILLU[cp]) { flush(false); out += MALAYALAM_CHILLU[cp]; lettersInWord++; continue; }
    const blk = blockOf(cp);
    if (!blk) {
      flush(true);
      lettersInWord = 0;
      out += cp === 0x0964 || cp === 0x0965 ? '.' : ch;
      continue;
    }
    const [start, name] = blk;
    const off = cp - start;
    script = name;
    if (CONSONANTS[off] !== undefined) {
      flush(false);
      out += CONSONANTS[off];
      pending = true;
      lettersInWord++;
    } else if (MATRAS[off] !== undefined) {
      pending = false;
      out += MATRAS[off];
    } else if (off === VIRAMA) {
      pending = false;
    } else if (off === NUKTA) {
      for (const [from, to] of Object.entries(NUKTA_SHIFT)) {
        if (out.endsWith(from)) { out = out.slice(0, -from.length) + to; break; }
      }
    } else if (VOWELS[off] !== undefined) {
      flush(false);
      out += VOWELS[off];
      lettersInWord++;
    } else if (SIGNS[off] !== undefined) {
      flush(false);
      out += SIGNS[off];
    } else if (off >= 0x66 && off <= 0x6f) {
      flush(true);
      lettersInWord = 0;
      out += String(off - 0x66);
    } else if (cp === 0x09ce) { // Bengali khanda ta
      flush(false);
      out += 't';
    }
  }
  flush(true);
  return out;
}

// Lossy phonetic key used for matching. Both sides of every comparison go through it.
export function phon(word) {
  let s = word.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/[^a-z0-9.]/g, '');
  s = s
    .replace(/ksh/g, 'ks').replace(/x/g, 'ks')
    .replace(/ph/g, 'f')
    .replace(/sh/g, 's')
    .replace(/([kgcjtdpbr])h/g, '$1')
    .replace(/w/g, 'v').replace(/z/g, 'j').replace(/q/g, 'k').replace(/y(?=[^aeiou]|$)/g, 'i')
    .replace(/ee|ii/g, 'i').replace(/oo|uu/g, 'u').replace(/aa/g, 'a')
    .replace(/ai|ei|ay/g, 'e').replace(/au|ou/g, 'o')
    .replace(/(.)\1+/g, '$1');
  return s;
}

// Script of a word: the first Indic block it uses, else 'latn'.
export function scriptOf(word) {
  for (const ch of word) {
    const blk = blockOf(ch.codePointAt(0));
    if (blk) return blk[1];
  }
  return 'latn';
}

// Text -> tokens with original, romanised and phonetic forms, plus the script each word
// was written in (so a Malayalam word can't match a Hindi word that romanises the same).
export function tokenize(text) {
  const tokens = [];
  const re = /\d+(?:[.,]\d+)*(?:\/\d+)?|[a-zÀ-ɏ]+(?:'[a-z]+)?|\?/g;
  for (const word of text.normalize('NFC').split(/\s+/)) {
    if (!word) continue;
    const script = scriptOf(word);
    const rom = transliterate(word).toLowerCase();
    let m;
    re.lastIndex = 0;
    const before = tokens.length;
    while ((m = re.exec(rom))) {
      const raw = m[0];
      if (/^\d/.test(raw)) {
        const clean = raw.replace(/,(?=\d{3})/g, '');
        tokens.push({ rom: clean, key: clean, isDigits: true, script });
      } else {
        tokens.push({ rom: raw, key: phon(raw), isDigits: false, script });
      }
    }
    // a comma or full stop after the word ends a clause ("बुखार है, दूध नहीं पी रहा")
    if (tokens.length > before && /[,.;:!।॥]$/.test(word)) tokens[tokens.length - 1].clauseEnd = true;
  }
  return tokens;
}
