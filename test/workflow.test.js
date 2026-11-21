// Visit workflow outside the dialogue: editing a saved visit, drafts, follow-up dates and the
// counts-only summary. These are the pure parts of store.js and agent.js (no IndexedDB needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry } from '../public/js/nlu/registry.js';
import { vaccinationList } from '../public/js/nlu/schedule.js';
import { followupsFrom, dueStatus, summarize, registerRows, toCsv } from '../public/js/store.js';
import { SCREEN, screenText, LANGS, YES_WORD, t } from '../public/js/i18n.js';

const NOW = new Date(2026, 10, 19);
const TODAY = '2026-11-19';
const registry = buildRegistry(NOW);
const mk = (lang = 'en') => new VisitAgent({ lang, registry, now: () => NOW });

function saveVisit(text, lang = 'en') {
  const a = mk(lang);
  a.handle(text);
  return a.handle('yes').saved;
}

test('due status has one definition: overdue, today, next 7 days, later', () => {
  assert.equal(dueStatus('2026-11-18', TODAY), 'overdue');
  assert.equal(dueStatus(TODAY, TODAY), 'today');
  assert.equal(dueStatus('2026-11-26', TODAY), 'soon');
  assert.equal(dueStatus('2026-11-27', TODAY), 'later');
  assert.equal(dueStatus(null, TODAY), 'none');
});

test('a referral keeps the date it was advised; it is not re-dated to today', () => {
  const recs = [{ visitId: 'a', name: 'Rekha Devi', beneficiaryId: '1083', visitType: 'ANC', referToPHC: true, dangerSigns: ['high_bp'], visitDate: '2026-11-12', nextVisit: '2026-11-15', savedAt: '2026-11-12T10:00:00Z' }];
  const [x] = followupsFrom(recs, TODAY);
  assert.equal(x.refer, true);
  assert.equal(x.referredOn, '2026-11-12');
  assert.equal(x.due, '2026-11-15');
  assert.equal(x.status, 'overdue');
});

test('follow-ups come from each person\'s latest visit, and unnamed records stay separate', () => {
  const recs = [
    { visitId: 'old', beneficiaryId: '1042', name: 'Sunita Devi', visitDate: '2026-11-01', nextVisit: '2026-11-10', savedAt: '2026-11-01T09:00:00Z' },
    { visitId: 'new', beneficiaryId: '1042', name: 'Sunita Devi', visitDate: '2026-11-18', nextVisit: '2026-12-03', savedAt: '2026-11-18T09:00:00Z' },
    { visitId: 'u1', visitDate: '2026-11-18', nextVisit: '2026-11-20', savedAt: '2026-11-18T10:00:00Z' },
    { visitId: 'u2', visitDate: '2026-11-18', nextVisit: '2026-11-21', savedAt: '2026-11-18T11:00:00Z' },
  ];
  const fu = followupsFrom(recs, TODAY);
  assert.equal(fu.length, 3);
  assert.equal(fu.find((x) => x.beneficiaryId === '1042').due, '2026-12-03');
  // order: soonest first when nobody is referred
  assert.deepEqual(fu.map((x) => x.visitId), ['u1', 'u2', 'new']);
});

test('summary is counts only: no names or IDs in it', () => {
  const recs = [
    saveVisit('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December'),
    saveVisit('Meena Kumari 1078 newborn visit weight 3.1 kilo baby has fever next visit tomorrow'),
  ];
  const m = summarize(recs, TODAY);
  assert.equal(m.visits, 2);
  assert.equal(m.byType.ANC, 1);
  assert.equal(m.referrals, 1);
  const json = JSON.stringify(m);
  assert.ok(!/Sunita|Meena|1042|1078/.test(json));
});

