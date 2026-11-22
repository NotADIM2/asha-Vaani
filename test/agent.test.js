import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry } from '../public/js/nlu/registry.js';

const NOW = new Date(2026, 10, 19);
const registry = buildRegistry(NOW);
const mk = (lang = 'hi') => new VisitAgent({ lang, registry, now: () => NOW });

test('greeting discloses AI in the first turn (all languages)', () => {
  assert.match(mk('hi').greet().say[0], /ए आई सहायक/);
  assert.match(mk('en').greet().say[0], /A I assistant/);
  assert.match(mk('kn').greet().say[0], /ಎ ಐ ಸಹಾಯಕ/);
});

test('full Hindi visit in one breath -> read-back -> save', () => {
  const a = mk();
  const r1 = a.handle('सुनीता देवी, आईडी 1042, ए एन सी विज़िट, वज़न 52 किलो, अगली विज़िट 3 दिसंबर');
  assert.equal(r1.state, 'confirm');
  assert.match(r1.say.join(' '), /पढ़कर सुनाती हूँ/);
  assert.match(r1.say.join(' '), /बावन किलो/);
  assert.match(r1.say.join(' '), /टी डी दूसरा/); // Td-1 given 60 days ago -> Td-2 due by protocol
  const r2 = a.handle('हाँ सही है');
  assert.ok(r2.saved, 'record saved');
  assert.equal(r2.saved.beneficiaryId, '1042');
  assert.equal(r2.saved.weightKg, 52);
  assert.equal(r2.saved.nextVisit, '2026-12-03');
  assert.deepEqual(r2.saved.vaccinesDue, ['Td-2']);
  assert.equal(r2.saved.referToPHC, false);
});

test('voice correction during confirm: "no, weight is 2.8 kilo"', () => {
  const a = mk();
  a.handle('Meena Kumari ID 1078 newborn visit, weight 2.5 kilo, next visit 21 November');
  assert.equal(a.state, 'confirm');
  const r = a.handle('nahi, weight 2.8 kilo hai');
  assert.equal(a.form.weightKg, 2.8);
  assert.match(r.say.join(' '), /two point eight|दो दशमलव आठ/);
  assert.equal(r.state, 'confirm');
  const r2 = a.handle('haan');
  assert.equal(r2.saved.weightKg, 2.8);
});

test('"weight galat hai" then bare number', () => {
  const a = mk();
  a.handle('ID 1042 ANC wajan 52 kilo agli visit 3 December');
  a.handle('nahi weight galat hai');
  assert.equal(a.expect, 'weightKg');
  a.handle('54');
  assert.equal(a.form.weightKg, 54);
});

test('danger sign is escalated immediately and flagged', () => {
  const a = mk();
  const r = a.handle('रेखा देवी, आईडी 1083, ए एन सी, खून आ रहा है');
  assert.equal(r.alert, true);
  assert.match(r.say[0], /खतरे का संकेत/);
  assert.match(r.say[0], /पी एच सी रेफ़र/);
  assert.deepEqual(a.form.dangers, ['bleeding']);
});

test('negated sign is recorded as checked, not flagged', () => {
  const a = mk();
  const r = a.handle('ID 1042, bleeding nahi hai, bukhar bhi nahi');
  assert.equal(r.alert, false);
  assert.deepEqual(a.form.dangers, []);
  assert.deepEqual(a.form.dangersAbsent.sort(), ['bleeding', 'fever']);
});

test('newborn fever by number (38.3 C from 101 F) is flagged', () => {
  const a = mk();
  const r = a.handle('Fatima Begum ka baccha, navjat, temperature 101 degree');
  assert.equal(r.alert, true);
  assert.ok(a.form.dangers.includes('fever'));
});

test('high BP flagged from numbers', () => {
  const a = mk();
  a.handle('ID 1051 ANC BP 150 by 100');
  assert.ok(a.form.dangers.includes('high_bp'));
});

