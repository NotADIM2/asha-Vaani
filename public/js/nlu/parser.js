// Turns one utterance into visit-form fields, danger signs and intents.
// Deterministic on purpose: it runs in under a millisecond, works offline, and can't
// invent a number that wasn't spoken.
import { tokenize } from './translit.js';
import { parseNumberAt, findNumbers } from './numbers.js';
import { findDate, iso } from './dates.js';
import { makeMatcher, keySet } from './match.js';
import { detectDangerSigns } from './danger.js';
import { findNames } from './registry.js';
import { WORDS as W, PHRASES as P } from './regional.js';

const M = (...p) => makeMatcher(p);
const K = (...w) => keySet(w);

// ---------- field keywords ----------
const WEIGHT_KW = K('vajan', 'wajan', 'wazan', 'vazan', 'weight', 'वजन', 'वज़न', 'वेट', 'ತೂಕ', 'tooka', 'tuka', 'எடை', 'బరువు', 'ওজন', ...W.weight);
const KG = K('kilo', 'kilos', 'kg', 'kgs', 'kilogram', 'kilograms', 'किलो', 'किग्रा', 'केजी', 'ಕೆಜಿ', 'ಕಿಲೋ', 'கிலோ', 'కిలో', 'কেজি', ...W.kg);
const GRAM = K('gram', 'grams', 'gm', 'gms', 'g', 'ग्राम', 'ग्रा', 'ಗ್ರಾಂ', 'கிராம்', 'గ్రాము', 'গ্রাম', ...W.gram);
const ID_KW = K('id', 'आईडी', 'ಐಡಿ', 'aidi', 'number', 'नंबर', 'nambar', 'sankhya', 'संख्या', 'beneficiary', 'rch', 'mcts', 'ಸಂಖ್ಯೆ', 'नम्बर', ...W.id);
const BP_KW = M('bp', 'बीपी', 'ಬಿಪಿ', 'blood pressure', 'ब्लड प्रेशर', 'रक्तचाप', 'raktchap', ...W.bp);
const BP_SEP = K('by', 'upar', 'उपर', 'ऊपर', 'over', 'slash', 'बाय', 'पर', 'aur', 'and', 'by', 'बटा', 'bata', ...W.bpSep);
const HB_KW = M('hb', 'एचबी', 'hemoglobin', 'haemoglobin', 'हीमोग्लोबिन', 'हिमोग्लोबिन', 'ಹಿಮೋಗ್ಲೋಬಿನ್', 'ಎಚ್‌ಬಿ', ...W.hb);
const TEMP_KW = K('bukhar', 'bukhaar', 'बुखार', 'temperature', 'temp', 'तापमान', 'tapman', 'taapmaan', 'fever', 'ಜ್ವರ', 'ತಾಪಮಾನ', 'टेम्परेचर', 'फीवर', ...W.temp);
const FAHRENHEIT = K('f', 'fahrenheit', 'farenheit', 'फारेनहाइट', 'फ़ारेनहाइट');
const RESP_KW = K('saans', 'sans', 'सांस', 'साँस', 'breathing', 'breath', 'respiratory', 'respiration', 'श्वसन', 'ಉಸಿರಾಟ', 'ಉಸಿರು', ...W.resp);
const MONTH_W = K('mahine', 'mahina', 'month', 'months', 'महीने', 'महीना', 'माह', 'ತಿಂಗಳು', 'ತಿಂಗಳ', ...W.month);
const WEEK_W = K('hafte', 'hafta', 'week', 'weeks', 'हफ्ते', 'हफ़्ते', 'सप्ताह', 'ವಾರ', 'ವಾರದ', ...W.week);
const DAY_W = K('din', 'day', 'days', 'दिन', 'ದಿನ', 'ದಿನದ', ...W.day);
const PREG_CTX = K('garbhvati', 'garbhavati', 'गर्भवती', 'pregnant', 'pregnancy', 'प्रेग्नेंट', 'garbh', 'गर्भ', 'ಗರ್ಭಿಣಿ', 'garbhini', 'ka', 'ki', 'का', 'की', 'chal', 'chal raha', 'चल', ...W.preg);
const BABY_CTX = K('baby', 'bachcha', 'baccha', 'bachchi', 'बच्चा', 'बच्ची', 'बच्चे', 'shishu', 'शिशु', 'navjat', 'नवजात', 'newborn', 'ಮಗು', 'magu', 'ಶಿಶು', 'old', ...W.baby);
const AFTER_W = K('baad', 'बाद', 'after', 'later', 'ನಂತರ', 'mein', 'में', ...W.after);

const VISIT_TYPES = [
  ['ANC', M('anc', 'एएनसी', 'ए एन सी', 'antenatal', 'garbh~', 'गर्भ~', 'pregnan~', 'प्रेग्नें~', 'प्रसव पूर्व', 'prasav purv', 'ಗರ್ಭಿಣಿ', 'garbhini', 'ಗರ್ಭ~', 'हफ्ते का गर्भ', ...P.ANC)],
  ['PNC', M('pnc', 'पीएनसी', 'पी एन सी', 'postnatal', 'post natal', 'postpartum', 'prasav ke baad', 'प्रसव के बाद', 'delivery ke baad', 'डिलीवरी के बाद', 'ಹೆರಿಗೆ ನಂತರ', 'प्रसूति', ...P.PNC)],
  ['HBNC', M('hbnc', 'एचबीएनसी', 'newborn', 'new born', 'navjat', 'नवजात', 'shishu', 'शिशु', 'ಶಿಶು', 'ನವಜಾತ', 'नवजात शिशु', ...P.HBNC)],
  ['IMM', M('tikakaran', 'टीकाकरण', 'immunis~', 'immuniz~', 'vaccination', 'ವ್ಯಾಕ್ಸಿನೇಷನ್', 'ಲಸಿಕಾ~', 'टीकाकरण दिवस', ...P.IMM)],
];

