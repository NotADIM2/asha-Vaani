// Relative and absolute dates for "next visit": "kal", "parso", "do hafte baad",
// "agle mahine paanch tarikh", "3 December", "15 tarikh", "somvar", "in 10 days".
import { transliterate, phon } from './translit.js';
import { parseNumberAt } from './numbers.js';
import { keySet } from './match.js';
import { WORDS as W } from './regional.js';

const k = (w) => phon(transliterate(w).toLowerCase());
const set = (...ws) => keySet(ws);

const MONTHS = [
  ['january', 'jan', 'जनवरी', 'ಜನವರಿ', 'जानेवारी', 'ஜனவரி', 'జనవరి', 'জানুয়ারি', 'જાન્યુઆરી', 'ജനുവരി', 'ਜਨਵਰੀ'],
  ['february', 'feb', 'फरवरी', 'फ़रवरी', 'ಫೆಬ್ರವರಿ', 'फेब्रुवारी', 'பிப்ரவரி', 'ఫిబ్రవరి', 'ফেব্রুয়ারি', 'ફેબ્રુઆરી', 'ഫെബ്രുവരി', 'ਫ਼ਰਵਰੀ', 'ਫਰਵਰੀ'],
  ['march', 'mar', 'मार्च', 'ಮಾರ್ಚ್', 'மார்ச்', 'మార్చి', 'মার্চ', 'માર્ચ', 'മാർച്ച്', 'ਮਾਰਚ'],
  ['april', 'apr', 'अप्रैल', 'ಏಪ್ರಿಲ್', 'एप्रिल', 'ஏப்ரல்', 'ఏప్రిల్', 'এপ্রিল', 'એપ્રિલ', 'ഏപ്രിൽ', 'ਅਪ੍ਰੈਲ'],
  ['may', 'मई', 'ಮೇ', 'மே', 'మే', 'মে', 'મે', 'മേയ്', 'ਮਈ'],
  ['june', 'jun', 'जून', 'ಜೂನ್', 'ஜூன்', 'జూన్', 'জুন', 'જૂન', 'ജൂൺ', 'ਜੂਨ'],
  ['july', 'jul', 'जुलाई', 'ಜುಲೈ', 'जुलै', 'ஜூலை', 'జూలై', 'জুলাই', 'જુલાઈ', 'ജൂലൈ', 'ਜੁਲਾਈ'],
  ['august', 'aug', 'अगस्त', 'ಆಗಸ್ಟ್', 'ऑगस्ट', 'ஆகஸ்ட்', 'ఆగస్టు', 'ఆగస్ట్', 'আগস্ট', 'ઓગસ્ટ', 'ഓഗസ്റ്റ്', 'ਅਗਸਤ'],
  ['september', 'sep', 'sept', 'सितंबर', 'सितम्बर', 'ಸೆಪ್ಟೆಂಬರ್', 'सप्टेंबर', 'செப்டம்பர்', 'సెప్టెంబర్', 'সেপ্টেম্বর', 'સપ્ટેમ્બર', 'സെപ്റ്റംബർ', 'ਸਤੰਬਰ'],
  ['october', 'oct', 'अक्टूबर', 'अक्तूबर', 'ಅಕ್ಟೋಬರ್', 'ऑक्टोबर', 'அக்டோபர்', 'అక్టోబర్', 'অক্টোবর', 'ઓક્ટોબર', 'ഒക്ടോബർ', 'ਅਕਤੂਬਰ'],
  ['november', 'nov', 'नवंबर', 'नवम्बर', 'ನವೆಂಬರ್', 'नोव्हेंबर', 'நவம்பர்', 'నవంబర్', 'নভেম্বর', 'નવેમ્બર', 'നവംബർ', 'ਨਵੰਬਰ'],
  ['december', 'dec', 'दिसंबर', 'दिसम्बर', 'disambar', 'ಡಿಸೆಂಬರ್', 'डिसेंबर', 'டிசம்பர்', 'డిసెంబర్', 'ডিসেম্বর', 'ડિસેમ્બર', 'ഡിസംബർ', 'ਦਸੰਬਰ'],
].map((ws) => set(...ws));

