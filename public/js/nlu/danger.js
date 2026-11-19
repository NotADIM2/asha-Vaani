// Danger-sign list. The agent follows THIS LIST ONLY: when a sign is heard it tells the
// ASHA to refer to the PHC now and flags the record. It never diagnoses or advises treatment.
// Sources (see DANGER_SIGNS.md for the full citation table):
//   MCP  = MoHFW Mother and Child Protection Card (2018), "danger signs during pregnancy / after delivery"
//   ANC  = MoHFW Guidelines for Antenatal Care and Skilled Attendance at Birth by ANMs/LHVs/SNs (2010)
//   HBNC = MoHFW Home Based Newborn Care Operational Guidelines (Revised 2014)
//   IMNCI= MoHFW/WHO Integrated Management of Neonatal and Childhood Illness - sick young infant module
import { makeMatcher, keySet } from './match.js';

export const DANGER_SIGNS = [
  {
    id: 'bleeding', groups: ['pregnancy', 'postpartum', 'newborn'], source: 'MCP, ANC, HBNC',
    label: { hi: 'खून बहना (ब्लीडिंग)', en: 'bleeding', kn: 'ರಕ್ತಸ್ರಾವ' },
    patterns: [
      'bleeding~', 'bleed~', 'ब्लीडिंग', 'spotting', 'स्पॉटिंग', 'raktasrav~', 'रक्तस्राव~', 'रक्त स्राव', 'ರಕ್ತಸ್ರಾವ~',
      'khoon|khun|खून|ख़ून|rakt|रक्त|ರಕ್ತ aa|aaya|aayi|aaye|aata|aati|aara|आ|आया|आई|आता|आती|bah~|beh~|gir~|nikal~|ja|jata|jati|gaya|जा|जाता|जाती|गया|बह~|गिर~|निकल~|baruttide|ಬರುತ್ತಿದೆ|hogta~',
      'heavy|zyada|ज़्यादा|ज्यादा|bahut|बहुत khoon|खून|ख़ून',
      'periods|period|mahavari|माहवारी pregnancy|garbh~|गर्भ~',
    ],
    exclude: ['khoon|khun|खून|ख़ून|rakt|रक्त ki|की kami|कमी|jaanch|जांच|जाँच|test|टेस्ट|group|ग्रुप', 'khoon|खून|rakt|रक्त kami|कमी|jaanch|जांच|जाँच|test|टेस्ट'],
  },
  {
    id: 'convulsions', groups: ['pregnancy', 'postpartum', 'newborn'], source: 'MCP, HBNC, IMNCI',
    label: { hi: 'झटके / दौरे (फिट्स)', en: 'convulsions / fits', kn: 'ಫಿಟ್ಸ್ / ಸೆಳೆತ' },
    patterns: [
      'jhatk~|झटक~', 'daura|daure|दौरा|दौरे', 'mirgi|मिर्गी', 'fits|फिट्स|ಫಿಟ್ಸ್', 'fit|फिट aa|aaya|aate|aati|pad~|आ|आया|आते|पड़~|पड~', 'convulsion~|seizure~|कन्वल्शन', 'akad~|अकड़~|अकड~', 'ಸೆಳೆತ~|selet~',
    ],
  },
  {
    id: 'severe_headache_vision', groups: ['pregnancy', 'postpartum'], source: 'MCP, ANC',
    label: { hi: 'तेज़ सिरदर्द या धुंधला दिखना', en: 'severe headache or blurred vision', kn: 'ತೀವ್ರ ತಲೆನೋವು ಅಥವಾ ಮಸುಕಾದ ದೃಷ್ಟಿ' },
    patterns: [
      'tez|तेज़|तेज|bahut|बहुत|severe|zyada|ज़्यादा sar|sir|सिर|सर dard|दर्द', 'severe headache', 'तेज़ सिरदर्द', 'tez|तेज़|तेज|bahut|बहुत sirdard|सिरदर्द',
      'dhundh~|धुंध~|धुँध~|dhundl~', 'blur~|ब्लर', 'aankh|आँख|आंख andhera|अंधेरा', 'ಮಸುಕ~', 'ತೀವ್ರ ತಲೆನೋವು', 'ತಲೆನೋವು|talenovu jaasti|ಜಾಸ್ತಿ|tumba|ತುಂಬಾ',
    ],
  },
  {
    id: 'fever', groups: ['pregnancy', 'postpartum', 'newborn'], source: 'MCP, HBNC, IMNCI',
    label: { hi: 'बुखार', en: 'fever', kn: 'ಜ್ವರ' },
    patterns: ['bukhar|bukhaar|बुखार|बुख़ार', 'fever', 'फीवर', 'jvar~|jwar~|ज्वर|ಜ್ವರ', 'badan|शरीर|sharir|body|बदन garam|गरम|गर्म|hot', 'तप रहा|tap raha'],
  },
  {
    id: 'hypothermia', groups: ['newborn'], source: 'HBNC, IMNCI',
    label: { hi: 'बच्चा बहुत ठंडा', en: 'baby cold to touch (low temperature)', kn: 'ಮಗು ತುಂಬಾ ತಣ್ಣಗಿದೆ' },
    patterns: ['cold to touch', 'hypotherm~', 'ಮಗು|magu ತಣ್ಣ~|tann~', 'baby|bachcha|बच्चा|बच्ची|शिशु|shishu|badan|बदन|sharir|शरीर|haath|हाथ|pair|पैर thanda|ठंडा|ठंडी|ठंडे|cold'],
  },
  {
    id: 'severe_abdominal_pain', groups: ['pregnancy', 'postpartum'], source: 'MCP, ANC',
    label: { hi: 'पेट में तेज़ दर्द', en: 'severe abdominal pain', kn: 'ತೀವ್ರ ಹೊಟ್ಟೆ ನೋವು' },
    patterns: ['pet|पेट me|mein|में tez|तेज़|तेज|bahut|बहुत dard|दर्द', 'tez|तेज़|तेज|bahut|बहुत pet|पेट dard|दर्द', 'severe abdominal|stomach|tummy pain', 'abdominal pain', 'ಹೊಟ್ಟೆ|hotte novu|ನೋವು'],
  },
  {
    id: 'swelling', groups: ['pregnancy', 'postpartum'], source: 'MCP, ANC',
    label: { hi: 'चेहरे/हाथ-पैर पर सूजन', en: 'swelling of face or hands', kn: 'ಮುಖ / ಕೈಕಾಲು ಊತ' },
    patterns: ['sujan|soojan|सूजन|सुजन', 'swelling', 'swollen', 'स्वेलिंग', 'ಊತ|uta', 'ಬಾವು|baavu'],
  },
  {
    id: 'reduced_fetal_movement', groups: ['pregnancy'], source: 'MCP, ANC',
    label: { hi: 'पेट में बच्चे की हलचल कम या बंद', en: 'reduced or no fetal movement', kn: 'ಮಗುವಿನ ಚಲನೆ ಕಡಿಮೆ' },
    negationInside: true,
    patterns: [
      'halchal|hal|हलचल|harkat|हरकत|movement~|मूवमेंट kam|कम|nahi|nahin|नहीं|band|बंद|less|reduced|no',
      'no|reduced|less|decreased fetal|baby movement~',
      'bachcha|baccha|बच्चा|baby hil|हिल|ghoom|घूम nahi|नहीं|kam|कम',
      'ಚಲನೆ|chalane kadime|ಕಡಿಮೆ|illa|ಇಲ್ಲ',
    ],
  },
  {
    id: 'water_leak', groups: ['pregnancy'], source: 'MCP, ANC',
    label: { hi: 'समय से पहले पानी जाना', en: 'leaking water before labour', kn: 'ನೀರು ಸೋರುವಿಕೆ' },
    patterns: ['paani|pani|पानी gir~|ja|jata|jati|gaya|aa|aaya|aa|nikal~|गिर~|जा|जाता|जाती|गया|आ|आया|निकल~|leak~', 'water broke|break~|leak~', 'thaili|थैली phat~|फट~', 'ನೀರು|neeru hogta|ಹೋಗ~|sor~|ಸೋರ~'],
  },
  {
    id: 'breathing_difficulty', groups: ['pregnancy', 'postpartum', 'newborn'], source: 'MCP, HBNC, IMNCI',
    label: { hi: 'साँस लेने में तकलीफ़ / तेज़ साँस', en: 'difficulty or fast breathing', kn: 'ಉಸಿರಾಟದ ತೊಂದರೆ' },
    patterns: [
      'saans|sans|सांस|साँस|स्वास|breath~ taklif|takleef|तकलीफ़|तकलीफ|dikkat|दिक्कत|problem|pareshani|परेशानी|phool|फूल|tez|तेज़|तेज|jaldi|जल्दी|fast',
      'tez|तेज़|तेज|jaldi|जल्दी|fast saans|sans|सांस|साँस|breath~', 'breathless~', 'difficulty breathing', 'pasli|पसली chal~|चल~', 'chest indrawing', 'chhati|छाती dhans~|धँस~|धंस~|andar|अंदर',
      'ಉಸಿರಾಟ~|usirat~ tondare|ತೊಂದರೆ', 'ಉಸಿರು|usiru kashta|ಕಷ್ಟ',
    ],
  },
  {
    id: 'not_feeding', groups: ['newborn'], source: 'HBNC, IMNCI',
    label: { hi: 'बच्चा दूध नहीं पी रहा', en: 'baby not feeding well', kn: 'ಮಗು ಹಾಲು ಕುಡಿಯುತ್ತಿಲ್ಲ' },
    negationInside: true,
    patterns: [
      'doodh|dudh|दूध|feed~|stanpan|स्तनपान nahi|nahin|नहीं|kam|कम|band|बंद|not|stop~|poorly|less',
      'not|poor|stopped feeding|feed~|suck~', 'chus|choos|चूस nahi|नहीं|kam|कम|पा|pa',
      'ಹಾಲು|haalu kudiyuttilla|ಕುಡಿಯುತ್ತಿಲ್ಲ|kudiyalla|ಕುಡಿಯಲ್ಲ',
    ],
  },
  {
    id: 'lethargy', groups: ['newborn', 'pregnancy', 'postpartum'], source: 'HBNC, IMNCI',
    label: { hi: 'सुस्ती / बेहोशी', en: 'lethargic or unconscious', kn: 'ಮಂಕು / ಪ್ರಜ್ಞೆ ಇಲ್ಲ' },
    patterns: ['sust|susti|सुस्त|सुस्ती', 'behosh~|बेहोश~', 'lethargic|letharg~|unconscious|limp', 'हिल डुल नहीं', 'ಪ್ರಜ್ಞೆ|prajne illa|ಇಲ್ಲ', 'ಮಂಕು|manku'],
  },
  {
    id: 'jaundice', groups: ['newborn'], source: 'HBNC, IMNCI',
    label: { hi: 'पीलिया (हथेली/तलवे पीले)', en: 'jaundice (yellow palms or soles)', kn: 'ಕಾಮಾಲೆ (ಹಳದಿ)' },
    patterns: ['piliya|peeliya|पीलिया', 'jaundice', 'पीला|पीली|पीले|peela|peeli|peele|pila|pili|yellow', 'ಕಾಮಾಲೆ|kaamale|ಹಳದಿ|haladi'],
  },
  {
    id: 'umbilical_infection', groups: ['newborn'], source: 'HBNC, IMNCI',
    label: { hi: 'नाल में मवाद या लाली', en: 'umbilicus red or with pus', kn: 'ಹೊಕ್ಕಳು ಕೆಂಪು / ಕೀವು' },
    patterns: ['naal|naal|नाल|nabhi|नाभि|umbilic~|cord pus|मवाद|mavad|laal|लाल|red|sujan|सूजन', 'ಹೊಕ್ಕಳು|hokkalu kempu|ಕೆಂಪು|keevu|ಕೀವು'],
  },
  {
    id: 'skin_pustules', groups: ['newborn'], source: 'HBNC, IMNCI',
    label: { hi: 'त्वचा पर मवाद वाले दाने', en: 'skin pustules', kn: 'ಚರ್ಮದ ಮೇಲೆ ಕೀವು ಗುಳ್ಳೆ' },
    patterns: ['phunsi~|फुंसी|फुंसियां|फुंसियाँ', 'pustule~', 'मवाद वाले दाने', 'ಗುಳ್ಳೆ|gulle'],
  },
  {
    id: 'vomiting_everything', groups: ['newborn', 'pregnancy'], source: 'IMNCI',
    label: { hi: 'सब कुछ उल्टी कर देना', en: 'vomiting everything', kn: 'ಎಲ್ಲವನ್ನೂ ವಾಂತಿ' },
    patterns: ['baar|बार baar|बार ulti|उल्टी', 'sab|सब kuch|कुछ ulti|उल्टी', 'vomit~ everything', 'ಎಲ್ಲ~ ವಾಂತಿ|vanti'],
  },
  {
    id: 'foul_discharge', groups: ['postpartum'], source: 'MCP',
    label: { hi: 'बदबूदार स्राव', en: 'foul-smelling discharge', kn: 'ದುರ್ವಾಸನೆಯ ಸ್ರಾವ' },
    patterns: ['badboo~|badbu~|बदबू~', 'foul smell~|discharge', 'ದುರ್ವಾಸನೆ|durvasane'],
  },
];