// Everyday answers to "which visit is it?" ("pet se hai", "delivery ho gayi", "bachche ka
// teeka"). Only read as a visit type when that was the question, so the same words inside
// a dictated note never change the visit type.
const TYPE_ANSWERS = [
  ['IMM', M('tika|टीका|teeka|टीके|tike|vaccine|vaccination|injection|इंजेक्शन', 'tikakaran|टीकाकरण')],
  ['PNC', M('delivery|डिलीवरी|prasav|प्रसव|jachcha|जच्चा|jachgi|जचगी', 'bachcha|बच्चा|baby|बेबी|beta|बेटा|beti|बेटी hua|हुआ|hui|हुई', 'after delivery')],
  ['ANC', M('pet|पेट se|से', 'pregnant|प्रेग्नेंट', 'garbh~|गर्भ~', 'ummeed|उम्मीद se|से', 'bachcha|बच्चा hone|होने')],
  ['HBNC', M('naya|नया|chhota|छोटा|छोटे|chhote bachcha|बच्चा|बच्चे|baby|बेबी', 'newborn', 'navjat~|नवजात~', 'shishu|शिशु')],
];
// "the first one" etc., in the order the question lists them
const TYPE_ORDER = ['ANC', 'PNC', 'HBNC', 'IMM'];
const FOURTH = K('chautha', 'chauthi', 'चौथा', 'चौथी', 'fourth', '4th', 'ನಾಲ್ಕನೇ');

const VACCINES = [
  ['Td', M('tt', 'टीटी', 'टी टी', 'td', 'टीडी', 'tetanus', 'टिटनेस', 'टेटनस', 'ಟಿಟಿ', 'tt injection', ...P.vaccines.Td)],
  ['BCG', M('bcg', 'बीसीजी', 'बी सी जी', 'ಬಿಸಿಜಿ', ...P.vaccines.BCG)],
  ['OPV', M('opv', 'ओपीवी', 'polio', 'पोलियो', 'ಪೋಲಿಯೊ', 'ಪೋಲಿಯೋ', ...P.vaccines.OPV)],
  ['Penta', M('penta~', 'पेंटा~', 'पेन्टा~', 'ಪೆಂಟಾ~', ...P.vaccines.Penta)],
  ['RVV', M('rota~', 'रोटा~', 'rvv', 'ರೋಟಾ~', ...P.vaccines.RVV)],
  ['PCV', M('pcv', 'पीसीवी', 'pneumo~', 'न्यूमो~', 'ನ್ಯುಮೋ~')],
  ['fIPV', M('ipv', 'fipv', 'आईपीवी', 'एफआईपीवी')],
  ['MR', M('mr', 'एमआर', 'एम आर', 'measles', 'खसरा', 'khasra', 'मीजल्स', 'ಎಂಆರ್', ...P.vaccines.MR)],
  ['JE', M('je', 'जेई', 'japanese encephalitis', 'जापानी')],
  ['VitA', M('vitamin|विटामिन|ವಿಟಮಿನ್ a|ए|ಎ')],
  ['HepB', M('hepatitis~', 'हेपेटाइटिस~', 'hep b', 'ಹೆಪಟೈಟಿಸ್~')],
  ['DPT', M('dpt', 'डीपीटी', 'ಡಿಪಿಟಿ')],
];
const DOSE_WORDS = [
  [1, K('pehla', 'pahla', 'pehli', 'pahli', 'first', '1st', 'पहला', 'पहली', 'पहले', 'ಮೊದಲ', 'ಮೊದಲನೇ', 'modala', ...W.dose1)],
  [2, K('doosra', 'dusra', 'doosri', 'dusri', 'second', '2nd', 'दूसरा', 'दूसरी', 'दूसरे', 'ಎರಡನೇ', 'eradane', ...W.dose2)],
  [3, K('teesra', 'tisra', 'teesri', 'third', '3rd', 'तीसरा', 'तीसरी', 'ಮೂರನೇ', ...W.dose3)],
  ['B', K('booster', 'बूस्टर', 'ಬೂಸ್ಟರ್', ...W.booster)],
];
const GIVEN_W = K('laga', 'lagaya', 'lagai', 'lagaye', 'lagi', 'lage', 'lag', 'diya', 'di', 'diye', 'dila', 'dilaya', 'given', 'done', 'received', 'completed', 'administered', 'gave', 'लगा', 'लगाया', 'लगाई', 'लगी', 'लगे', 'दिया', 'दी', 'दिए', 'दिलाया', 'ಹಾಕಿದೆ', 'ಹಾಕಲಾಗಿದೆ', 'ಕೊಟ್ಟಿದೆ', 'haakide', 'hua', 'हुआ', 'pilaya', 'पिलाया', 'pilayi', 'पिलाई', ...W.given);
const DUE_W = K('lagana', 'lagwana', 'lagna', 'lagega', 'lagegi', 'lagenge', 'dena', 'dilana', 'due', 'baaki', 'baki', 'pending', 'next', 'agla', 'agli', 'agle', 'remaining', 'लगाना', 'लगवाना', 'लगना', 'लगेगा', 'लगेगी', 'लगेंगे', 'देना', 'बाकी', 'बाक़ी', 'अगला', 'अगली', 'अगले', 'ड्यू', 'ಬಾಕಿ', 'ಹಾಕಬೇಕು', 'baaki hai', 'karana', 'करवाना', ...W.due);
const IFA_KW = M('ifa', 'आईएफए', 'आई एफ ए', 'iron', 'आयरन', 'ಐಎಫ್ಎ', 'folic');

