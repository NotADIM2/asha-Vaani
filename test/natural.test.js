// Everyday answers, the way an ASHA actually replies, not dictated in form order. The agent
// asks one question at a time; each of these must be understood without "say it again".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry, findNames } from '../public/js/nlu/registry.js';
import { tokenize } from '../public/js/nlu/translit.js';
import { detectDangerSigns } from '../public/js/nlu/danger.js';
import { checkLine } from '../public/js/nlu/interpret.js';
import { t } from '../public/js/i18n.js';

const NOW = new Date(2026, 10, 21);
const registry = buildRegistry(NOW);
const mk = (lang = 'hi') => new VisitAgent({ lang, registry, now: () => NOW });
const NOT = t('hi').notUnderstood;

// an agent waiting on one question
const at = {
  weight: () => { const a = mk(); a.handle('सुनीता देवी आईडी 1042'); assert.equal(a.expect, 'weightKg'); return a; },
  vaccines: () => { const a = mk(); a.handle('नाम कमला है गर्भवती है वज़न पचपन किलो'); assert.equal(a.expect, 'vaccinesDue'); return a; },
  next: () => { const a = mk(); a.handle('सुनीता देवी 1042 वज़न 52 किलो'); assert.equal(a.expect, 'nextVisit'); return a; },
  type: () => { const a = mk(); a.handle('कमला'); assert.equal(a.expect, 'visitType'); return a; },
  confirm: () => { const a = mk(); a.handle('सुनीता देवी 1042 वज़न 52 किलो अगली विज़िट 3 दिसंबर'); assert.equal(a.state, 'confirm'); return a; },
};

test('the greeting asks a question instead of asking for a dictated note', () => {
  for (const l of ['hi', 'en', 'kn']) {
    assert.match(t(l).greet, /\?/);
    assert.ok(t(l).greet.endsWith(t(l).askBeneficiary.split('?').pop().trim()) || t(l).greet.includes('?'));
  }
  const a = mk();
  assert.equal(a.expect, 'beneficiary', 'a fresh visit is waiting for the name');
});

test('a bare name or a pair-read ID answers "whose home are you at?"', () => {
  for (const [said, id] of [['प्रिया शर्मा', '1051'], ['रेखा दीदी', '1083'], ['दस बयालीस', '1042'], ['आईडी दस बयालीस', '1042'], ['एक हज़ार बयालीस', '1042'], ['सुनीता देवी के यहाँ बैठी हूँ अभी', '1042']]) {
    const a = mk();
    a.handle(said);
    assert.equal(a.form.beneficiaryId, id, said);
  }
  const a = mk();
  a.handle('कमला देवी है');
  assert.equal(a.form.name, 'Kamala Devi');
  assert.deepEqual(a.form.dangers, [], 'the name Kamla is not jaundice');
});

test('which visit: everyday words and "the first one"', () => {
  for (const [said, type] of [['पेट से है', 'ANC'], ['डिलीवरी हो गई है', 'PNC'], ['बच्चा हुआ है', 'PNC'], ['अभी पिछले हफ्ते ही जचगी हुई है', 'PNC'], ['बच्चे का टीका', 'IMM'], ['पहली वाली', 'ANC'], ['pet se hai', 'ANC']]) {
    const a = at.type();
    a.handle(said);
    assert.equal(a.form.visitType, type, said);
  }
});

test('weight: approximate, corrected, and "not taken"', () => {
  for (const [said, kg] of [['करीब पचास', 50], ['साढ़े बावन किलो', 52.5], ['तौला तो पचास के ऊपर आया, इक्यावन समझो', 51], ['बावन किलो है जी', 52]]) {
    const a = at.weight();
    a.handle(said);
    assert.equal(a.form.weightKg, kg, said);
  }
  for (const said of ['वजन नहीं लिया', 'मशीन नहीं थी', 'आज मशीन खराब थी, तौल नहीं पाई']) {
    const a = at.weight();
    const r = a.handle(said);
    assert.equal(a.form.weightNotTaken, true, said);
    assert.equal(r.expect, 'nextVisit', `${said}: moves on`);
  }
  const a = at.confirm();
  const r = a.handle('वजन बावन नहीं पचपन है');
  assert.equal(a.form.weightKg, 55);
  assert.match(r.say.join(' '), /पचपन/);
});

test('a weight not taken is read back and saved as such, never as a number', () => {
  const a = at.weight();
  a.handle('वजन नहीं लिया');
  a.handle('हाँ');
  const r = a.handle('हाँ');
  assert.ok(r.saved);
  assert.equal(r.saved.weightKg, null);
  assert.equal(r.saved.weightNotTaken, true);
});

test('vaccines: "all given" is none due, "don\'t know" is recorded as not known', () => {
  for (const said of ['सब लग गए', 'सारे टीके लग गए हैं', 'सब टीके पूरे हैं', 'कार्ड में देखा तो सब लगा हुआ है', 'nahi koi nahi']) {
    const a = at.vaccines();
    a.handle(said);
    assert.equal(a.form.vaccinesDueNone, true, said);
    assert.equal(a.form.beneficiary, null, `${said}: the person is not changed`);
  }
  const a = at.vaccines();
  a.handle('पता नहीं');
  assert.equal(a.form.vaccinesDueUnknown, true);
  assert.equal(a.form.vaccinesDueNone, false);
  a.handle('हाँ');
  const rb = a.readback();
  assert.match(rb, /जानकारी नहीं/);
  assert.doesNotMatch(rb, /कोई टीका बाकी नहीं/);
});

