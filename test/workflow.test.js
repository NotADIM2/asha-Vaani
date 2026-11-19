// Visit workflow outside the dialogue: editing a saved visit, drafts, follow-up dates and the
// counts-only summary. These are the pure parts of store.js and agent.js (no IndexedDB needed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VisitAgent } from '../public/js/agent.js';
import { buildRegistry } from '../public/js/nlu/registry.js';
import { followupsFrom, dueStatus, summarize } from '../public/js/store.js';
import { SCREEN, screenText, LANGS } from '../public/js/i18n.js';

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

test('every screen string exists in every language (English fallback)', () => {
  for (const l of Object.keys(LANGS)) {
    const s = screenText(l);
    for (const k of Object.keys(SCREEN.en)) assert.ok(s[k] !== undefined, `${l}.${k}`);
  }
});