const NEXT_VISIT_KW = M(
  'agli|agla|agle|next|अगली|अगला|अगले|ಮುಂದಿನ visit|विज़िट|विजिट|mulakat|मुलाकात|bhent|भेंट|checkup|चेकअप|जांच|jaanch|ಭೇಟಿ|aana|आना|date|तारीख',
  'follow up|फॉलो अप|followup', 'phir|फिर aana|आना|aaungi|आऊंगी|aaenge|आएंगे', 'next visit', 'ಮುಂದಿನ ಭೇಟಿ',
  ...P.nextVisit,
);

// ---------- intents ----------
const YES = K('haan', 'han', 'ha', 'haa', 'hanji', 'haanji', 'ji', 'jee', 'sahi', 'theek', 'thik', 'thick', 'correct', 'right', 'yes', 'yeah', 'yep', 'ok', 'okay', 'okey', 'bilkul', 'हाँ', 'हां', 'हा', 'जी', 'सही', 'ठीक', 'बिल्कुल', 'ಹೌದು', 'howdu', 'houdu', 'sari', 'ಸರಿ', 'confirm', 'confirmed', 'save', 'सेव', 'wahi', 'vahi', 'वही', 'वोही', 'yahi', 'यही', 'बिलकुल', 'bilkul', 'chalega', 'चलेगा', 'same', ...W.yes);
const NO = K('nahi', 'nahin', 'nhi', 'na', 'no', 'galat', 'ghalat', 'wrong', 'नहीं', 'नही', 'ना', 'गलत', 'ग़लत', 'ಇಲ್ಲ', 'illa', 'tappu', 'ತಪ್ಪು', 'incorrect', 'nope', ...W.no);
// polite verb endings and address words carry no meaning of their own ("save kar dijiye
// please", "wahi rakh do didi")
const FILLER = K('hai', 'है', 'ji', 'jee', 'जी', 'sab', 'सब', 'bilkul', 'बिल्कुल', 'ekdum', 'एकदम', 'aur', 'और', 'ho', 'हो', 'raha', 'gaya', 'ide', 'ಇದೆ', 'it', 'is', 'all', 'that', 's', 'everything', 'वो', 'wo', 'yah', 'यह', 'ye', 'ये', 'to', 'तो', 'please', 'kar', 'karo', 'do', 'दो', 'कर', 'करो', 'हैं',
  'दीजिए', 'दीजिये', 'dijiye', 'dijie', 'कीजिए', 'कीजिये', 'kijiye', 'करिए', 'kariye', 'करें', 'करे', 'kare', 'प्लीज़', 'प्लीज', 'plz', 'रख', 'rakh', 'रखो', 'rakho', 'रखिए', 'rakhiye', 'दें', 'वाली', 'wali', 'वाला', 'wala', 'दीदी', 'didi', 'मैडम', 'madam', 'कुछ', 'kuch', 'लीजिए', 'लीजिये', 'lijiye', 'चलिए', 'chaliye', 'चलो', 'आगे', 'aage', 'बढ़िए', 'बढ़ो', 'badho', ...W.filler);
