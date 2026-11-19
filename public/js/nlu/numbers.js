// Spoken numbers in Hindi, English and Kannada (any script), plus digits.
// "teen sau chaalis" -> 340, "do point aath" -> 2.8, "dhai" -> 2.5,
// "ek zero chaar do" -> digit string "1042", "ippattondu" -> 21.
import { transliterate, phon } from './translit.js';

const HINDI_1_99 = (
  'एक दो तीन चार पांच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस बीस ' +
  'इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस चालीस ' +
  'इकतालीस बयालीस तैंतालीस चवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ साठ ' +
  'इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी अस्सी ' +
  'इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी नब्बे इक्यानवे बानवे तिरानवे चौरानवे पचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे'
).split(' ');

// Romanised spellings people (and STT in Latin mode) commonly produce.
const LATIN_ALIASES = {
  0: ['zero', 'shunya', 'sunya', 'shoonya', 'sunna', 'sonne', 'sife', 'sifar'],
  1: ['ek', 'one', 'ondu', 'onnu'],
  2: ['do', 'two', 'eradu', 'rendu'],
  3: ['teen', 'tin', 'three', 'mooru', 'muru', 'moonu'],
  4: ['char', 'chaar', 'four', 'naalku', 'nalku', 'naalu'],
  5: ['paanch', 'panch', 'paach', 'five', 'aidu', 'anju'],
  6: ['chhah', 'chhe', 'chah', 'che', 'chheh', 'six', 'aaru'],
  7: ['saat', 'seven', 'elu', 'yelu'],
  8: ['aath', 'eight', 'entu', 'ettu'],
  9: ['nau', 'nine', 'ombattu', 'ombhattu'],
  10: ['das', 'dus', 'ten', 'hattu', 'pattu'],
  11: ['gyarah', 'gyaarah', 'eleven', 'hannondu'],
  12: ['barah', 'baarah', 'twelve', 'hanneradu'],
  13: ['terah', 'thirteen', 'hadimooru'],
  14: ['chaudah', 'fourteen', 'hadinaalku'],
  15: ['pandrah', 'pandra', 'fifteen', 'hadinaidu'],
  16: ['solah', 'sola', 'sixteen', 'hadinaaru'],
  17: ['satrah', 'seventeen', 'hadinelu'],
  18: ['atharah', 'athara', 'eighteen', 'hadinentu'],
  19: ['unnis', 'unnees', 'nineteen', 'hattombattu'],
  20: ['bees', 'bis', 'twenty'],
  25: ['pachchis', 'pachis'],
  30: ['tees', 'tis', 'thirty'],
  40: ['chalis', 'chaalis', 'forty'],
  50: ['pachas', 'pachaas', 'fifty'],
  52: ['bavan', 'baavan'],
  60: ['sixty'],
  70: ['sattar', 'seventy'],
  80: ['assi', 'eighty'],
  90: ['nabbe', 'ninety'],
};

const KANNADA_TENS = {
  20: 'ippatt', 30: 'moovatt', 40: 'nalavatt', 50: 'aivatt', 60: 'aravatt', 70: 'eppatt', 80: 'embatt', 90: 'tombatt',
};
const KANNADA_UNITS = ['', 'ondu', 'eradu', 'mooru', 'naalku', 'aidu', 'aaru', 'elu', 'entu', 'ombattu'];

const MULTIPLIERS = {
  100: ['sau', 'so', 'hundred', 'nooru', 'nuru', 'saw', 'शतक'],
  1000: ['hazaar', 'hazar', 'hajar', 'hajaar', 'thousand', 'saavira', 'savira'],
  100000: ['lakh', 'lac', 'laakh'],
};
const MULT_DEVA = { 100: ['सौ'], 1000: ['हज़ार', 'हजार', 'ಸಾವಿರ'], 100000: ['लाख'] };