test('a saved visit can be reopened, corrected by voice and saved over itself', () => {
  const rec = saveVisit('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December');
  const later = new VisitAgent({ lang: 'en', registry, now: () => new Date(2026, 10, 21) });
  later.edit(rec);
  assert.equal(later.state, 'confirm');
  assert.equal(later.form.weightKg, 52);
  later.handle('no, weight 54 kilo');
  assert.equal(later.form.weightKg, 54);
  const again = later.handle('yes').saved;
  assert.ok(again, 'saved after correction');
  assert.equal(again.visitId, rec.visitId, 'same record, not a duplicate');
  assert.equal(again.visitDate, rec.visitDate, 'original visit date kept');
  assert.equal(again.savedAt, rec.savedAt);
  assert.ok(again.updatedAt);
  assert.equal(again.weightKg, 54);
});

test('correcting a number clears the danger sign that came from it; spoken signs stay', () => {
  const rec = saveVisit('Rekha Devi 1083 ANC weight 60 kilo BP 150/100 next visit 3 December');
  assert.ok(rec.dangerSigns.includes('high_bp'));
  const a = mk();
  a.edit(rec);
  a.handle('no, BP 120/80');
  assert.ok(!a.form.dangers.includes('high_bp'));

  const rec2 = saveVisit('Meena Kumari 1078 newborn weight 3.1 kilo baby has fever next visit tomorrow');
  const b = mk();
  b.edit(rec2);
  assert.ok(b.form.dangers.includes('fever'));
});

test('pregnancy / newborn start buttons fix the visit type, also for a follow-up person', () => {
  const a = mk();
  a.startVisit('HBNC');
  assert.equal(a.form.visitType, 'HBNC');
  a.handle('Meena Kumari 1078 weight 3.1 kilo');
  assert.equal(a.form.visitType, 'HBNC');

  const b = mk();
  b.startVisit('ANC', { beneficiaryId: '1042', name: 'Sunita Devi' });
  assert.equal(b.form.beneficiaryId, '1042');
  assert.equal(b.form.visitType, 'ANC');
  assert.ok(b.form.beneficiary, 'linked to the register');
});

test('an unfinished visit survives a reload as a draft', () => {
  const a = mk();
  a.handle('Sunita Devi 1042 weight 52 kilo');
  assert.ok(a.dirty);
  const stored = JSON.parse(JSON.stringify(a.snapshot()));
  const b = mk();
  b.restore(stored);
  assert.equal(b.form.weightKg, 52);
  assert.equal(b.form.beneficiaryId, '1042');
  assert.deepEqual(b.missing(), ['nextVisit']);
  assert.ok(!mk().dirty, 'a fresh visit is not a draft');
});

// ---------- referral follow-through, recording time, monthly counts ----------

const REFERRED = { visitId: 'r1', name: 'Rekha Devi', beneficiaryId: '1083', visitType: 'ANC', referToPHC: true, dangerSigns: ['bleeding'], visitDate: '2026-11-17', nextVisit: '2026-11-24', savedAt: '2026-11-17T10:00:00Z', vaccinesGiven: ['Td-1'] };

test('a referral asks "did she reach the PHC?" from the next day until she has', () => {
  assert.equal(followupsFrom([{ ...REFERRED, visitDate: TODAY }], TODAY)[0].checkDue, false, 'not on the day of the referral');
  assert.equal(followupsFrom([REFERRED], TODAY)[0].checkDue, true);
  const notYet = { ...REFERRED, referralOutcome: 'not_reached', referralCheckedOn: TODAY };
  assert.equal(followupsFrom([notYet], TODAY)[0].checkDue, false, 'asked once a day');
  assert.equal(followupsFrom([notYet], TODAY)[0].refer, true, 'still on the referral list');
  assert.equal(followupsFrom([notYet], '2026-11-20')[0].checkDue, true, 'asked again the next day');
  const reached = followupsFrom([{ ...REFERRED, referralOutcome: 'reached', referralCheckedOn: TODAY }], TODAY)[0];
  assert.equal(reached.refer, false, 'closed once she reached');
  assert.equal(reached.checkDue, false);
  assert.equal(reached.referralOutcome, 'reached');
});