test('two women named Sunita -> agent asks, ward resolves', () => {
  const a = mk();
  const r = a.handle('Sunita ki visit, wajan 50 kilo');
  assert.equal(r.state, 'disambiguate');
  assert.match(r.say.join(' '), /वार्ड/);
  a.handle('ward 5 wali');
  assert.equal(a.form.beneficiaryId, '1043');
  assert.equal(a.form.weightKg, 50);
});

test('medicine question is refused with a fixed reply', () => {
  const a = mk();
  const r = a.handle('bukhar ke liye kya dawai dein?');
  assert.ok(r.say.some((s) => /दवा या इलाज की सलाह नहीं/.test(s)));
});

test('missing next visit -> agent offers protocol date, "haan" accepts it', () => {
  const a = mk();
  const r = a.handle('Priya Sharma 1051 ANC weight 48 kilo, bas');
  assert.equal(r.expect, 'nextVisit');
  assert.match(r.say.join(' '), /शेड्यूल के हिसाब से/);
  const r2 = a.handle('haan');
  assert.equal(r2.state, 'confirm');
  assert.ok(a.form.nextVisit);
});

test('new beneficiary not in register', () => {
  const a = mk('en');
  const r = a.handle('naam Radha hai, ANC, weight 45 kilo, TT pehla laga diya, next visit 10 December');
  assert.equal(a.form.isNew, true);
  assert.equal(a.form.name, 'Radha');
  assert.deepEqual(a.form.vaccinesGiven, ['Td-1']);
  assert.equal(r.state, 'confirm');
});

test('Kannada visit end to end', () => {
  const a = mk('kn');
  const r = a.handle('ಗೌರಮ್ಮ ಐಡಿ 1095 ಗರ್ಭಿಣಿ ತೂಕ ಐವತ್ತೆರಡು ಕೆಜಿ ಮುಂದಿನ ಭೇಟಿ ನಾಳೆ');
  assert.equal(a.form.beneficiaryId, '1095');
  assert.equal(a.form.weightKg, 52);
  assert.equal(a.form.nextVisit, '2026-11-20');
  assert.equal(r.state, 'confirm');
  assert.match(r.say.join(' '), /ಓದಿ ಹೇಳುತ್ತೇನೆ/);
});

test('child immunisation: vaccines due computed from age', () => {
  const a = mk('en');
  a.handle('Lakshmi Bai 1057 tikakaran, weight 4.6 kilo, next visit 15 December');
  const due = a.vaccinesDue();
  assert.ok(due.includes('Penta-1') && due.includes('OPV-1'));
  a.handle('Penta pehla aur OPV pehla laga diya');
  assert.ok(!a.vaccinesDue().includes('Penta-1'));
});

test('follow-up list query', () => {
  const a = new VisitAgent({ lang: 'en', registry, now: () => NOW, followups: () => [{ name: 'Rekha Devi', refer: true, when: '2026-11-19' }] });
  const r = a.handle('aaj ki list batao');
  assert.match(r.say[0], /Rekha Devi, refer to P H C, today/);
});

test('implausible newborn weight is questioned, not saved silently', () => {
  const a = mk();
  const r = a.handle('Fatima Begum 1060 navjat, wajan 8 kilo');
  assert.equal(a.form.weightKg, null);
  assert.equal(r.expect, 'weightCheck');
  assert.match(r.say.join(' '), /असामान्य/);
  a.handle('nahi, 2.8 kilo');
  assert.equal(a.form.weightKg, 2.8);
});

test('implausible weight can be confirmed with "haan"', () => {
  const a = mk('en');
  a.handle('Rekha Devi 1083 ANC weight 10 kilo');
  assert.equal(a.form.weightKg, null);
  a.handle('haan');
  assert.equal(a.form.weightKg, 10);
});

test('correction during read-back is also range-checked', () => {
  const a = mk();
  a.handle('ID 1042 ANC wajan 52 kilo agli visit 3 December');
  assert.equal(a.state, 'confirm');
  a.handle('nahi weight 5 kilo');
  assert.equal(a.form.weightKg, 52);
  assert.equal(a.expect, 'weightCheck');
  a.handle('55 kilo');
  assert.equal(a.form.weightKg, 55);
});

