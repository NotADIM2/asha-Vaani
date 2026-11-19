// Every sentence the agent can say. Nothing spoken is generated free-form, so the
// health guardrails (no diagnosis, no dosage) hold by construction.
import { numberToWords, digitsToWords } from './nlu/numbers.js';
import { monthName, fromIso } from './nlu/dates.js';
import { dangerLabel } from './nlu/danger.js';

export const LANGS = {
  hi: { name: 'हिन्दी', stt: 'hi-IN,en-IN', tts: 'hi-IN', browser: 'hi-IN' },
  en: { name: 'English', stt: 'en-IN,hi-IN', tts: 'en-IN', browser: 'en-IN' },
  kn: { name: 'ಕನ್ನಡ', stt: 'kn-IN,en-IN', tts: 'kn-IN', browser: 'kn-IN' },
};

const DOSE = {
  hi: { 0: 'ज़ीरो', 1: 'पहला', 2: 'दूसरा', 3: 'तीसरा', B: 'बूस्टर', B1: 'बूस्टर' },
  en: { 0: 'zero', 1: 'one', 2: 'two', 3: 'three', B: 'booster', B1: 'booster' },
  kn: { 0: 'ಸೊನ್ನೆ', 1: 'ಮೊದಲ', 2: 'ಎರಡನೇ', 3: 'ಮೂರನೇ', B: 'ಬೂಸ್ಟರ್', B1: 'ಬೂಸ್ಟರ್' },
};
const VACCINE_NAME = {
  hi: { Td: 'टी डी', BCG: 'बी सी जी', OPV: 'ओ पी वी', Penta: 'पेंटा', RVV: 'रोटा', PCV: 'पी सी वी', fIPV: 'आई पी वी', MR: 'एम आर', JE: 'जे ई', VitA: 'विटामिन ए', HepB: 'हेपेटाइटिस बी', DPT: 'डी पी टी' },
  en: { Td: 'T D', BCG: 'B C G', OPV: 'O P V', Penta: 'Penta', RVV: 'Rota', PCV: 'P C V', fIPV: 'I P V', MR: 'M R', JE: 'J E', VitA: 'Vitamin A', HepB: 'Hepatitis B', DPT: 'D P T' },
  kn: { Td: 'ಟಿ ಡಿ', BCG: 'ಬಿ ಸಿ ಜಿ', OPV: 'ಒ ಪಿ ವಿ', Penta: 'ಪೆಂಟಾ', RVV: 'ರೋಟಾ', PCV: 'ಪಿ ಸಿ ವಿ', fIPV: 'ಐ ಪಿ ವಿ', MR: 'ಎಂ ಆರ್', JE: 'ಜೆ ಇ', VitA: 'ವಿಟಮಿನ್ ಎ', HepB: 'ಹೆಪಟೈಟಿಸ್ ಬಿ', DPT: 'ಡಿ ಪಿ ಟಿ' },
};
const VISIT_NAME = {
  hi: { ANC: 'ए एन सी', PNC: 'पी एन सी', HBNC: 'नवजात शिशु', IMM: 'टीकाकरण' },
  en: { ANC: 'A N C', PNC: 'P N C', HBNC: 'newborn', IMM: 'immunisation' },
  kn: { ANC: 'ಎ ಎನ್ ಸಿ', PNC: 'ಪಿ ಎನ್ ಸಿ', HBNC: 'ನವಜಾತ ಶಿಶು', IMM: 'ಲಸಿಕೆ' },
};
export const VISIT_LABEL = { ANC: 'ANC (pregnancy)', PNC: 'PNC (after delivery)', HBNC: 'HBNC (newborn)', IMM: 'Immunisation' };

export function vaccineSpoken(code, lang) {
  const [base, dose] = code.split('-');
  const name = (VACCINE_NAME[lang] || VACCINE_NAME.en)[base] || base;
  if (dose === undefined) return name;
  const d = (DOSE[lang] || DOSE.en)[dose] ?? dose;
  return lang === 'en' ? `${name} ${d}` : `${name} ${d}`;
}

export function dateSpoken(isoStr, lang) {
  const d = fromIso(isoStr);
  const day = numberToWords(d.getDate(), lang);
  const m = monthName(d.getMonth(), lang);
  return lang === 'en' ? `${m} ${day}` : `${day} ${m}`;
}

function list(items, lang) {
  if (!items.length) return '';
  if (items.length === 1) return items[0];
  const and = { hi: 'और', en: 'and', kn: 'ಮತ್ತು' }[lang] || 'and';
  return `${items.slice(0, -1).join(', ')} ${and} ${items[items.length - 1]}`;
}