// Numeric thresholds checked against extracted vitals.
export const NUMERIC_RULES = [
  { id: 'high_bp', source: 'MCP, ANC', label: { hi: 'बीपी बहुत ज़्यादा (140/90 या ऊपर)', en: 'high BP (140/90 or more)', kn: 'ಅಧಿಕ ರಕ್ತದೊತ್ತಡ' }, test: (f) => f.bp && (f.bp.sys >= 140 || f.bp.dia >= 90) },
  { id: 'severe_anaemia', source: 'MCP, ANC', label: { hi: 'बहुत कम हीमोग्लोबिन (7 से कम)', en: 'severe anaemia (Hb below 7)', kn: 'ತೀವ್ರ ರಕ್ತಹೀನತೆ' }, test: (f) => typeof f.hb === 'number' && f.hb < 7 },
  { id: 'fever', source: 'HBNC, IMNCI', label: null, test: (f, g) => typeof f.tempC === 'number' && f.tempC >= (g === 'newborn' ? 37.5 : 38) },
  { id: 'hypothermia', source: 'HBNC, IMNCI', label: null, test: (f, g) => g === 'newborn' && typeof f.tempC === 'number' && f.tempC < 35.5 },
  { id: 'breathing_difficulty', source: 'HBNC, IMNCI', label: null, test: (f, g) => g === 'newborn' && typeof f.respRate === 'number' && f.respRate >= 60 },
  { id: 'very_low_birth_weight', source: 'HBNC', label: { hi: 'बहुत कम वज़न (1.8 किलो से कम)', en: 'very low weight (below 1.8 kg)', kn: 'ತುಂಬಾ ಕಡಿಮೆ ತೂಕ' }, test: (f, g) => g === 'newborn' && typeof f.weightKg === 'number' && f.weightKg < 1.8 },
];