test('next visit: relative dates and keeping the suggestion', () => {
  for (const [said, date] of [['अगले हफ्ते', '2026-11-28'], ['दस दिन बाद', '2026-12-01'], ['महीने भर बाद', '2026-12-21'], ['पखवाड़े भर बाद', '2026-12-05'], ['हफ्ते बाद', '2026-11-28'], ['after ten days', '2026-12-01'], ['पंद्रह तारीख को', '2026-12-15']]) {
    const a = at.next();
    a.handle(said);
    assert.equal(a.form.nextVisit, date, said);
  }
  for (const said of ['वही रखो', 'हाँ वही', 'हाँ जी ठीक है']) {
    const a = at.next();
    const r = a.handle(said);
    assert.equal(r.state, 'confirm', said);
  }
});

test('confirming in ordinary words saves; naming the wrong field asks for it', () => {
  for (const said of ['सेव कर दीजिए', 'हाँ ठीक है सेव कर दीजिए प्लीज़', 'हाँ हाँ बिलकुल यही रख लीजिए आगे चलिए', 'जी बिल्कुल सही है', 'ओके सेव', 'yes save it']) {
    const r = at.confirm().handle(said);
    assert.ok(r.saved, said);
  }
  assert.equal(at.confirm().handle('तारीख गलत है').expect, 'nextVisit');
  assert.equal(at.confirm().handle('no the weight is wrong').expect, 'weightKg', 'English "no" is not nine');
});

test('talking to the assistant gets how-to and the open question, not "say it again"', () => {
  for (const said of ['नमस्ते', 'चलो शुरू करते हैं', 'क्या बोलना है', 'मदद चाहिए']) {
    const a = mk();
    const r = a.handle(said);
    const say = r.say.join(' ');
    assert.ok(say.includes(t('hi').help), said);
    assert.ok(say.includes(t('hi').askBeneficiary), said);
    assert.equal(a.form.transcript.length, 0, `${said}: not part of the note`);
  }
  const r = mk().handle('नई विज़िट');
  assert.equal(r.reset, true, '"new visit" is a command, not a woman called Vizit');
});

test('anything not understood is asked again with an example answer', () => {
  const a = at.weight();
  const r = a.handle('अरे वो तो आज बाज़ार गई थी');
  assert.equal(r.unclear, true);
  const say = r.say.join(' ');
  assert.ok(!say.includes(NOT));
  assert.ok(say.includes(t('hi').askWeight) && say.includes(t('hi').hint.weightKg));
  assert.equal(a.form.transcript.length, 1, 'the unclear words are not added to the note');
  assert.equal(a.expect, 'weightKg');
  const c = at.confirm().handle('अरे वो तो आज बाज़ार गई थी');
  assert.ok(c.say.join(' ').includes(t('hi').hint.confirm));
});

test('every language has the example answers and the new read-back words', () => {
  for (const l of ['hi', 'en', 'kn', 'mr', 'ta', 'te', 'bn', 'gu', 'ml', 'pa']) {
    const L = t(l);
    for (const k of ['beneficiary', 'visitType', 'weightKg', 'vaccinesDue', 'nextVisit', 'confirm']) assert.ok(L.hint[k], `${l}.hint.${k}`);
    assert.ok(L.help && L.weightNotTaken && L.dueUnknown, l);
  }
});

test('everyday words are not names or danger signs', () => {
  for (const w of ['देखा', 'रखा', 'मिला', 'मीठा', 'सरिता', 'संगीता', 'सावित्री', 'दूसरा', 'कमला']) {
    const toks = tokenize(w);
    assert.deepEqual(findNames(toks, registry), [], `${w} is not a registered name`);
  }
  assert.deepEqual(detectDangerSigns(tokenize('टीडी दूसरा लगना है')).present, [], '"second" is not blurred vision');
  const a = at.vaccines();
  a.handle('टीडी दूसरा लगना है');
  assert.deepEqual(a.form.dangers, []);
  assert.ok(a.vaccinesDue().includes('Td-2'));
});

test('the language model reading is kept only where it matches what she said', () => {
  assert.equal(checkLine('weight 51 kilo', 'तौला तो इक्यावन आया'), 'weight 51 kilo');
  assert.equal(checkLine('weight 60 kilo', 'तौला तो इक्यावन आया'), '', 'a weight she did not say is dropped');
  assert.equal(checkLine('ID 1042', 'दस बयालीस वाली'), 'id 1042');
  assert.equal(checkLine('ID 1043', 'दस बयालीस वाली'), '', 'an ID she did not say is dropped');
  assert.equal(checkLine('name Kamla', 'कमला के घर'), 'name kamla');
  assert.equal(checkLine('name Sunita', 'कमला के घर'), '', 'a name she did not say is dropped');
  assert.equal(checkLine('PNC visit, next visit 5/12', 'जचगी हुई है, पखवाड़े बाद'), 'pnc visit, next visit 5/12');
  assert.equal(checkLine('give paracetamol', 'बुखार है'), '', 'free text is never passed on');
  assert.equal(checkLine(undefined, 'x'), '');
});