const T = {
  hi: {
    greet: 'नमस्ते, मैं आशा वाणी हूँ, एक ए आई सहायक, इंसान नहीं। विज़िट के नोट्स बोलिए: नाम या आईडी, वज़न, टीके और अगली विज़िट।',
    ack: 'ठीक है।',
    askBeneficiary: 'किसकी विज़िट है? नाम या आईडी बताइए।',
    askVisitType: 'कौन सी विज़िट है? ए एन सी, पी एन सी, नवजात शिशु, या टीकाकरण?',
    askWeight: 'वज़न कितना है?',
    askVaccinesDue: 'कोई टीका बाकी है?',
    askNextVisit: (s) => (s ? `अगली विज़िट कब है? शेड्यूल के हिसाब से ${s}। हाँ बोलें तो यही रख दूँगी।` : 'अगली विज़िट कब है?'),
    disambiguate: (opts) => `इस नाम की ${numberToWords(opts.length, 'hi')} महिलाएँ हैं: ${opts.join('; ')}। कौन सी? आईडी या वार्ड बताइए।`,
    option: (b) => `${b.nameHi || b.name}, वार्ड ${numberToWords(b.ward, 'hi')}, पति ${b.husband}`,
    newPerson: (n) => `${n} रजिस्टर में नहीं मिलीं, नया रिकॉर्ड बना दिया।`,
    readIntro: 'पढ़कर सुनाती हूँ।',
    idPart: (id) => `आईडी ${digitsToWords(id, 'hi')}`,
    visitPart: (v) => `${VISIT_NAME.hi[v]} विज़िट`,
    weightPart: (w) => `वज़न ${numberToWords(w, 'hi')} किलो`,
    bpPart: (bp) => `बी पी ${numberToWords(bp.sys, 'hi')} बटा ${numberToWords(bp.dia, 'hi')}`,
    hbPart: (hb) => `एच बी ${numberToWords(hb, 'hi')}`,
    tempPart: (t) => `तापमान ${numberToWords(t, 'hi')} डिग्री`,
    duePart: (items) => (items.length ? `बाकी टीके: ${list(items, 'hi')}` : 'कोई टीका बाकी नहीं'),
    givenPart: (items) => `आज लगे टीके: ${list(items, 'hi')}`,
    nextPart: (d) => `अगली विज़िट ${d}`,
    dangerPart: (signs) => `खतरे का संकेत: ${signs}, पी एच सी रेफ़र`,
    confirmQ: 'क्या सब सही है?',
    fixed: (parts) => `बदल दिया: ${parts}। अब सही है?`,
    whatWrong: 'क्या गलत है? सही जानकारी बोलिए।',
    askCorrectWeight: 'सही वज़न बोलिए।',
    checkWeight: (w, who) => `${who} के लिए वज़न ${numberToWords(w, 'hi')} किलो असामान्य लगता है। सही है तो हाँ बोलिए, नहीं तो सही वज़न बोलिए।`,
    who: { newborn: 'नवजात शिशु', child: 'बच्चे', pregnancy: 'गर्भवती महिला', postpartum: 'माँ' },
    askCorrectDate: 'सही तारीख बोलिए।',
    askCorrectId: 'सही आईडी बोलिए।',
    saved: (f) => `सेव हो गया। ${f} अगले घर के नोट्स बोलिए।`,
    savedFollow: (d, refer) => (refer ? `आज ही पी एच सी रेफ़र करें, और अगली विज़िट ${d}।` : `अगली विज़िट ${d} को फ़ॉलो-अप लिस्ट में जोड़ दी।`),
    alert: (signs) => `खतरे का संकेत: ${signs}। कृपया अभी पी एच सी रेफ़र करें। रिकॉर्ड पर फ़्लैग लगा दिया है।`,
    refuse: 'मैं ए आई सहायक हूँ, दवा या इलाज की सलाह नहीं दे सकती। कृपया ए एन एम या पी एच सी डॉक्टर से पूछें।',
    notUnderstood: 'माफ़ कीजिए, समझ नहीं आया। फिर से बोलिए।',
    newVisit: 'नई विज़िट शुरू। नोट्स बोलिए।',
    cancelled: 'यह विज़िट रद्द कर दी। नए नोट्स बोलिए।',
    followups: (items) => (items.length ? `फ़ॉलो-अप: ${list(items, 'hi')}।` : 'अभी कोई फ़ॉलो-अप नहीं है।'),
    followItem: (f) => `${f.name}, ${f.refer ? 'पी एच सी रेफ़र, ' : ''}${f.when}`,
    none: 'कोई नहीं',
    today: 'आज',
  },
  en: {
    greet: "Hello, I am Asha Vaani, an A I assistant, not a human. Tell me the visit notes: name or ID, weight, vaccines and next visit.",
    ack: 'Okay.',
    askBeneficiary: 'Whose visit is this? Tell me the name or ID.',
    askVisitType: 'Which visit is this? A N C, P N C, newborn, or immunisation?',
    askWeight: 'What is the weight?',
    askVaccinesDue: 'Is any vaccine due?',
    askNextVisit: (s) => (s ? `When is the next visit? The schedule says ${s}. Say yes to keep it.` : 'When is the next visit?'),
    disambiguate: (opts) => `There are ${numberToWords(opts.length, 'en')} women with this name: ${opts.join('; ')}. Which one? Tell me the ID or ward.`,
    option: (b) => `${b.name}, ward ${numberToWords(b.ward, 'en')}, husband ${b.husband}`,
    newPerson: (n) => `${n} is not in the register, so I made a new record.`,
    readIntro: 'Reading it back.',
    idPart: (id) => `I D ${digitsToWords(id, 'en')}`,
    visitPart: (v) => `${VISIT_NAME.en[v]} visit`,
    weightPart: (w) => `weight ${numberToWords(w, 'en')} kilo`,
    bpPart: (bp) => `B P ${numberToWords(bp.sys, 'en')} over ${numberToWords(bp.dia, 'en')}`,
    hbPart: (hb) => `H B ${numberToWords(hb, 'en')}`,
    tempPart: (t) => `temperature ${numberToWords(t, 'en')} degrees`,
    duePart: (items) => (items.length ? `vaccines due: ${list(items, 'en')}` : 'no vaccines due'),
    givenPart: (items) => `given today: ${list(items, 'en')}`,
    nextPart: (d) => `next visit ${d}`,
    dangerPart: (signs) => `danger sign: ${signs}, refer to P H C`,
    confirmQ: 'Is everything correct?',
    fixed: (parts) => `Changed: ${parts}. Is it correct now?`,
    whatWrong: 'What is wrong? Tell me the correct detail.',
    askCorrectWeight: 'Tell me the correct weight.',
    checkWeight: (w, who) => `${numberToWords(w, 'en')} kilo looks unusual for ${who}. Say yes if it is right, or tell me the correct weight.`,
    who: { newborn: 'a newborn', child: 'a child', pregnancy: 'a pregnant woman', postpartum: 'a mother' },
    askCorrectDate: 'Tell me the correct date.',
    askCorrectId: 'Tell me the correct I D.',
    saved: (f) => `Saved. ${f} Tell me the notes for the next house.`,
    savedFollow: (d, refer) => (refer ? `Refer to the P H C today, and next visit ${d}.` : `Next visit ${d} is on the follow-up list.`),
    alert: (signs) => `Danger sign: ${signs}. Please refer to the P H C now. I have flagged the record.`,
    refuse: 'I am an A I assistant and cannot give medicine or treatment advice. Please ask the A N M or the P H C doctor.',
    notUnderstood: 'Sorry, I did not catch that. Please say it again.',
    newVisit: 'New visit started. Tell me the notes.',
    cancelled: 'Visit discarded. Tell me the new notes.',
    followups: (items) => (items.length ? `Follow-ups: ${list(items, 'en')}.` : 'No follow-ups right now.'),
    followItem: (f) => `${f.name}, ${f.refer ? 'refer to P H C, ' : ''}${f.when}`,
    none: 'none',
    today: 'today',
  },
  kn: {
    greet: 'ನಮಸ್ಕಾರ, ನಾನು ಆಶಾ ವಾಣಿ, ಒಂದು ಎ ಐ ಸಹಾಯಕ, ಮನುಷ್ಯಳಲ್ಲ. ಭೇಟಿಯ ವಿವರ ಹೇಳಿ: ಹೆಸರು ಅಥವಾ ಐಡಿ, ತೂಕ, ಲಸಿಕೆ ಮತ್ತು ಮುಂದಿನ ಭೇಟಿ.',
    ack: 'ಸರಿ.',
    askBeneficiary: 'ಯಾರ ಭೇಟಿ? ಹೆಸರು ಅಥವಾ ಐಡಿ ಹೇಳಿ.',
    askVisitType: 'ಯಾವ ಭೇಟಿ? ಎ ಎನ್ ಸಿ, ಪಿ ಎನ್ ಸಿ, ನವಜಾತ ಶಿಶು, ಅಥವಾ ಲಸಿಕೆ?',
    askWeight: 'ತೂಕ ಎಷ್ಟು?',
    askVaccinesDue: 'ಯಾವುದಾದರೂ ಲಸಿಕೆ ಬಾಕಿ ಇದೆಯೇ?',
    askNextVisit: (s) => (s ? `ಮುಂದಿನ ಭೇಟಿ ಯಾವಾಗ? ವೇಳಾಪಟ್ಟಿ ಪ್ರಕಾರ ${s}. ಹೌದು ಎಂದರೆ ಅದನ್ನೇ ಇಡುತ್ತೇನೆ.` : 'ಮುಂದಿನ ಭೇಟಿ ಯಾವಾಗ?'),
    disambiguate: (opts) => `ಈ ಹೆಸರಿನ ${numberToWords(opts.length, 'kn')} ಮಹಿಳೆಯರಿದ್ದಾರೆ: ${opts.join('; ')}. ಯಾರು? ಐಡಿ ಅಥವಾ ವಾರ್ಡ್ ಹೇಳಿ.`,
    option: (b) => `${b.nameKn || b.name}, ವಾರ್ಡ್ ${numberToWords(b.ward, 'kn')}`,
    newPerson: (n) => `${n} ನೋಂದಣಿಯಲ್ಲಿ ಇಲ್ಲ, ಹೊಸ ದಾಖಲೆ ಮಾಡಿದೆ.`,
    readIntro: 'ಓದಿ ಹೇಳುತ್ತೇನೆ.',
    idPart: (id) => `ಐಡಿ ${digitsToWords(id, 'kn')}`,
    visitPart: (v) => `${VISIT_NAME.kn[v]} ಭೇಟಿ`,
    weightPart: (w) => `ತೂಕ ${numberToWords(w, 'kn')} ಕೆಜಿ`,
    bpPart: (bp) => `ಬಿ ಪಿ ${numberToWords(bp.sys, 'kn')} ಬೈ ${numberToWords(bp.dia, 'kn')}`,
    hbPart: (hb) => `ಎಚ್ ಬಿ ${numberToWords(hb, 'kn')}`,
    tempPart: (t) => `ತಾಪಮಾನ ${numberToWords(t, 'kn')} ಡಿಗ್ರಿ`,
    duePart: (items) => (items.length ? `ಬಾಕಿ ಲಸಿಕೆ: ${list(items, 'kn')}` : 'ಯಾವ ಲಸಿಕೆಯೂ ಬಾಕಿ ಇಲ್ಲ'),
    givenPart: (items) => `ಇಂದು ಕೊಟ್ಟ ಲಸಿಕೆ: ${list(items, 'kn')}`,
    nextPart: (d) => `ಮುಂದಿನ ಭೇಟಿ ${d}`,
    dangerPart: (signs) => `ಅಪಾಯದ ಸೂಚನೆ: ${signs}, ಪಿ ಎಚ್ ಸಿ ಗೆ ಕಳುಹಿಸಿ`,
    confirmQ: 'ಎಲ್ಲಾ ಸರಿಯೇ?',
    fixed: (parts) => `ಬದಲಾಯಿಸಿದೆ: ${parts}. ಈಗ ಸರಿಯೇ?`,
    whatWrong: 'ಏನು ತಪ್ಪು? ಸರಿಯಾದ ವಿವರ ಹೇಳಿ.',
    askCorrectWeight: 'ಸರಿಯಾದ ತೂಕ ಹೇಳಿ.',
    checkWeight: (w, who) => `${who} ತೂಕ ${numberToWords(w, 'kn')} ಕೆಜಿ ಅಸಾಮಾನ್ಯವಾಗಿದೆ. ಸರಿ ಇದ್ದರೆ ಹೌದು ಎನ್ನಿ, ಇಲ್ಲದಿದ್ದರೆ ಸರಿಯಾದ ತೂಕ ಹೇಳಿ.`,
    who: { newborn: 'ನವಜಾತ ಶಿಶುವಿನ', child: 'ಮಗುವಿನ', pregnancy: 'ಗರ್ಭಿಣಿಯ', postpartum: 'ತಾಯಿಯ' },
    askCorrectDate: 'ಸರಿಯಾದ ದಿನಾಂಕ ಹೇಳಿ.',
    askCorrectId: 'ಸರಿಯಾದ ಐಡಿ ಹೇಳಿ.',
    saved: (f) => `ಉಳಿಸಲಾಗಿದೆ. ${f} ಮುಂದಿನ ಮನೆಯ ವಿವರ ಹೇಳಿ.`,
    savedFollow: (d, refer) => (refer ? `ಇಂದೇ ಪಿ ಎಚ್ ಸಿ ಗೆ ಕಳುಹಿಸಿ, ಮುಂದಿನ ಭೇಟಿ ${d}.` : `ಮುಂದಿನ ಭೇಟಿ ${d} ಪಟ್ಟಿಗೆ ಸೇರಿಸಿದೆ.`),
    alert: (signs) => `ಅಪಾಯದ ಸೂಚನೆ: ${signs}. ದಯವಿಟ್ಟು ಈಗಲೇ ಪಿ ಎಚ್ ಸಿ ಗೆ ಕಳುಹಿಸಿ. ದಾಖಲೆಯಲ್ಲಿ ಗುರುತು ಹಾಕಿದ್ದೇನೆ.`,
    refuse: 'ನಾನು ಎ ಐ ಸಹಾಯಕ, ಔಷಧಿ ಅಥವಾ ಚಿಕಿತ್ಸೆಯ ಸಲಹೆ ನೀಡಲು ಸಾಧ್ಯವಿಲ್ಲ. ದಯವಿಟ್ಟು ಎ ಎನ್ ಎಂ ಅಥವಾ ಪಿ ಎಚ್ ಸಿ ವೈದ್ಯರನ್ನು ಕೇಳಿ.',
    notUnderstood: 'ಕ್ಷಮಿಸಿ, ಅರ್ಥವಾಗಲಿಲ್ಲ. ಮತ್ತೆ ಹೇಳಿ.',
    newVisit: 'ಹೊಸ ಭೇಟಿ ಶುರು. ವಿವರ ಹೇಳಿ.',
    cancelled: 'ಈ ಭೇಟಿ ರದ್ದು ಮಾಡಿದೆ. ಹೊಸ ವಿವರ ಹೇಳಿ.',
    followups: (items) => (items.length ? `ಮುಂದಿನ ಕೆಲಸ: ${list(items, 'kn')}.` : 'ಈಗ ಯಾವುದೇ ಮುಂದಿನ ಕೆಲಸ ಇಲ್ಲ.'),
    followItem: (f) => `${f.name}, ${f.refer ? 'ಪಿ ಎಚ್ ಸಿ, ' : ''}${f.when}`,
    none: 'ಯಾವುದೂ ಇಲ್ಲ',
    today: 'ಇಂದು',
  },
};