const FRACTIONS = { 0.5: ['aadha', 'adha', 'half', 'आधा', 'आधी', 'ardha'], 1.5: ['dedh', 'डेढ़', 'डेढ'], 2.5: ['dhai', 'ढाई'] };
const MODIFIERS = {
  0.25: ['sava', 'savva', 'सवा'],
  0.5: ['saadhe', 'sadhe', 'साढ़े', 'साढे'],
  '-0.25': ['paune', 'pone', 'पौने'],
};
const POINT = ['point', 'poin', 'dashamlav', 'dasmalav', 'decimal', 'दशमलव', 'पॉइंट', 'प्वाइंट', 'ಪಾಯಿಂಟ್'];
const DOUBLE = ['double', 'डबल'];
const TRIPLE = ['triple', 'ट्रिपल'];

function romKey(word) {
  return transliterate(word).toLowerCase();
}

// Exact romanised forms first (keeps साठ 60 apart from सात 7), phonetic keys second
// with ambiguous keys removed.
const exact = new Map();
const fuzzy = new Map();
const fuzzyConflicts = new Set();
function addWord(word, value) {
  const r = romKey(word);
  if (!exact.has(r)) exact.set(r, value);
  const k = phon(r);
  if (fuzzyConflicts.has(k)) return;
  if (fuzzy.has(k) && fuzzy.get(k) !== value) { fuzzy.delete(k); fuzzyConflicts.add(k); return; }
  fuzzy.set(k, value);
}
HINDI_1_99.forEach((w, i) => addWord(w, i + 1));
addWord('पाँच', 5); addWord('छः', 6); addWord('छे', 6); addWord('शून्य', 0); addWord('ज़ीरो', 0); addWord('जीरो', 0);
for (const [v, words] of Object.entries(LATIN_ALIASES)) words.forEach((w) => addWord(w, Number(v)));
for (const [tens, stem] of Object.entries(KANNADA_TENS)) {
  addWord(stem + 'u', Number(tens));
  KANNADA_UNITS.forEach((u, i) => { if (i) addWord(stem + u, Number(tens) + i); });
}
// Kannada script digits words come through transliteration (ಒಂದು -> ondu etc.)
['ಒಂದು', 'ಎರಡು', 'ಮೂರು', 'ನಾಲ್ಕು', 'ಐದು', 'ಆರು', 'ಏಳು', 'ಎಂಟು', 'ಒಂಬತ್ತು', 'ಹತ್ತು'].forEach((w, i) => addWord(w, i + 1));
addWord('ಸೊನ್ನೆ', 0);
const ENGLISH_TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const multExact = new Map();
for (const [v, ws] of Object.entries(MULTIPLIERS)) ws.forEach((w) => multExact.set(phon(romKey(w)), Number(v)));
for (const [v, ws] of Object.entries(MULT_DEVA)) ws.forEach((w) => multExact.set(phon(romKey(w)), Number(v)));
const fracMap = new Map();
for (const [v, ws] of Object.entries(FRACTIONS)) ws.forEach((w) => fracMap.set(phon(romKey(w)), Number(v)));
const modMap = new Map();
for (const [v, ws] of Object.entries(MODIFIERS)) ws.forEach((w) => modMap.set(phon(romKey(w)), Number(v)));
const pointSet = new Set(POINT.map((w) => phon(romKey(w))));
const doubleSet = new Set(DOUBLE.map((w) => phon(romKey(w))));
const tripleSet = new Set(TRIPLE.map((w) => phon(romKey(w))));

export function wordValue(tok) {
  if (tok.isDigits) return null;
  if (exact.has(tok.rom)) return exact.get(tok.rom);
  if (fuzzy.has(tok.key)) return fuzzy.get(tok.key);
  return null;
}

function digitsValue(tok) {
  if (!tok.isDigits || tok.rom.includes('/')) return null;
  const v = Number(tok.rom.replace(/,/g, '.'));
  return Number.isFinite(v) ? v : null;
}

export function isNumberStart(tok) {
  return digitsValue(tok) !== null || wordValue(tok) !== null || fracMap.has(tok.key) || modMap.has(tok.key) || doubleSet.has(tok.key) || tripleSet.has(tok.key);
}