test('"today\'s list" asks about an open referral and records a spoken yes or no', () => {
  for (const [answer, outcome] of [['haan', 'reached'], ['nahi', 'not_reached']]) {
    const a = new VisitAgent({ lang: 'hi', registry, now: () => NOW, followups: () => followupsFrom([REFERRED], TODAY) });
    const r1 = a.handle('aaj ki list');
    assert.equal(a.state, 'referralCheck');
    assert.ok(r1.say.join(' ').includes(t('hi').askReached('Rekha Devi', '').split(' ')[0]));
    const r2 = a.handle(answer);
    assert.deepEqual(r2.referralOutcome, { visitId: 'r1', outcome, checkedOn: TODAY });
    assert.equal(a.state, 'dictate');
    assert.ok(!a.dirty, 'the question is not part of a visit note');
  }
});

test('the referral question works in every language with its own yes', () => {
  for (const l of Object.keys(LANGS)) {
    const a = new VisitAgent({ lang: l, registry, now: () => NOW, followups: () => followupsFrom([REFERRED], TODAY) });
    a.handle('aaj ki list');
    assert.equal(a.state, 'referralCheck', l);
    assert.equal(a.handle(YES_WORD[l]).referralOutcome?.outcome, 'reached', l);
  }
});

test('a visit note instead of yes/no is taken as a visit, and no question comes mid-visit', () => {
  const a = new VisitAgent({ lang: 'en', registry, now: () => NOW, followups: () => followupsFrom([REFERRED], TODAY) });
  a.handle("today's list");
  const r = a.handle('Sunita Devi 1042 weight 52 kilo');
  assert.ok(!r.referralOutcome);
  assert.equal(a.form.beneficiaryId, '1042');
  const r2 = a.handle("today's list");
  assert.notEqual(a.state, 'referralCheck', 'no referral question in the middle of a visit');
  assert.ok(!r2.referralOutcome);
});

test('recording time runs from the first word to the save; a correction keeps it', () => {
  let ms = 1_000_000;
  const a = new VisitAgent({ lang: 'en', registry, now: () => NOW, clock: () => ms });
  ms += 5000; // she opens the app, then starts talking later
  a.handle('Sunita Devi 1042 ANC weight 52 kilo');
  ms += 20_000;
  a.handle('next visit 3 December');
  ms += 14_000;
  const rec = a.handle('yes').saved;
  assert.equal(rec.recordSeconds, 34);
  assert.equal(rec.turns, 3);
  const b = new VisitAgent({ lang: 'en', registry, now: () => NOW, clock: () => ms + 99_000 });
  b.edit(rec);
  b.handle('no, weight 54 kilo');
  assert.equal(b.handle('yes').saved.recordSeconds, 34);
});

test('monthly counts: this month only, doses and referrals reached, still no names', () => {
  const recs = [
    { ...REFERRED, referralOutcome: 'reached', recordSeconds: 40 },
    { visitId: 'b', name: 'Meena Kumari', beneficiaryId: '1078', visitType: 'HBNC', visitDate: '2026-11-03', nextVisit: '2026-11-25', vaccinesGiven: ['BCG', 'OPV-0'], recordSeconds: 20 },
    { visitId: 'c', name: 'Priya Sharma', beneficiaryId: '1051', visitType: 'ANC', visitDate: '2026-10-28', nextVisit: '2026-11-28', vaccinesGiven: ['Td-1'] },
  ];
  const m = summarize(recs, TODAY);
  assert.equal(m.month.key, '2026-11');
  assert.equal(m.month.visits, 2);
  assert.deepEqual(m.month.byType, { ANC: 1, PNC: 0, HBNC: 1, IMM: 0 });
  assert.equal(m.month.dosesGiven, 3);
  assert.equal(m.month.referrals, 1);
  assert.equal(m.month.reachedPHC, 1);
  assert.deepEqual(m.timing, { visits: 2, avgSeconds: 30, totalSeconds: 60 });
  assert.ok(!/Rekha|Meena|Priya|1083|1078|1051/.test(JSON.stringify(m)));
});