test('stray name from room chatter does not switch the person, and gets no reply', () => {
  const a = mk();
  a.handle('कविता यादव, 1066, ANC weight 64 kg, HB 6.5। अगली visit 26 November।');
  const r = a.handle('सुनीता देवी');
  assert.equal(a.form.beneficiaryId, '1066');
  assert.deepEqual(r.say, []);
  a.handle('नहीं, सुनीता देवी');
  assert.equal(a.form.beneficiaryId, '1042');
});

test('"1 kg 700 g" is 1.7 kg', () => {
  const a = mk();
  a.handle('बच्चे का वजन 1 kg 700 g, नवजात, ID 1060');
  assert.equal(a.form.weightKg, 1.7);
});

test('a mis-heard unknown ID does not replace a registered person; agent asks again', () => {
  const a = mk();
  a.handle('सुनीता देवी, आईडी 1042, ए एन सी विज़िट, वज़न 52 किलो, अगली विज़िट 3 दिसंबर');
  const r = a.handle('ID 124 किलो');
  assert.equal(a.form.beneficiaryId, '1042');
  assert.equal(r.expect, 'beneficiary');
  assert.match(r.say.join(' '), /आईडी/);
});

test('an unknown ID with no one set yet is still a new beneficiary', () => {
  const a = mk('en');
  a.handle('ID 2001 ANC weight 50 kilo');
  assert.equal(a.form.beneficiaryId, '2001');
  assert.equal(a.form.isNew, true);
});

test('the greeting says AI assistant without "not a human"', () => {
  assert.doesNotMatch(mk('hi').greet().say[0], /इंसान/);
  assert.doesNotMatch(mk('en').greet().say[0], /human/);
});

test('a medicine question refuses without recording the sign it asks about', () => {
  const a = mk();
  a.handle('रेखा देवी 1083 सातवाँ महीना है खून आ रहा है');
  const r = a.handle('बुखार के लिए क्या दवाई दें?');
  assert.match(r.say.join(' '), /सलाह नहीं दे सकती/);
  assert.deepEqual(a.form.dangers, ['bleeding'], 'fever is asked about, not reported');
  const b = mk();
  b.handle('रेखा देवी 1083');
  b.handle('बुखार है, क्या दवाई दें?');
  assert.ok(b.form.dangers.includes('fever'), 'a sign said to be there still counts');
});

test('"save kar do" is not a weight of two kilos', () => {
  const a = mk();
  a.handle('रेखा देवी 1083 सातवाँ महीना है खून आ रहा है');
  assert.equal(a.expect, 'weightKg');
  const r = a.handle('अभी सेव कर दो');
  assert.equal(a.form.weightKg, null);
  assert.doesNotMatch(r.say.join(' '), /दो किलो/);
});

test('another person by ID mid-visit saves this visit with its signs and starts a clean one', () => {
  const a = mk();
  a.handle('रेखा देवी 1083 सातवाँ महीना है खून आ रहा है');
  const r = a.handle('गौरम्मा आईडी 1095 वज़न 52 किलो');
  assert.equal(r.saved.beneficiaryId, '1083');
  assert.deepEqual(r.saved.dangerSigns, ['bleeding']);
  assert.equal(r.saved.referToPHC, true);
  assert.match(r.say[0], /रेखा देवी की विज़िट सेव कर दी/);
  assert.equal(a.form.beneficiaryId, '1095');
  assert.deepEqual(a.form.dangers, [], 'her signs do not follow to the next person');
  assert.equal(a.form.weightKg, 52);
});

test('"nahi, <ID>" is still a correction of the same visit', () => {
  const a = mk();
  a.handle('सुनीता देवी आईडी 1042 वज़न 52 किलो');
  const r = a.handle('नहीं, आईडी 1043');
  assert.ok(!r.saved);
  assert.equal(a.form.beneficiaryId, '1043');
  assert.equal(a.form.weightKg, 52);
});