const DONE = M('bas', 'बस', 'khatam', 'ख़त्म', 'खत्म', 'save karo', 'save kar', 'सेव करो', 'सेव कर', 'that is all', "that's all", 'thats all', 'done', 'finish~', 'ಮುಗಿ~', 'ಸಾಕು', 'saaku', 'itna hi', 'इतना ही', 'bas itna', 'notes complete', 'complete', ...P.done);
const DONE_HOGAYA = M('ho gaya|हो गया|hogaya|ho gya', ...P.doneEnd);
const REPEAT = M('phir se|फिर se|dobara|दोबारा|repeat|again', 'फिर से', 'kya bola|क्या बोला', 'ಮತ್ತೆ|matte', 'once more', 'sunao|सुनाओ', 'padh~ ke sunao', 'read back', 'readback', ...P.repeat);
const NEW_VISIT = M('naya|नया|nayi|नई|new visit|विज़िट|विजिट|entry|form', 'agla|अगला ghar|घर', 'next house', 'ಹೊಸ ಭೇಟಿ', ...P.newVisit);
// Talking to the assistant rather than giving a value: a greeting, "shuru karo", "kya bolna hai"
const GREET = M('namaste|नमस्ते|namaskar|नमस्कार|hello|हेलो|हैलो|pranam|प्रणाम', 'ram ram|राम राम', 'ನಮಸ್ಕಾರ', 'good morning');
const START = M('shuru|शुरू', 'start', 'chalo|चलो', 'ready', 'ಶುರು', 'ಪ್ರಾರಂಭ~');
const HELP = M('madad|मदद', 'help', 'kya|क्या bolna|बोलना|bolu|बोलूं|बोलूँ|batana|बताना|batau|बताऊं|बताऊँ', 'what do i say', 'what should i say', 'how does this work', 'ಸಹಾಯ', 'ಏನು ಹೇಳ~');
// "pata nahi" / "don't know"
const UNKNOWN = M('pata|पता|maloom|मालूम|malum nahi|नहीं|nahin|na', 'not known', 'not sure', 'dont know', "don't know", 'do not know', 'ಗೊತ್ತಿಲ್ಲ', 'gottilla', 'माहीत नाही', 'தெரியாது', 'తెలియదు', 'জানি না', 'ખબર નથી', 'അറിയില്ല', 'ਪਤਾ ਨਹੀਂ');
// the weight was not measured at this visit
const SKIP_WEIGHT = M(
  'nahi|नहीं|nahin liya|लिया|li|ली|kiya|किया|hua|हुआ|naapa|नापा|dekha|देखा|liye', 'machine|मशीन|kanta|कांटा|कांटा nahi|नहीं|kharab|खराब',
  'baad|बाद mein|में', 'skip', 'not taken', 'not weighed', 'did not weigh', 'no machine', 'later',
  'ನೋಡಿಲ್ಲ', 'ಮಾಡಿಲ್ಲ', 'घेतलं|घेतले नाही', 'பார்க்கவில்லை', 'చూడలేదు', 'নেওয়া হয়নি', 'নেওয়া|নেয়া হয়নি', 'નથી લીધું', 'નથી લીધો', 'നോക്കിയില്ല', 'ਨਹੀਂ ਲਿਆ',
);
const FOLLOWUPS = M('follow|फॉलो up|अप list|लिस्ट', 'aaj|आज ki|की list|लिस्ट', 'kaam|काम ki|की list|लिस्ट', 'due list', 'followup list', 'ಪಟ್ಟಿ', ...P.followups);
const VACCINE_LIST = M(
  'tika|tike|teeka|teeke|टीका|टीके|टीकों|vaccine|vaccines|vaccination|ಲಸಿಕೆ list|लिस्ट|suchi|सूची|ಪಟ್ಟಿ',
  'tika|tike|teeka|teeke|टीका|टीके|टीकों|vaccine|ಲಸಿಕೆ ki|की|ka|का|ke|के|ದ list|लिस्ट|suchi|सूची',
  'teekakaran|tikakaran|टीकाकरण list|लिस्ट|suchi|सूची', 'immunisation|immunization list', ...P.vaccineList,
);
// "chhodo" alone may mean "skip this question"; with the visit named it discards the visit
const CANCEL = M('cancel', 'रद्द', 'radd', 'visit|विज़िट|विजिट|sab|सब|ise|इसे chhodo|छोड़ो|chhod|छोड़', 'discard', ...P.cancel);
const MED = K('dawa', 'dawai', 'dava', 'davai', 'दवा', 'दवाई', 'medicine', 'medicines', 'tablet', 'tablets', 'goli', 'goliyan', 'गोली', 'गोलियां', 'injection', 'इंजेक्शन', 'dose', 'dosage', 'खुराक', 'khurak', 'ilaj', 'ilaaj', 'इलाज', 'treatment', 'upchar', 'उपचार', 'ಔಷಧಿ', 'ಮಾತ್ರೆ', 'syrup', 'सिरप', 'antibiotic', 'paracetamol', 'crocin', 'ಚಿಕಿತ್ಸೆ', ...W.med);
const QWORD = K('kya', 'क्या', 'kitni', 'कितनी', 'kitna', 'कितना', 'kaun', 'kaunsi', 'kaunsa', 'कौन', 'कौनसी', 'कौनसा', 'kaise', 'कैसे', 'what', 'which', 'how', 'should', 'shall', 'chahiye', 'चाहिए', 'ಏನು', 'ಯಾವ', 'ಎಷ್ಟು', '?', 'batao', 'बताओ', 'bataiye', 'बताइए', 'suggest', 'ಹೇಳಿ', ...W.qword);
const PAST = K('di', 'diya', 'de', 'diye', 'dee', 'dili', 'laga', 'lagaya', 'lagi', 'given', 'gave', 'दी', 'दिया', 'दिए', 'लगा', 'लगाया', 'लगी', 'ಕೊಟ್ಟಿದೆ', 'ಕೊಟ್ಟೆ', ...W.past);
const WHAT_TO_DO = M('kya|क्या karna|करना|karu|करूं|करूँ|karein|करें|kare|करे', 'what should i do', 'what to do', 'ಏನು ಮಾಡ~', ...P.whatToDo);
const NAME_KW = K('naam', 'नाम', 'name', 'ಹೆಸರು', 'hesaru', ...W.name);
const NAME_STOP = K('hai', 'है', 'ka', 'ki', 'ke', 'का', 'की', 'के', 'aur', 'और', 'and', 'id', 'umar', 'age', 'ward', 'gaon', 'is', 'nahi', 'नहीं', 'ಇದೆ', 'ಅವರ', 'वजन', 'weight', 'wajan', 'vajan', 'pata', 'पता', 'maloom', 'मालूम', 'ji', 'जी', 'ghar', 'घर', 'yahan', 'यहाँ', 'यहां', ...W.nameStop);
// a bare answer to "whose visit?" is the name itself; these are not part of it
const NAME_FILL = K('hai', 'है', 'ji', 'जी', 'unka', 'उनका', 'uska', 'उसका', 'iska', 'इसका', 'didi', 'दीदी', 'bhabhi', 'भाभी', 'behen', 'बहन', 'wali', 'वाली', 'ki', 'की', 'ka', 'का', 'ke', 'के', 'naam', 'नाम', 'nai', 'नई', 'nayi', 'mahila', 'महिला', 'aurat', 'औरत');
const VISIT_WORD = K('visit', 'विज़िट', 'विजिट', 'vizit', 'ghar', 'घर', 'bhent', 'भेंट', 'ಭೇಟಿ');
const DATE_MENTION = K('tarikh', 'tareekh', 'date', 'तारीख', 'तारीख़', 'ತಾರೀಖು', 'ದಿನಾಂಕ');
const WARD_KW = K('ward', 'वार्ड', 'ವಾರ್ಡ್', ...W.ward);
const VACCINE_WORD = K('teeka', 'tika', 'teeke', 'tike', 'टीका', 'टीके', 'vaccine', 'vaccines', 'ಲಸಿಕೆ', 'lasike', ...W.vaccine);
const NONE_W = M('koi|कोई nahi|नहीं|bhi', 'kuch|कुछ nahi|नहीं', 'none', 'nothing', 'no vaccine~', 'ಯಾವುದೂ|ಏನೂ ಇಲ್ಲ|illa', 'nil',
  // "sab lag gaye" / "saare teeke ho chuke": everything due has been given
  'sab|सब|sare|saare|सारे|sabhi|सभी lag|लग|ho|हो gaye|गए|गये|gae|chuke|चुके', 'sab|सब|sare|saare|सारे|sabhi|सभी pure|पूरे|poore|complete', 'sab|सब|sare|सारे|sabhi|सभी laga|लगा|lage|लगे|lagi|लगी hua|हुआ|hue|हुए|hui|हुई|chuke|चुके|gaye|गए', 'all given', 'all done', 'ಎಲ್ಲಾ ಹಾಕಿದೆ', ...P.none);

