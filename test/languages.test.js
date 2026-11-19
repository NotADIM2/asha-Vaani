import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry } from '../public/js/nlu/registry.js';
import { LANGS, YES_WORD, t } from '../public/js/i18n.js';
import { tokenize } from '../public/js/nlu/translit.js';
import { detectDangerSigns } from '../public/js/nlu/danger.js';
import { findDate, iso } from '../public/js/nlu/dates.js';
import { stripEcho, isBargeIn } from '../public/js/echo.js';
import { parseNumberAt } from '../public/js/nlu/numbers.js';

const NOW = new Date(2026, 10, 19);
const registry = buildRegistry(NOW);
const mk = (lang) => new VisitAgent({ lang, registry, now: () => NOW });
const signs = (text) => detectDangerSigns(tokenize(text));

// One complete visit per language, written the way Prisma returns it (digits, some English).
const VISITS = {
  mr: 'सुनीता देवी, आयडी 1042, गरोदर, वजन 52 किलो, पुढची भेट 3 डिसेंबर',
  ta: 'சுனிதா தேவி, ID 1042, கர்ப்பிணி, எடை 52 kg, அடுத்த வருகை December 3',
  te: 'సునీత దేవి, ఐడి 1042, గర్భిణి, బరువు 52 కిలోలు, తదుపరి సందర్శన డిసెంబర్ 3',
  bn: 'সুনীতা দেবী, আইডি 1042, গর্ভবতী, ওজন 52 কেজি, পরের ভিজিট 3 December',
  gu: 'સુનીતા દેવી, આઈડી 1042, સગર્ભા, વજન 52 કિલો, આગામી મુલાકાત 3 ડિસેમ્બર',
  ml: 'സുനിത ദേവി, ഐഡി 1042, ഗർഭിണി, തൂക്കം 52 കിലോ, അടുത്ത സന്ദർശനം ഡിസംബർ 3',
  pa: 'ਸੁਨੀਤਾ ਦੇਵੀ, ਆਈਡੀ 1042, ਗਰਭਵਤੀ, ਭਾਰ 52 ਕਿਲੋ, ਅਗਲੀ ਵਿਜ਼ਿਟ 3 ਦਸੰਬਰ',
};

test('all ten Prisma languages are offered', () => {
  assert.deepEqual(Object.keys(LANGS).sort(), ['bn', 'en', 'gu', 'hi', 'kn', 'ml', 'mr', 'pa', 'ta', 'te']);
});

test('every language has every template the agent uses', () => {
  const keys = Object.keys(t('hi'));
  for (const l of Object.keys(LANGS)) for (const k of keys) assert.ok(t(l)[k] !== undefined, `${l}.${k}`);
});

for (const [lang, text] of Object.entries(VISITS)) {
  test(`${lang}: dictate -> read back in ${lang} -> "${YES_WORD[lang]}" saves`, () => {
    const a = mk(lang);
    assert.match(a.greet().say[0], /[ऀ-ൿ]/, 'greets in its own script');
    const r1 = a.handle(text);
    assert.equal(r1.state, 'confirm');
    const said = r1.say.join(' ');
    assert.match(said, /52/, 'weight read back as digits for Timbre');
    assert.match(said, /1 0 4 2/, 'ID read digit by digit');
    assert.ok(said.includes(t(lang).readIntro), 'read-back is in the selected language');
    const r2 = a.handle(YES_WORD[lang]);
    assert.ok(r2.saved, 'saved on the local "yes"');
    assert.equal(r2.saved.beneficiaryId, '1042');
    assert.equal(r2.saved.weightKg, 52);
    assert.equal(r2.saved.nextVisit, '2026-12-03');
  });
}

test('danger alert is spoken in the worker\'s language', () => {
  const a = mk('ta');
  const r = a.handle('குழந்தைக்கு காய்ச்சல் இருக்கு, ஐடி 1060');
  assert.ok(a.form.dangers.includes('fever'));
  assert.match(r.say.join(' '), /காய்ச்சல்/);
  assert.match(r.say.join(' '), /பி ஹெச் சி/);
});

test('a regional word only matches its own script: Malayalam പനി (fever) vs Hindi पानी (water)', () => {
  assert.deepEqual(signs('പനി ഉണ്ട്').present, ['fever']);
  assert.deepEqual(signs('पानी पी रही है').present, []);
  assert.deepEqual(signs('പനിക്കുടം പൊട്ടി').present, ['water_leak']);
});