export function t(lang) {
  return T[lang] || T.hi;
}

export function dangersSpoken(ids, lang) {
  return list(ids.map((id) => dangerLabel(id, lang)), lang);
}

// UI strings (screen text, not spoken)
export const UI = {
  hi: { start: 'शुरू करें', listening: 'सुन रही हूँ…', speaking: 'बोल रही हूँ…', tapToTalk: 'बोलने के लिए दबाएँ', hold: 'दबाकर बोलें', save: 'सेव', readback: 'पढ़कर सुनाओ', newVisit: 'नई विज़िट', visit: 'विज़िट', followups: 'फ़ॉलो-अप', records: 'रिकॉर्ड', settings: 'सेटिंग', refer: 'अभी PHC रेफ़र करें', call108: '108 कॉल करें' },
  en: { start: 'Start', listening: 'Listening…', speaking: 'Speaking…', tapToTalk: 'Tap to talk', hold: 'Hold to talk', save: 'Save', readback: 'Read back', newVisit: 'New visit', visit: 'Visit', followups: 'Follow-ups', records: 'Records', settings: 'Settings', refer: 'Refer to PHC now', call108: 'Call 108' },
  kn: { start: 'ಪ್ರಾರಂಭಿಸಿ', listening: 'ಕೇಳುತ್ತಿದ್ದೇನೆ…', speaking: 'ಮಾತನಾಡುತ್ತಿದ್ದೇನೆ…', tapToTalk: 'ಮಾತನಾಡಲು ಒತ್ತಿ', hold: 'ಒತ್ತಿ ಹಿಡಿದು ಮಾತನಾಡಿ', save: 'ಉಳಿಸಿ', readback: 'ಓದಿ ಹೇಳು', newVisit: 'ಹೊಸ ಭೇಟಿ', visit: 'ಭೇಟಿ', followups: 'ಮುಂದಿನ ಕೆಲಸ', records: 'ದಾಖಲೆಗಳು', settings: 'ಸೆಟ್ಟಿಂಗ್', refer: 'ಈಗಲೇ PHC ಗೆ ಕಳುಹಿಸಿ', call108: '108 ಕರೆ ಮಾಡಿ' },
};
