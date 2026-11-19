// Relative and absolute dates for "next visit": "kal", "parso", "do hafte baad",
// "agle mahine paanch tarikh", "3 December", "15 tarikh", "somvar", "in 10 days".
import { transliterate, phon } from './translit.js';
import { parseNumberAt } from './numbers.js';

const k = (w) => phon(transliterate(w).toLowerCase());
const set = (...ws) => new Set(ws.map(k));

const MONTHS = [
  ['january', 'jan', 'जनवरी', 'ಜನವರಿ'],
  ['february', 'feb', 'फरवरी', 'फ़रवरी', 'ಫೆಬ್ರವರಿ'],
  ['march', 'mar', 'मार्च', 'ಮಾರ್ಚ್'],
  ['april', 'apr', 'अप्रैल', 'ಏಪ್ರಿಲ್'],
  ['may', 'मई', 'ಮೇ'],
  ['june', 'jun', 'जून', 'ಜೂನ್'],
  ['july', 'jul', 'जुलाई', 'ಜುಲೈ'],
  ['august', 'aug', 'अगस्त', 'ಆಗಸ್ಟ್'],
  ['september', 'sep', 'sept', 'सितंबर', 'सितम्बर', 'ಸೆಪ್ಟೆಂಬರ್'],
  ['october', 'oct', 'अक्टूबर', 'अक्तूबर', 'ಅಕ್ಟೋಬರ್'],
  ['november', 'nov', 'नवंबर', 'नवम्बर', 'ನವೆಂಬರ್'],
  ['december', 'dec', 'दिसंबर', 'दिसम्बर', 'disambar', 'ಡಿಸೆಂಬರ್'],
].map((ws) => set(...ws));

const WEEKDAYS = [
  ['sunday', 'ravivar', 'itvar', 'रविवार', 'इतवार', 'ಭಾನುವಾರ'],
  ['monday', 'somvar', 'सोमवार', 'ಸೋಮವಾರ'],
  ['tuesday', 'mangalvar', 'मंगलवार', 'ಮಂಗಳವಾರ'],
  ['wednesday', 'budhvar', 'बुधवार', 'ಬುಧವಾರ'],
  ['thursday', 'guruvar', 'brihaspativar', 'गुरुवार', 'बृहस्पतिवार', 'ಗುರುವಾರ'],
  ['friday', 'shukravar', 'शुक्रवार', 'ಶುಕ್ರವಾರ'],
  ['saturday', 'shanivar', 'शनिवार', 'ಶನಿವಾರ'],
].map((ws) => set(...ws));

const TODAY = set('aaj', 'today', 'आज', 'ಇಂದು', 'indu');
const TOMORROW = set('kal', 'tomorrow', 'कल', 'ನಾಳೆ', 'naale');
const DAY_AFTER = set('parso', 'parson', 'परसों', 'ನಾಡಿದ್ದು', 'naadiddu');
const DAY = set('din', 'day', 'days', 'दिन', 'ದಿನ', 'dina', 'ದಿನದ');
const WEEK = set('hafte', 'hafta', 'haftey', 'week', 'weeks', 'हफ्ते', 'हफ़्ते', 'हफ्ता', 'सप्ताह', 'ವಾರ', 'vaara', 'ವಾರದ');
const MONTH = set('mahine', 'mahina', 'month', 'months', 'महीने', 'महीना', 'माह', 'ತಿಂಗಳು', 'tingalu', 'ತಿಂಗಳ');
const AFTER = set('baad', 'bad', 'mein', 'me', 'after', 'later', 'बाद', 'में', 'ನಂತರ', 'nantara', 'baadu');
const NEXT = set('agle', 'agla', 'agli', 'next', 'अगले', 'अगला', 'अगली', 'ಮುಂದಿನ', 'mundina');
const DATE_WORD = set('tarikh', 'tareekh', 'date', 'तारीख', 'तारीख़', 'ತಾರೀಖು', 'ತಾರೀಕು', 'ko', 'को');
const IN = set('in');