// Parse a number starting at tokens[i]. Returns { value, end, digitString, spokenDigits } or null.
// end is exclusive. digitString keeps leading zeros for IDs ("zero four" -> "04").
export function parseNumberAt(tokens, i) {
  const n = tokens.length;
  if (i >= n) return null;

  // Digit-by-digit runs ("ek zero chaar do", "1 0 4 2", "double five") -> ID-style string.
  {
    let j = i;
    let s = '';
    let count = 0;
    while (j < n) {
      const t = tokens[j];
      let rep = 1;
      if (doubleSet.has(t.key) || tripleSet.has(t.key)) {
        rep = doubleSet.has(t.key) ? 2 : 3;
        const nx = tokens[j + 1];
        const d = nx && (digitsValue(nx) ?? wordValue(nx));
        if (d === null || d === undefined || d > 9 || !Number.isInteger(d) || (nx.isDigits && nx.rom.length !== 1)) break;
        s += String(d).repeat(rep);
        count += rep;
        j += 2;
        continue;
      }
      const d = t.isDigits ? (t.rom.length === 1 ? Number(t.rom) : null) : wordValue(t);
      if (d === null || d === undefined || d > 9) break;
      // a following multiplier means it's not digit-by-digit ("do sau")
      if (tokens[j + 1] && multExact.has(tokens[j + 1].key)) break;
      if (tokens[j + 1] && pointSet.has(tokens[j + 1].key)) break;
      s += String(d);
      count++;
      j++;
    }
    if (count >= 2) return { value: Number(s), end: j, digitString: s, spokenDigits: true };
  }

  let total = 0;
  let current = 0;
  let any = false;
  let j = i;
  let modifier = 0;
  while (j < n) {
    const t = tokens[j];
    const dv = digitsValue(t);
    if (dv !== null) {
      if (any && current !== 0 && !(current % 100 === 0 && dv < 100) && !(current % 10 === 0 && current < 100 && dv < 10)) break;
      current += dv;
      any = true;
      j++;
      continue;
    }
    if (modMap.has(t.key) && !any) { modifier = modMap.get(t.key); j++; continue; }
    if (fracMap.has(t.key)) {
      if (any && current !== 0) break;
      current += fracMap.get(t.key);
      any = true;
      j++;
      continue;
    }
    const wv = wordValue(t);
    if (wv !== null) {
      // "twenty two": add a unit to a bare ten; otherwise a new number starts.
      if (any && current !== 0) {
        const tensOk = current % 10 === 0 && current < 100 && wv < 10 && ENGLISH_TENS[t.rom] === undefined;
        const afterHundred = current % 100 === 0 && wv < 100;
        if (!tensOk && !afterHundred) break;
      }
      current += wv;
      any = true;
      j++;
      continue;
    }
    if (multExact.has(t.key)) {
      const m = multExact.get(t.key);
      const base = (current || (modifier ? 1 : any ? 0 : 1)) + modifier;
      modifier = 0;
      if (m >= 1000) { total += base * m; current = 0; } else { current = base * m; }
      any = true;
      j++;
      continue;
    }
    break;
  }
  if (!any) return null;
  current += modifier;
  let value = total + current;

  // decimal part: "do point aath" / "2 point 8" / "52 point 5"
  if (j < n && pointSet.has(tokens[j].key)) {
    let k = j + 1;
    let frac = '';
    while (k < n) {
      const t = tokens[k];
      const d = t.isDigits ? (/^\d+$/.test(t.rom) ? t.rom : null) : wordValue(t);
      if (d === null || d === undefined) break;
      if (!t.isDigits && d > 9) break;
      frac += String(d);
      k++;
      if (t.isDigits) break;
    }
    if (frac) { value = Number(`${Math.trunc(value)}.${frac}`); j = k; }
  }
  return { value, end: j, digitString: Number.isInteger(value) ? String(value) : null, spokenDigits: false };
}

// All numbers in a token list, in order.
export function findNumbers(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; ) {
    const r = parseNumberAt(tokens, i);
    if (r) { out.push({ ...r, start: i }); i = r.end; } else i++;
  }
  return out;
}