test('glued negatives: പനിയില്ല, ಜ್ವರವಿಲ್ಲ, జ్వరం రాలేదు, காய்ச்சல் வரவில்லை', () => {
  for (const s of ['പനിയില്ല', 'ಜ್ವರವಿಲ್ಲ', 'జ్వరం రాలేదు', 'காய்ச்சல் வரவில்லை']) {
    assert.deepEqual(signs(s).present, [], s);
    assert.deepEqual(signs(s).absent, ['fever'], s);
  }
  // a glued "not" that belongs to the sign itself
  assert.deepEqual(signs('ബോധമില്ല').present, ['lethargy']);
});

test('"not stopping" / "not going down" keeps the sign', () => {
  for (const s of ['रक्त थांबत नाही', 'இரத்தம் நிற்கவில்லை', 'రక్తం ఆగడం లేదు', 'রক্ত বন্ধ হচ্ছে না', 'ചോര നിൽക്കുന്നില്ല', 'ਖੂਨ ਰੁਕ ਨਹੀਂ ਰਿਹਾ']) {
    assert.ok(signs(s).present.includes('bleeding'), s);
  }
  assert.ok(signs('జ్వరం తగ్గలేదు').present.includes('fever'));
  assert.ok(signs('জ্বর কমছে না').present.includes('fever'));
});

test('a "not" in the next clause does not cancel the sign', () => {
  assert.deepEqual(signs('बुखार है, दूध नहीं पी रहा').present.sort(), ['fever', 'not_feeding']);
  assert.deepEqual(signs('குழந்தைக்கு காய்ச்சல் இருக்கு, பால் குடிக்கவில்லை').present.sort(), ['fever', 'not_feeding']);
  assert.deepEqual(signs('कोई बुखार नहीं').present, []);
});

test('look-alikes do not flag: blood test, blood pressure, blood shortage', () => {
  for (const s of ['இரத்த அழுத்தம் 120/80', 'రక్తపోటు 150/100', 'ਖੂਨ ਦੀ ਜਾਂਚ ਹੋ ਗਈ', 'લોહી ની તપાસ કરી', 'रक्त तपासणी झाली']) {
    assert.deepEqual(signs(s).present, [], s);
  }
});

test('relative dates in each language', () => {
  const d = (s) => iso(findDate(tokenize(s), NOW).date);
  assert.equal(d('10 दिवसांनी'), '2026-11-29');
  assert.equal(d('2 வாரத்தில்'), '2026-12-03');
  assert.equal(d('நாளை மறுநாள்'), '2026-11-21');
  assert.equal(d('10 రోజుల్లో'), '2026-11-29');
  assert.equal(d('10 দিন পরে'), '2026-11-29');
  assert.equal(d('પરમ દિવસે'), '2026-11-21');
  assert.equal(d('നാളെ'), '2026-11-20');
  assert.equal(d('ਅਗਲੇ ਹਫ਼ਤੇ'), '2026-11-26');
  // what Prisma actually returned for "10 दिवसांनी" spoken in Marathi
  assert.equal(d('पुढची भेट दहा दिवसांत दे.'), '2026-11-29');
});

test('spelled-out numbers in regional scripts, without colliding with Hindi words', () => {
  const v = (s) => parseNumberAt(tokenize(s), 0)?.value;
  assert.equal(v('இருபத்தி ஒன்று'), 21);
  assert.equal(v('యాభై రెండు'), 52);
  assert.equal(v('ਪੰਜਾਹ ਦੋ'), 52);
  assert.equal(v('നാല്'), 4);
  assert.equal(v('नाल'), undefined); // Hindi "umbilical cord", not Malayalam 4
});

test('Marathi "हो" alone is yes; Hindi "हो गया" is not a bare yes', () => {
  const a = mk('mr');
  a.handle(VISITS.mr);
  assert.ok(a.handle('हो').saved);
});

test('speaker echo of a Tamil read-back is dropped; a Tamil "no" over it is kept', () => {
  const said = 'படித்துக் காட்டுகிறேன். சுனிதா தேவி, ஐடி 1 0 4 2, எடை 52 கிலோ. எல்லாம் சரியா?';
  assert.equal(stripEcho('சுனிதா தேவி ID 1042 எடை 52 kg', [said], { playing: true }).echo, true);
  const r = stripEcho('எல்லாம் சரியா இல்லை எடை 54 கிலோ', [said], { playing: true });
  assert.equal(r.echo, false);
  assert.ok(isBargeIn(r.restUnits));
});