const matchers = DANGER_SIGNS.map((d) => ({ sign: d, m: makeMatcher(d.patterns), ex: d.exclude ? makeMatcher(d.exclude) : null }));

const NEG = keySet(['nahi', 'nahin', 'nhi', 'na', 'no', 'not', 'नहीं', 'नही', 'ना', 'illa', 'ಇಲ್ಲ', 'without', 'bina', 'बिना', 'none', 'never', 'nil']);
const NEG_BEFORE = keySet(['no', 'not', 'without', 'bina', 'बिना', 'koi', 'कोई', 'never', 'nil', 'none', 'denies']);
// "bleeding nahi ruk rahi" = still bleeding; "bukhar nahi utar raha" = still fever
const NOT_NEG_FOLLOW = keySet(['ruk', 'ruka', 'ruki', 'rukh', 'रुक', 'रुका', 'रुकी', 'रुक रहा', 'band', 'बंद', 'utar', 'उतर', 'thik', 'theek', 'ठीक', 'stop', 'stopping', 'kam', 'कम', 'thamb', 'ja', 'जा']);
const WORD_NOT = keySet(['koi', 'कोई']);
const ABSENT_WORDS = keySet(['normal', 'नॉर्मल', 'theek', 'ठीक', 'fine', 'sahi', 'सही', 'ok']);