const WEEKDAYS = [
  ['sunday', 'ravivar', 'itvar', 'रविवार', 'इतवार', 'ಭಾನುವಾರ', 'ஞாயிறு~', 'ஞாயிற்று~', 'ఆదివారం', 'রবিবার', 'রোববার', 'રવિવાર', 'ഞായറാഴ്ച', 'ਐਤਵਾਰ'],
  ['monday', 'somvar', 'सोमवार', 'ಸೋಮವಾರ', 'திங்கள்~', 'సోమవారం', 'সোমবার', 'સોમવાર', 'തിങ്കളാഴ്ച', 'ਸੋਮਵਾਰ'],
  ['tuesday', 'mangalvar', 'मंगलवार', 'ಮಂಗಳವಾರ', 'मंगळवार', 'செவ்வாய்~', 'మంగళవారం', 'মঙ্গলবার', 'મંગળવાર', 'ചൊവ്വാഴ്ച', 'ਮੰਗਲਵਾਰ'],
  ['wednesday', 'budhvar', 'बुधवार', 'ಬುಧವಾರ', 'புதன்~', 'బుధవారం', 'বুধবার', 'બુધવાર', 'ബുധനാഴ്ച', 'ਬੁੱਧਵਾਰ'],
  ['thursday', 'guruvar', 'brihaspativar', 'गुरुवार', 'बृहस्पतिवार', 'ಗುರುವಾರ', 'வியாழ~', 'గురువారం', 'বৃহস্পতিবার', 'ગુરુવાર', 'വ്യാഴാഴ്ച', 'ਵੀਰਵਾਰ'],
  ['friday', 'shukravar', 'शुक्रवार', 'ಶುಕ್ರವಾರ', 'வெள்ளிக்~', 'வெள்ளி', 'శుక్రవారం', 'শুক্রবার', 'શુક્રવાર', 'വെള്ളിയാഴ്ച', 'ਸ਼ੁੱਕਰਵਾਰ'],
  ['saturday', 'shanivar', 'शनिवार', 'ಶನಿವಾರ', 'சனிக்~', 'சனி', 'శనివారం', 'শনিবার', 'શનિવાર', 'ശനിയാഴ്ച', 'ਸ਼ਨੀਵਾਰ'],
].map((ws) => set(...ws));