test('data per visit: averaged over measured visits, kept when a visit is corrected', () => {
  const m = summarize([{ visitId: 'a', visitDate: TODAY, dataBytes: 3_000_000 }, { visitId: 'b', visitDate: TODAY, dataBytes: 1_000_000 }, { visitId: 'c', visitDate: TODAY, dataBytes: null }], TODAY);
  assert.deepEqual(m.data, { visits: 2, avgBytes: 2_000_000, totalBytes: 4_000_000 });
  const rec = { ...saveVisit('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December'), dataBytes: 2_500_000 };
  assert.equal(saveVisit('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December').dataBytes, null, 'the app measures it, not the agent');
  const a = mk();
  a.edit(rec);
  a.handle('no, weight 53 kilo');
  assert.equal(a.handle('yes').saved.dataBytes, 2_500_000);
});

test('register page: one day, in saved order, one cell per column', () => {
  const recs = [
    { ...REFERRED, visitDate: TODAY, savedAt: '2026-11-19T11:00:00Z', bp: { sys: 150, dia: 100 }, weightKg: 60, referralOutcome: 'not_reached' },
    { visitId: 'b', name: 'Sunita Devi', beneficiaryId: '1042', ward: 3, visitType: 'ANC', weightKg: 52, visitDate: TODAY, savedAt: '2026-11-19T09:00:00Z', vaccinesDue: ['Td-2'], nextVisit: '2026-12-03', gestWeeks: 24 },
    { visitId: 'c', name: 'Other day', visitDate: '2026-11-18', savedAt: '2026-11-18T09:00:00Z' },
  ];
  const rows = registerRows(recs, TODAY, { label: (d) => d.toUpperCase() });
  assert.equal(rows.length, 2, 'only the chosen day');
  assert.deepEqual(rows.map((r) => r[3]), ['Sunita Devi', 'Rekha Devi'], 'in the order they were saved');
  assert.ok(rows.every((r) => r.length === SCREEN.en.regCols.length), 'one cell per column');
  const [sunita, rekha] = rows;
  assert.equal(sunita[0], '1');
  assert.equal(sunita[4], '3');
  assert.equal(sunita[10], '24 wk');
  assert.equal(sunita[12], 'Td-2');
  assert.equal(sunita[14], '');
  assert.equal(rekha[7], '150/100');
  assert.equal(rekha[13], 'BLEEDING');
  assert.equal(rekha[14], 'Yes, not yet reached');
});

test('CSV opens in Excel and cannot carry a formula', () => {
  const csv = toCsv(['Name', 'Note'], [['Sunita, Devi', '=HYPERLINK("x")'], ['सुनीता', '+91 98']]);
  assert.ok(csv.startsWith('﻿'), 'UTF-8 BOM so Indic text shows');
  const lines = csv.slice(1).trim().split('\r\n');
  assert.equal(lines[0], 'Name,Note');
  assert.equal(lines[1], '"Sunita, Devi","\'=HYPERLINK(""x"")"');
  assert.equal(lines[2], 'सुनीता,\'+91 98');
});

// ---------- history: earlier saved visits count; vaccination-day list ----------

function visitOn(date, text, records = []) {
  const a = new VisitAgent({ lang: 'en', registry, now: () => date, records: () => records });
  a.handle(text);
  return a.handle('yes').saved;
}