function isNegated(tokens, m, sign) {
  if (sign.negationInside) return false;
  // after: "bleeding nahi hai", "bukhar nahi", "jhatke nahi aaye"
  for (let q = m.end; q < Math.min(tokens.length, m.end + 3); q++) {
    if (NEG.has(tokens[q].key)) {
      // "ruk nahi rahi" / "nahi ruk rahi" negate the stopping, not the sign
      const nxt = tokens[q + 1];
      if (nxt && NOT_NEG_FOLLOW.has(nxt.key)) return false;
      for (let r = m.end; r < q; r++) if (NOT_NEG_FOLLOW.has(tokens[r].key)) return false;
      return true;
    }
  }
  // before: "no bleeding", "koi bleeding nahi", "bina bukhar"
  for (let q = Math.max(0, m.start - 2); q < m.start; q++) {
    if (NEG_BEFORE.has(tokens[q].key) && !WORD_NOT.has(tokens[q].key)) return true;
    if (WORD_NOT.has(tokens[q].key)) {
      // "koi" alone is not negation ("koi bleeding?"), it needs a later nahi
      for (let r = m.end; r < Math.min(tokens.length, m.end + 4); r++) if (NEG.has(tokens[r].key)) return true;
    }
  }
  return false;
}

// Scan tokens; returns { present: [id...], absent: [id...] } - absent = explicitly denied.
export function detectDangerSigns(tokens) {
  const present = new Set();
  const absent = new Set();
  for (const { sign, m, ex } of matchers) {
    const excluded = ex ? ex.findAll(tokens) : [];
    for (const hit of m.findAll(tokens)) {
      if (excluded.some((x) => x.start < hit.end && hit.start < x.end)) continue;
      if (isNegated(tokens, hit, sign)) absent.add(sign.id); else present.add(sign.id);
    }
  }
  for (const id of present) absent.delete(id);
  return { present: [...present], absent: [...absent] };
}

export function numericDangers(fields, group) {
  return NUMERIC_RULES.filter((r) => r.test(fields, group)).map((r) => r.id);
}

export function dangerLabel(id, lang) {
  const s = DANGER_SIGNS.find((d) => d.id === id) || NUMERIC_RULES.find((r) => r.id === id && r.label);
  if (!s) return id;
  return s.label[lang] || s.label.en;
}

export function dangerSource(id) {
  const s = DANGER_SIGNS.find((d) => d.id === id) || NUMERIC_RULES.find((r) => r.id === id);
  return s ? s.source : '';
}

export { ABSENT_WORDS };