const TODAY = set('aaj', 'today', 'आज', 'ಇಂದು', 'indu', 'இன்று', 'இன்னைக்கு', 'ఈరోజు', 'నేడు', 'আজ', 'আজকে', 'આજે', 'ഇന്ന്', 'ਅੱਜ');
const TOMORROW = set('kal', 'tomorrow', 'कल', 'ನಾಳೆ', 'naale', 'उद्या', 'நாளை', 'நாளைக்கு', 'రేపు', 'কাল', 'আগামীকাল', 'કાલે', 'നാളെ', 'ਕੱਲ੍ਹ', 'ਕੱਲ');
const DAY_AFTER = set('parso', 'parson', 'परसों', 'ನಾಡಿದ್ದು', 'naadiddu', 'परवा', 'ఎల్లుండి', 'পরশু', 'પરમ', 'પરમદિવસે', 'മറ്റന്നാൾ', 'ਪਰਸੋਂ');
// Tamil "நாளை மறுநாள்" = day after tomorrow
const AFTER_TOMORROW = set('மறுநாள்');
const DAY = set('din', 'day', 'days', 'दिन', 'ದಿನ', 'dina', 'ದಿನದ', ...W.day);
const WEEK = set('hafte', 'hafta', 'haftey', 'week', 'weeks', 'हफ्ते', 'हफ़्ते', 'हफ्ता', 'सप्ताह', 'ವಾರ', 'vaara', 'ವಾರದ', ...W.week);
const MONTH = set('mahine', 'mahina', 'month', 'months', 'महीने', 'महीना', 'माह', 'ತಿಂಗಳು', 'tingalu', 'ತಿಂಗಳ', ...W.month);
const AFTER = set('baad', 'bad', 'mein', 'me', 'after', 'later', 'बाद', 'में', 'ನಂತರ', 'nantara', 'baadu', ...W.after, 'মধ্যে', 'ഉള്ളിൽ', 'ਵਿੱਚ');
const NEXT = set('agle', 'agla', 'agli', 'next', 'अगले', 'अगला', 'अगली', 'ಮುಂದಿನ', 'mundina', 'पुढची', 'पुढील', 'पुढचा', 'पुढच्या', 'அடுத்த', 'తదుపరి', 'తర్వాతి', 'వచ్చే', 'পরের', 'পরবর্তী', 'আগামী', 'આગામી', 'આવતા', 'આવતી', 'આવતું', 'આવતે', 'അടുത്ത', 'വരുന്ന', 'ਅਗਲੀ', 'ਅਗਲਾ', 'ਅਗਲੇ');
const DATE_WORD = set('tarikh', 'tareekh', 'date', 'तारीख', 'तारीख़', 'ತಾರೀಖು', 'ತಾರೀಕು', 'ko', 'को', 'तारखेला', 'तारखेस', 'தேதி', 'ஆம்', 'తేదీ', 'తారీఖు', 'తారీఖున', 'তারিখ', 'তারিখে', 'তারিখের', 'તારીખ', 'તારીખે', 'തീയതി', 'ਤਾਰੀਖ', 'ਤਾਰੀਖ਼', 'ਤਰੀਕ');
const IN = set('in', 'after');
const BHAR = set('bhar', 'भर');
// a fortnight: "pakhwade baad"
const FORTNIGHT = set('pakhwada', 'pakhwade', 'पखवाड़ा', 'पखवाड़े', 'पखवारा', 'पखवारे', 'fortnight');
const LATER = set('baad', 'बाद', 'after', 'later', 'ನಂತರ');
// unit forms that already carry "in / after": 10 நாட்களில், 10 రోజుల్లో, 10 दिवसांनी, 10 દિવસમાં
const IN_DAY = set('दिवसांनी', 'दिवसांत', 'நாளில்', 'நாட்களில்', 'రోజుల్లో', 'రోజులలో', 'দিনে', 'দিনের', 'દિવસમાં', 'ദിവസത്തിനുള്ളിൽ', 'ദിവസത്തിനകം', 'ਦਿਨਾਂ');
const IN_WEEK = set('आठवड्यांनी', 'आठवड्यांत', 'आठवड्यात', 'வாரத்தில்', 'வாரங்களில்', 'వారాల్లో', 'వారంలో', 'সপ্তাহে', 'અઠવાડિયામાં', 'ആഴ്ചയ്ക്കുള്ളിൽ', 'ആഴ്ചയ്ക്കകം', 'ਹਫ਼ਤਿਆਂ');
const IN_MONTH = set('महिन्यांनी', 'महिन्यांत', 'महिन्यात', 'மாதத்தில்', 'மாதங்களில்', 'నెలలో', 'నెలల్లో', 'মাসে', 'મહિનામાં', 'മാസത്തിനുള്ളിൽ', 'ਮਹੀਨਿਆਂ');

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
  return MONTHS.findIndex((s) => s.has(tok));
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
    if (TODAY.has(t)) return { date: today, start: i, end: i + 1 };
    if (DAY_AFTER.has(t)) return { date: addDays(today, 2), start: i, end: i + 1 };
    if (TOMORROW.has(t)) {
      if (AFTER_TOMORROW.has(tokens[i + 1])) return { date: addDays(today, 2), start: i, end: i + 2 };
      return { date: addDays(today, 1), start: i, end: i + 1 };
    }
    const wd = WEEKDAYS.findIndex((s) => s.has(t));
    if (wd >= 0) {
      let delta = (wd - today.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      return { date: addDays(today, delta), start: i, end: i + 1 };
    }
    // "agle hafte" / "next week" / "agle mahine" (+ optional day number after)
    if (NEXT.has(t) && tokens[i + 1]) {
      const u = tokens[i + 1];
      if (WEEK.has(u)) return { date: addDays(today, 7), start: i, end: i + 2 };
      if (MONTH.has(u)) {
        const num = parseNumberAt(tokens, i + 2);
        if (num && num.value >= 1 && num.value <= 31 && Number.isInteger(num.value)) {
          const end = DATE_WORD.has(tokens[num.end]) ? num.end + 1 : num.end;
          return { date: new Date(today.getFullYear(), today.getMonth() + 1, num.value), start: i, end };
        }
        return { date: addMonths(today, 1), start: i, end: i + 2 };
      }
    }
    if (FORTNIGHT.has(t)) {
      let end = i + 1;
      while (end < tokens.length && end < i + 3 && (BHAR.has(tokens[end]) || LATER.has(tokens[end]))) end++;
      return { date: addDays(today, 14), start: i, end };
    }
    // "hafte baad", "mahine bhar baad": one week / one month, no number said
    if ((WEEK.has(t) || MONTH.has(t)) && !(i > 0 && parseNumberAt(tokens, i - 1)) && tokens[i + 1] && (BHAR.has(tokens[i + 1]) || LATER.has(tokens[i + 1]))) {
      const end = BHAR.has(tokens[i + 1]) && tokens[i + 2] && LATER.has(tokens[i + 2]) ? i + 3 : i + 2;
      return { date: WEEK.has(t) ? addDays(today, 7) : addMonths(today, 1), start: i, end };
    }
    // "in 10 days"
    const numStart = IN.has(t) ? i + 1 : i;
    const num = parseNumberAt(tokens, numStart);
    if (num && Number.isFinite(num.value) && num.value > 0) {
      const u = tokens[num.end];
      const after = tokens[num.end + 1];
      const fused = u && (IN_DAY.has(u) || IN_WEEK.has(u) || IN_MONTH.has(u));
      if (u && (DAY.has(u) || WEEK.has(u) || MONTH.has(u) || fused)) {
        // "do hafte baad" requires baad/mein/after (or a leading "in"), otherwise it may be an age
        const relative = (after && AFTER.has(after)) || numStart !== i || fused;
        if (relative) {
          const n = num.value;
          const isDay = fused ? IN_DAY.has(u) : DAY.has(u);
          const isWeek = fused ? IN_WEEK.has(u) : WEEK.has(u);
          const date = isDay ? addDays(today, Math.round(n)) : isWeek ? addDays(today, Math.round(n * 7)) : addMonths(today, Math.round(n));
          return { date, start: i, end: num.end + (after && AFTER.has(after) ? 2 : 1) };
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
      if (u && DATE_WORD.has(u) && Number.isInteger(num.value) && num.value >= 1 && num.value <= 31) {
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
  mr: ['जानेवारी', 'फेब्रुवारी', 'मार्च', 'एप्रिल', 'मे', 'जून', 'जुलै', 'ऑगस्ट', 'सप्टेंबर', 'ऑक्टोबर', 'नोव्हेंबर', 'डिसेंबर'],
  ta: ['ஜனவரி', 'பிப்ரவரி', 'மார்ச்', 'ஏப்ரல்', 'மே', 'ஜூன்', 'ஜூலை', 'ஆகஸ்ட்', 'செப்டம்பர்', 'அக்டோபர்', 'நவம்பர்', 'டிசம்பர்'],
  te: ['జనవరి', 'ఫిబ్రవరి', 'మార్చి', 'ఏప్రిల్', 'మే', 'జూన్', 'జూలై', 'ఆగస్టు', 'సెప్టెంబర్', 'అక్టోబర్', 'నవంబర్', 'డిసెంబర్'],
  bn: ['জানুয়ারি', 'ফেব্রুয়ারি', 'মার্চ', 'এপ্রিল', 'মে', 'জুন', 'জুলাই', 'আগস্ট', 'সেপ্টেম্বর', 'অক্টোবর', 'নভেম্বর', 'ডিসেম্বর'],
  gu: ['જાન્યુઆરી', 'ફેબ્રુઆરી', 'માર્ચ', 'એપ્રિલ', 'મે', 'જૂન', 'જુલાઈ', 'ઓગસ્ટ', 'સપ્ટેમ્બર', 'ઓક્ટોબર', 'નવેમ્બર', 'ડિસેમ્બર'],
  ml: ['ജനുവരി', 'ഫെബ്രുവരി', 'മാർച്ച്', 'ഏപ്രിൽ', 'മേയ്', 'ജൂൺ', 'ജൂലൈ', 'ഓഗസ്റ്റ്', 'സെപ്റ്റംബർ', 'ഒക്ടോബർ', 'നവംബർ', 'ഡിസംബർ'],
  pa: ['ਜਨਵਰੀ', 'ਫ਼ਰਵਰੀ', 'ਮਾਰਚ', 'ਅਪ੍ਰੈਲ', 'ਮਈ', 'ਜੂਨ', 'ਜੁਲਾਈ', 'ਅਗਸਤ', 'ਸਤੰਬਰ', 'ਅਕਤੂਬਰ', 'ਨਵੰਬਰ', 'ਦਸੰਬਰ'],
};
export function monthName(m, lang) {
  return (MONTH_NAMES[lang] || MONTH_NAMES.en)[m];
}