// "kamalaa devii" -> "Kamala Devi": romanised Hindi spells a final long vowel double
function displayName(words) {
  return words.map((w) => w.replace(/(aa|ii|uu)$/, (v) => v[0])).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

function nearestNumber(tokens, from, to, pred = () => true) {
  for (let i = Math.max(0, from); i < Math.min(tokens.length, to); i++) {
    const r = parseNumberAt(tokens, i);
    if (r && pred(r)) return { ...r, start: i };
  }
  return null;
}

function inRange(i, ranges) {
  return ranges.some(([a, b]) => i >= a && i < b);
}

// tokens -> weight in kg (or null). Handles "2 kilo 800 gram", "2800 gram", "dhai kilo".
function weightAt(tokens, num) {
  let kg = null;
  let end = num.end;
  const unit = tokens[num.end];
  if (unit && KG.has(unit)) {
    kg = num.value;
    end = num.end + 1;
    const g = parseNumberAt(tokens, end);
    if (g && tokens[g.end] && GRAM.has(tokens[g.end]) && g.value < 1000) { kg += g.value / 1000; end = g.end + 1; }
  } else if (unit && GRAM.has(unit)) {
    kg = num.value / 1000;
    end = num.end + 1;
  } else {
    kg = num.value >= 500 ? num.value / 1000 : num.value;
  }
  if (kg <= 0 || kg > 150) return null;
  return { kg: Math.round(kg * 1000) / 1000, end };
}

// Prisma sometimes writes regional speech in Devanagari or Latin ("रक्तपात হচ্ছে", "aagli visit").
// While the worker speaks a regional language, her language's words may match those tokens too;
// in Hindi or English the script lock stays, so "पानी" never reads as Malayalam "പനി" (fever).
const LANG_SCRIPT = { kn: 'knda', ta: 'taml', te: 'telu', bn: 'beng', gu: 'gujr', ml: 'mlym', pa: 'guru' };
function inLanguage(tokens, lang) {
  const sc = LANG_SCRIPT[lang];
  if (!sc) return tokens;
  return tokens.map((t) => (t.script === 'latn' || t.script === 'deva' ? { ...t, script: sc } : t));
}

export function extract(text, ctx = {}) {
  const now = ctx.now || new Date();
  const registry = ctx.registry || [];
  const tokens = inLanguage(tokenize(text), ctx.lang);
  const fields = {};
  const used = []; // token ranges consumed by a field, so bare numbers aren't reused

  // --- beneficiary name / ID ---
  // tokens that are a person's name: never read as a danger sign ("Kamla" is also a word
  // for jaundice)
  const nameRanges = [];
  const names = findNames(tokens, registry);
  if (names.length) {
    fields.beneficiaryMatches = names.map((h) => h.b);
    names.forEach((h) => { used.push([h.start, h.end]); nameRanges.push([h.start, h.end]); });
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!ID_KW.has(tokens[i])) continue;
    // "ID number 1042" / "ID hai 1042" / "beneficiary ID ek shunya chaar do"
    for (let j = i + 1; j <= i + 3 && j < tokens.length; j++) {
      const r = parseNumberAt(tokens, j);
      if (r && r.digitString && r.digitString.length >= 3) {
        fields.beneficiaryId = r.digitString;
        used.push([i, r.end]);
        break;
      }
      // said in pairs, as people read numbers out: "das bayalis" = 10 42 = 1042
      const r2 = r && r.digitString && r.digitString.length === 2 ? parseNumberAt(tokens, r.end) : null;
      if (r2 && r2.digitString && r2.digitString.length <= 2) {
        fields.beneficiaryId = r.digitString + r2.digitString.padStart(2, '0');
        used.push([i, r2.end]);
        break;
      }
      if (r && !ID_KW.has(tokens[j])) break;
    }
    if (fields.beneficiaryId) break;
  }
  if (!fields.beneficiaryId) {
    for (const n of findNumbers(tokens)) {
      if (inRange(n.start, used)) continue;
      if (n.digitString && registry.some((b) => b.id === n.digitString)) {
        const unit = tokens[n.end];
        if (unit && (KG.has(unit) || GRAM.has(unit))) continue;
        fields.beneficiaryId = n.digitString;
        used.push([n.start, n.end]);
        break;
      }
    }
  }
  if (!fields.beneficiaryId) {
    // a register ID read out in pairs without the word "ID" ("das bayalis")
    const nums = findNumbers(tokens);
    for (let k = 0; k + 1 < nums.length; k++) {
      const a = nums[k];
      const b = nums[k + 1];
      if (b.start !== a.end || !a.digitString || !b.digitString || inRange(a.start, used)) continue;
      const id = a.digitString + b.digitString.padStart(2, '0');
      if (registry.some((p) => p.id === id)) { fields.beneficiaryId = id; used.push([a.start, b.end]); break; }
    }
  }
  // raw name ("naam Sunaina hai") for people not in the register
  for (let i = 0; i < tokens.length; i++) {
    if (!NAME_KW.has(tokens[i])) continue;
    const parts = [];
    for (let j = i + 1; j < tokens.length && parts.length < 3; j++) {
      if (NAME_STOP.has(tokens[j]) || tokens[j].isDigits || parseNumberAt(tokens, j)) break;
      parts.push(tokens[j].rom);
    }
    if (parts.length) {
      fields.rawName = displayName(parts);
      used.push([i, i + 1 + parts.length]);
      nameRanges.push([i + 1, i + 1 + parts.length]);
    }
    break;
  }
  // ward ("ward 3 wali") helps pick between two people with the same name
  for (let i = 0; i < tokens.length; i++) {
    if (WARD_KW.has(tokens[i])) {
      const r = parseNumberAt(tokens, i + 1);
      if (r) { fields.ward = r.value; used.push([i, r.end]); }
    }
  }

  // --- visit type ---
  for (const [type, m] of VISIT_TYPES) {
    if (m.test(tokens)) { fields.visitType = type; break; }
  }
  if (!fields.visitType && ctx.expect === 'visitType') {
    for (const [type, m] of TYPE_ANSWERS) {
      if (m.test(tokens)) { fields.visitType = type; break; }
    }
    if (!fields.visitType) {
      for (const [d, ws] of [...DOSE_WORDS, [4, FOURTH]]) {
        if (typeof d === 'number' && tokens.some((t) => ws.has(t))) { fields.visitType = TYPE_ORDER[d - 1]; break; }
      }
    }
  }

  // --- next visit date (before other numbers so "3 December" isn't read as a weight) ---
  {
    const kw = NEXT_VISIT_KW.findAll(tokens)[0];
    let d = null;
    if (kw) d = findDate(tokens, now, kw.start, Math.min(tokens.length, kw.end + 8));
    if (!d && ctx.expect === 'nextVisit') d = findDate(tokens, now);
    if (!d) {
      const any = findDate(tokens, now);
      // without a keyword, only accept unambiguous future dates, not "kal" (could be "since yesterday")
      if (any && !(any.end - any.start === 1 && !tokens[any.start].isDigits && !/\//.test(tokens[any.start].rom))) d = any;
      else if (any && tokens[any.start].isDigits) d = any;
    }
    if (d && d.date >= new Date(now.getFullYear(), now.getMonth(), now.getDate())) {
      fields.nextVisit = iso(d.date);
      used.push([d.start, d.end]);
    }
  }

  // --- vitals ---
  for (const hit of BP_KW.findAll(tokens)) {
    for (let j = hit.end; j < Math.min(tokens.length, hit.end + 4); j++) {
      const t = tokens[j];
      if (t.isDigits && /^\d{2,3}\/\d{2,3}$/.test(t.rom)) {
        const [s, d] = t.rom.split('/').map(Number);
        fields.bp = { sys: s, dia: d };
        used.push([hit.start, j + 1]);
        break;
      }
      const a = parseNumberAt(tokens, j);
      if (a && a.value >= 60 && a.value <= 260) {
        let k = a.end;
        if (tokens[k] && BP_SEP.has(tokens[k])) k++;
        const b = parseNumberAt(tokens, k);
        if (b && b.value >= 30 && b.value <= 160) {
          fields.bp = { sys: a.value, dia: b.value };
          used.push([hit.start, b.end]);
        }
        break;
      }
    }
  }
  for (const hit of HB_KW.findAll(tokens)) {
    const n = nearestNumber(tokens, hit.end, hit.end + 4, (r) => r.value > 2 && r.value < 20);
    if (n) { fields.hb = n.value; used.push([hit.start, n.end]); }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!TEMP_KW.has(tokens[i])) continue;
    const n = nearestNumber(tokens, i + 1, i + 5, (r) => (r.value >= 30 && r.value <= 43) || (r.value >= 90 && r.value <= 110));
    if (n) {
      const isF = n.value >= 90 || (tokens[n.end + 1] && FAHRENHEIT.has(tokens[n.end + 1])) || (tokens[n.end] && FAHRENHEIT.has(tokens[n.end]));
      fields.tempC = isF ? Math.round(((n.value - 32) * 5) / 9 * 10) / 10 : n.value;
      used.push([i, n.end]);
    }
  }
  for (let i = 0; i < tokens.length; i++) {
    if (!RESP_KW.has(tokens[i])) continue;
    const n = nearestNumber(tokens, i + 1, i + 5, (r) => r.value >= 15 && r.value <= 150);
    if (n) { fields.respRate = n.value; used.push([i, n.end]); }
  }

  // --- weight ---
  for (let i = 0; i < tokens.length && fields.weightKg === undefined; i++) {
    if (!WEIGHT_KW.has(tokens[i])) continue;
    // forward: "wajan 52 kilo", "weight hai do point aath"
    for (let j = i + 1; j <= i + 4 && j < tokens.length; j++) {
      if (inRange(j, used)) continue;
      let r = parseNumberAt(tokens, j);
      // "wajan bavan nahi, pachpan hai": the number after the "not" is the weight
      if (r && tokens[r.end] && NO.has(tokens[r.end])) r = parseNumberAt(tokens, r.end + 1) || r;
      if (r) {
        const w = weightAt(tokens, r);
        if (w) { fields.weightKg = w.kg; used.push([i, w.end]); }
        break;
      }
    }
    // backward: "52 kilo vajan"
    if (fields.weightKg === undefined) {
      for (let j = Math.max(0, i - 4); j < i; j++) {
        if (inRange(j, used)) continue;
        const r = parseNumberAt(tokens, j);
        if (r && r.end <= i + 1) {
          const w = weightAt(tokens, r);
          if (w) { fields.weightKg = w.kg; used.push([j, i + 1]); break; }
        }
      }
    }
  }
  if (fields.weightKg === undefined) {
    for (const n of findNumbers(tokens)) {
      if (inRange(n.start, used)) continue;
      const unit = tokens[n.end];
      if (unit && (KG.has(unit) || GRAM.has(unit))) {
        const w = weightAt(tokens, n);
        if (w) { fields.weightKg = w.kg; used.push([n.start, w.end]); break; }
      }
    }
  }

  // --- gestational age / baby age ---
  const hasBaby = tokens.some((t) => BABY_CTX.has(t));
  for (const n of findNumbers(tokens)) {
    if (inRange(n.start, used)) continue;
    const u = tokens[n.end];
    const nx = tokens[n.end + 1];
    if (!u) continue;
    if (nx && AFTER_W.has(nx)) continue; // "do hafte baad" is a date, not an age
    if (MONTH_W.has(u) && n.value <= 10 && nx && PREG_CTX.has(nx) && !hasBaby) {
      fields.gestWeeks = Math.round(n.value * 4.345);
      used.push([n.start, n.end + 1]);
    } else if (WEEK_W.has(u) && n.value <= 42 && !hasBaby && (fields.visitType === 'ANC' || (nx && PREG_CTX.has(nx)))) {
      fields.gestWeeks = n.value;
      used.push([n.start, n.end + 1]);
    } else if (hasBaby && (DAY_W.has(u) || WEEK_W.has(u) || MONTH_W.has(u))) {
      fields.babyAgeDays = DAY_W.has(u) ? n.value : WEEK_W.has(u) ? n.value * 7 : Math.round(n.value * 30.4);
      used.push([n.start, n.end + 1]);
    }
  }

  // --- vaccines ---
  const vaccines = [];
  for (const [base, m] of VACCINES) {
    for (const hit of m.findAll(tokens)) {
      if (vaccines.some((v) => v.start < hit.end && hit.start < v.end)) continue;
      let dose = null;
      for (let j = Math.max(0, hit.start - 2); j < Math.min(tokens.length, hit.end + 3); j++) {
        if (j >= hit.start && j < hit.end) continue;
        for (const [d, ws] of DOSE_WORDS) if (ws.has(tokens[j])) dose = d;
        if (dose === null && j >= hit.end && j <= hit.end + 1) {
          const r = parseNumberAt(tokens, j);
          if (r && r.value >= 0 && r.value <= 3 && Number.isInteger(r.value) && r.end === j + 1) dose = r.value;
        }
        if (dose !== null) break;
      }
      // status: nearest given/due word within the clause
      let status = null;
      let best = 99;
      for (let j = Math.max(0, hit.start - 3); j < Math.min(tokens.length, hit.end + 5); j++) {
        const dist = Math.abs(j - hit.end);
        if (DUE_W.has(tokens[j]) && dist < best) { status = 'due'; best = dist; }
        if (GIVEN_W.has(tokens[j]) && dist < best) { status = 'given'; best = dist; }
      }
      vaccines.push({ base, dose, status: status || 'mentioned', start: hit.start, end: hit.end });
      used.push([hit.start, hit.end + 1]);
    }
  }
  if (vaccines.length) fields.vaccines = vaccines.map(({ base, dose, status }) => ({ base, dose, status }));

  // IFA tablets given (recorded, not advised)
  for (const hit of IFA_KW.findAll(tokens)) {
    const n = nearestNumber(tokens, Math.max(0, hit.start - 3), hit.end + 4, (r) => r.value >= 1 && r.value <= 400 && Number.isInteger(r.value));
    fields.ifaGiven = n ? n.value : true;
    if (n) used.push([n.start, n.end]);
  }

  // --- danger signs ---
  const blankNames = (ranges) => tokens.map((t, i) => (inRange(i, ranges) ? { ...t, key: '', rom: '' } : t));
  let dangers = detectDangerSigns(nameRanges.length ? blankNames(nameRanges) : tokens);

  // --- intents ---
  const content = tokens.filter((t) => !FILLER.has(t));
  const intent = {};
  const short = content.length <= 4;
  if (short && content.some((t) => YES.has(t)) && !content.some((t) => NO.has(t))) intent.yes = true;
  // Marathi "हो" (yes) is also the Hindi filler "हो", so it counts only when said alone
  if (tokens.length === 1 && tokens[0].key === 'ho' && tokens[0].script === 'deva') intent.yes = true;
  if (tokens.length && (NO.has(tokens[0]) || (short && content.some((t) => NO.has(t))))) intent.no = true;
  if (DONE.test(tokens)) intent.done = true;
  {
    const hg = DONE_HOGAYA.findAll(tokens);
    const last = hg[hg.length - 1];
    if (last && last.end >= tokens.length - 1 && !vaccines.some((v) => Math.abs(v.end - last.start) <= 3)) intent.done = true;
  }
  if (REPEAT.test(tokens)) intent.repeat = true;
  if (NEW_VISIT.test(tokens)) intent.newVisit = true;
  if (FOLLOWUPS.test(tokens)) intent.followups = true;
  if (VACCINE_LIST.test(tokens)) intent.vaccineList = true;
  if (CANCEL.test(tokens)) intent.cancel = true;
  if (NONE_W.test(tokens)) intent.none = true;
  if (UNKNOWN.test(tokens)) intent.unknown = true;
  if (SKIP_WEIGHT.test(tokens)) intent.skip = true;
  if (GREET.test(tokens)) intent.greet = true;
  if (START.test(tokens)) intent.start = true;
  if (HELP.test(tokens)) intent.help = true;
  const hasMed = tokens.some((t) => MED.has(t));
  const hasQ = tokens.some((t) => QWORD.has(t)) || /\?/.test(text);
  const hasPast = tokens.some((t) => PAST.has(t));
  if ((hasMed && hasQ && !(hasPast && !tokens.some((t) => t.key === 'kya' || t.key === 'kitni' || t.key === 'kitna'))) || WHAT_TO_DO.test(tokens)) {
    intent.advice = true;
  }

  // A short answer to "whose visit?" that is not in the register is the name itself
  // ("Kamla", "Kamla Devi hai"), as long as it says nothing else: no value, no sign, no
  // command ("nayi visit"), no keyword.
  if (ctx.expect === 'beneficiary' && !Object.keys(fields).length && !Object.keys(intent).length && !dangers.present.length && !dangers.absent.length) {
    const parts = tokens.map((t, i) => [t, i]).filter(([t]) => !NAME_FILL.has(t));
    const plain = parts.length && parts.length <= 3 && parts.every(([t, i]) => !t.isDigits && !parseNumberAt(tokens, i) && !NAME_STOP.has(t) && !NAME_KW.has(t)
      && !WEIGHT_KW.has(t) && !VACCINE_WORD.has(t) && !ID_KW.has(t) && !MED.has(t) && !QWORD.has(t));
    if (plain && !VISIT_WORD.has(tokens[tokens.length - 1])) {
      fields.rawName = displayName(parts.map(([t]) => t.rom));
      nameRanges.push(...parts.map(([, i]) => [i, i + 1]));
      dangers = detectDangerSigns(blankNames(nameRanges));
    }
  }

  // numbers not tied to any field - used for corrections ("nahi, 2.8")
  const bare = findNumbers(tokens).filter((n) => !inRange(n.start, used)).map((n) => {
    const unit = tokens[n.end];
    return { value: n.value, digitString: n.digitString, unit: unit && KG.has(unit) ? 'kg' : unit && GRAM.has(unit) ? 'g' : null };
  });
  const anyDate = findDate(tokens, now);

  // fields named without a value ("weight galat hai") - tells the agent what a bare number fixes
  const mentions = [];
  if (fields.weightKg === undefined && tokens.some((t) => WEIGHT_KW.has(t))) mentions.push('weightKg');
  if (!fields.beneficiaryId && tokens.some((t) => ID_KW.has(t))) mentions.push('beneficiaryId');
  if (!fields.nextVisit && (NEXT_VISIT_KW.test(tokens) || tokens.some((t) => DATE_MENTION.has(t)))) mentions.push('nextVisit');
  if (!fields.rawName && !fields.beneficiaryMatches && tokens.some((t) => NAME_KW.has(t))) mentions.push('name');
  if (!fields.vaccines && tokens.some((t) => VACCINE_WORD.has(t))) mentions.push('vaccinesDue');

  const hasFields = Object.keys(fields).length > 0;
  return {
    tokens,
    fields,
    dangers,
    intent,
    bareNumbers: bare,
    anyDate: anyDate ? iso(anyDate.date) : null,
    mentions,
    empty: !hasFields && !dangers.present.length && !dangers.absent.length && !Object.keys(intent).length,
  };
}