// ---- number -> spoken words (for TTS read-back) ----
const EN_ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const EN_TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const KN_1_10 = ['ಸೊನ್ನೆ', 'ಒಂದು', 'ಎರಡು', 'ಮೂರು', 'ನಾಲ್ಕು', 'ಐದು', 'ಆರು', 'ಏಳು', 'ಎಂಟು', 'ಒಂಬತ್ತು', 'ಹತ್ತು'];
const KN_11_19 = ['ಹನ್ನೊಂದು', 'ಹನ್ನೆರಡು', 'ಹದಿಮೂರು', 'ಹದಿನಾಲ್ಕು', 'ಹದಿನೈದು', 'ಹದಿನಾರು', 'ಹದಿನೇಳು', 'ಹದಿನೆಂಟು', 'ಹತ್ತೊಂಬತ್ತು'];
const KN_TENS = { 20: 'ಇಪ್ಪತ್ತು', 30: 'ಮೂವತ್ತು', 40: 'ನಲವತ್ತು', 50: 'ಐವತ್ತು', 60: 'ಅರವತ್ತು', 70: 'ಎಪ್ಪತ್ತು', 80: 'ಎಂಬತ್ತು', 90: 'ತೊಂಬತ್ತು' };
const KN_TENS_STEM = { 20: 'ಇಪ್ಪತ್', 30: 'ಮೂವತ್', 40: 'ನಲವತ್', 50: 'ಐವತ್', 60: 'ಅರವತ್', 70: 'ಎಪ್ಪತ್', 80: 'ಎಂಬತ್', 90: 'ತೊಂಬತ್' };

function intWords(n, lang) {
  if (lang === 'hi') {
    if (n === 0) return 'शून्य';
    const parts = [];
    if (n >= 100000) { parts.push(intWords(Math.floor(n / 100000), lang), 'लाख'); n %= 100000; }
    if (n >= 1000) { parts.push(intWords(Math.floor(n / 1000), lang), 'हज़ार'); n %= 1000; }
    if (n >= 100) { parts.push(HINDI_1_99[Math.floor(n / 100) - 1], 'सौ'); n %= 100; }
    if (n > 0) parts.push(HINDI_1_99[n - 1]);
    return parts.join(' ');
  }
  if (lang === 'kn') {
    if (n <= 10) return KN_1_10[n];
    if (n < 20) return KN_11_19[n - 11];
    if (n < 100) {
      const t = Math.floor(n / 10) * 10;
      const u = n % 10;
      return u ? KN_TENS_STEM[t] + KN_1_10[u] : KN_TENS[t];
    }
    if (n < 1000) {
      const h = Math.floor(n / 100);
      const rest = n % 100;
      const hw = h === 1 ? 'ನೂರ' : `${KN_1_10[h]} ನೂರ`;
      return rest ? `${hw} ${intWords(rest, lang)}` : `${hw}ು`;
    }
    return String(n);
  }
  if (n < 20) return EN_ONES[n];
  if (n < 100) return EN_TENS[Math.floor(n / 10)] + (n % 10 ? ` ${EN_ONES[n % 10]}` : '');
  if (n < 1000) return `${EN_ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${intWords(n % 100, lang)}` : ''}`;
  if (n < 100000) return `${intWords(Math.floor(n / 1000), lang)} thousand${n % 1000 ? ` ${intWords(n % 1000, lang)}` : ''}`;
  return String(n);
}

const POINT_WORD = { hi: 'दशमलव', en: 'point', kn: 'ಪಾಯಿಂಟ್' };

export function numberToWords(value, lang = 'hi') {
  const neg = value < 0;
  const abs = Math.abs(value);
  const [intPart, fracPart] = String(abs).split('.');
  let s = intWords(Number(intPart), lang);
  if (fracPart) s += ` ${POINT_WORD[lang] || 'point'} ${fracPart.split('').map((d) => intWords(Number(d), lang)).join(' ')}`;
  return (neg ? '- ' : '') + s;
}

// IDs are read digit by digit so a wrong digit is easy to hear.
export function digitsToWords(str, lang = 'hi') {
  return String(str).split('').filter((c) => /\d/.test(c)).map((d) => intWords(Number(d), lang)).join(' ');
}