function addDays(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() + n);
  return x;
}
function addMonths(d, n) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setMonth(x.getMonth() + n);
  return x;
}
export function iso(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function fromIso(s) {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function monthIndex(tok) {
  if (!tok) return -1;
  return MONTHS.findIndex((s) => s.has(tok.key));
}

// Find the first future date expression in tokens[from..to). Returns { date, start, end } or null.
export function findDate(tokens, now = new Date(), from = 0, to = tokens.length) {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  for (let i = from; i < to; i++) {
    const t = tokens[i];
    // dd/mm or dd/mm/yy
    if (t.isDigits && /^\d{1,2}\/\d{1,2}(\/\d{2,4})?$/.test(t.rom)) {
      const [dd, mm, yy] = t.rom.split('/').map(Number);
      let y = yy ? (yy < 100 ? 2000 + yy : yy) : today.getFullYear();
      let d = new Date(y, mm - 1, dd);
      if (!yy && d < today) d = new Date(y + 1, mm - 1, dd);
      return { date: d, start: i, end: i + 1 };
    }
    if (TODAY.has(t.key)) return { date: today, start: i, end: i + 1 };
    if (DAY_AFTER.has(t.key)) return { date: addDays(today, 2), start: i, end: i + 1 };
    if (TOMORROW.has(t.key)) return { date: addDays(today, 1), start: i, end: i + 1 };
    const wd = WEEKDAYS.findIndex((s) => s.has(t.key));
    if (wd >= 0) {
      let delta = (wd - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return { date: addDays(today, delta), start: i, end: i + 1 };
    }
    // "agle hafte" / "next week" / "agle mahine" (+ optional day number after)
    if (NEXT.has(t.key) && tokens[i + 1]) {
      const u = tokens[i + 1];
      if (WEEK.has(u.key)) return { date: addDays(today, 7), start: i, end: i + 2 };
      if (MONTH.has(u.key)) {
        const num = parseNumberAt(tokens, i + 2);
        if (num && num.value >= 1 && num.value <= 31 && Number.isInteger(num.value)) {
          const end = DATE_WORD.has(tokens[num.end]?.key) ? num.end + 1 : num.end;
          return { date: new Date(today.getFullYear(), today.getMonth() + 1, num.value), start: i, end };
        }
        return { date: addMonths(today, 1), start: i, end: i + 2 };
      }
    }
    // "in 10 days"
    const numStart = IN.has(t.key) ? i + 1 : i;
    const num = parseNumberAt(tokens, numStart);
    if (num && Number.isFinite(num.value) && num.value > 0) {
      const u = tokens[num.end];
      const after = tokens[num.end + 1];
      if (u && (DAY.has(u.key) || WEEK.has(u.key) || MONTH.has(u.key))) {
        // "do hafte baad" requires baad/mein/after (or a leading "in"), otherwise it may be an age
        const relative = (after && AFTER.has(after.key)) || numStart !== i;
        if (relative) {
          const n = num.value;
          const date = DAY.has(u.key) ? addDays(today, Math.round(n)) : WEEK.has(u.key) ? addDays(today, Math.round(n * 7)) : addMonths(today, Math.round(n));
          return { date, start: i, end: num.end + (numStart !== i ? 1 : 2) };
        }
      }
      // "3 December" / "teen disambar" / "December 3"
      const mi = monthIndex(u);
      if (mi >= 0 && Number.isInteger(num.value) && num.value >= 1 && num.value <= 31) {
        let d = new Date(today.getFullYear(), mi, num.value);
        if (d < today) d = new Date(today.getFullYear() + 1, mi, num.value);
        return { date: d, start: i, end: num.end + 1 };
      }
      // "15 tarikh" / "15 ko"
      if (u && DATE_WORD.has(u.key) && Number.isInteger(num.value) && num.value >= 1 && num.value <= 31) {
        let d = new Date(today.getFullYear(), today.getMonth(), num.value);
        if (d < today) d = new Date(today.getFullYear(), today.getMonth() + 1, num.value);
        return { date: d, start: i, end: num.end + 1 };
      }
    }
    const mi = monthIndex(t);
    if (mi >= 0) {
      const n2 = parseNumberAt(tokens, i + 1);
      if (n2 && Number.isInteger(n2.value) && n2.value >= 1 && n2.value <= 31) {
        let d = new Date(today.getFullYear(), mi, n2.value);
        if (d < today) d = new Date(today.getFullYear() + 1, mi, n2.value);
        return { date: d, start: i, end: n2.end };
      }
    }
  }
  return null;
}

const MONTH_NAMES = {
  hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून', 'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  kn: ['ಜನವರಿ', 'ಫೆಬ್ರವರಿ', 'ಮಾರ್ಚ್', 'ಏಪ್ರಿಲ್', 'ಮೇ', 'ಜೂನ್', 'ಜುಲೈ', 'ಆಗಸ್ಟ್', 'ಸೆಪ್ಟೆಂಬರ್', 'ಅಕ್ಟೋಬರ್', 'ನವೆಂಬರ್', 'ಡಿಸೆಂಬರ್'],
};
export function monthName(m, lang) {
  return (MONTH_NAMES[lang] || MONTH_NAMES.en)[m];
}