test('a vaccine given at an earlier saved visit is not asked for again', () => {
  const first = visitOn(new Date(2026, 9, 20), 'Priya Sharma 1051 ANC weight 50 kilo TT first given next visit 19 November');
  assert.deepEqual(first.vaccinesGiven, ['Td-1']);
  const a = new VisitAgent({ lang: 'en', registry, now: () => NOW, records: () => [first] });
  a.handle('Priya Sharma 1051 weight 52 kilo');
  assert.deepEqual(a.vaccinesDue(), ['Td-2'], 'Td-2 is due 4 weeks after Td-1, not Td-1 again');
  const soon = visitOn(new Date(2026, 10, 12), 'Priya Sharma 1051 ANC weight 50 kilo TT first given next visit 19 November');
  const b = new VisitAgent({ lang: 'en', registry, now: () => NOW, records: () => [soon] });
  b.handle('Priya Sharma 1051 weight 52 kilo');
  assert.deepEqual(b.vaccinesDue(), [], 'Td-2 waits for the 4-week gap');
  const c = new VisitAgent({ lang: 'en', registry, now: () => NOW, records: () => [first] });
  c.handle('Priya Sharma 1051 TT given');
  assert.deepEqual(c.form.vaccinesGiven, ['Td-2'], '"TT given" after an earlier Td-1 is the second dose');
});

test('the read-back says the last saved weight; the visit card shows the last visit', () => {
  const first = visitOn(new Date(2026, 10, 5), 'Sunita Devi 1042 ANC weight 50 kilo next visit 19 November');
  const a = new VisitAgent({ lang: 'en', registry, now: () => NOW, records: () => [first] });
  const r = a.handle('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December');
  assert.match(r.say.join(' '), /weight fifty two kilo, on the last visit, November five, it was fifty kilo/);
  assert.equal(a.lastVisit().visitId, first.visitId);
  const fresh = new VisitAgent({ lang: 'en', registry, now: () => NOW, records: () => [] });
  assert.doesNotMatch(fresh.handle('Sunita Devi 1042 ANC weight 52 kilo next visit 3 December').say.join(' '), /last visit/);
});

test('vaccination-day list: grouped by vaccine, register people included, saved doses removed', () => {
  const before = vaccinationList(registry, [], NOW);
  const td1 = before.find((g) => g.code === 'Td-1');
  assert.ok(td1.people.some((p) => p.id === '1051'), 'Priya (no Td yet) is due Td-1');
  assert.equal(before[0].code, 'Td-1', 'schedule order');
  assert.ok(before.some((g) => g.code === 'Penta-1' && g.people.some((p) => p.id === '1057')), 'Lakshmi Bai, 6 weeks old, is due Penta-1');
  const given = visitOn(NOW, 'Priya Sharma 1051 ANC weight 50 kilo TT first given next visit 17 December');
  const after = vaccinationList(registry, [given], NOW);
  assert.ok(!after.find((g) => g.code === 'Td-1')?.people.some((p) => p.id === '1051'), 'Td-1 given today: off the list');
  const added = { visitId: 'n1', isNew: true, name: 'Radha', visitDate: TODAY, vaccinesDue: ['MR-1'] };
  assert.ok(vaccinationList(registry, [added], NOW).find((g) => g.code === 'MR-1').people.some((p) => p.name === 'Radha'), 'people added by voice are listed from their visit');
});

test('"tike ki list" speaks the vaccine list in each language, and is not a visit note', () => {
  for (const [l, said] of [['hi', 'tike ki list'], ['en', 'vaccine list'], ['kn', 'ಲಸಿಕೆ ಪಟ್ಟಿ'], ['ta', 'தடுப்பூசி பட்டியல்'], ['pa', 'ਟੀਕਿਆਂ ਦੀ ਸੂਚੀ'], ['gu', 'રસીની યાદી']]) {
    const a = new VisitAgent({ lang: l, registry, now: () => NOW, records: () => [] });
    const r = a.handle(said);
    assert.ok(r.say[0].startsWith(t(l).vaccineList(['x'], 0).split('x')[0]), `${l}: ${r.say[0]}`);
    assert.ok(!a.dirty, l);
  }
});

test('every screen string exists in every language (English fallback)', () => {
  for (const l of Object.keys(LANGS)) {
    const s = screenText(l);
    for (const k of Object.keys(SCREEN.en)) assert.ok(s[k] !== undefined, `${l}.${k}`);
  }
});
