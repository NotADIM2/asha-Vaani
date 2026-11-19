// Fixed protocol tables (no clinical judgement): what is due by age, and when the next
// routine visit falls. Sources: MoHFW National Immunization Schedule (UIP), MoHFW ANC
// guidelines (4 ANC contacts), HBNC Operational Guidelines 2014 (home-visit days).
import { iso, fromIso } from './dates.js';

const toDate = (d) => (d instanceof Date ? d : fromIso(d));

// Child vaccines: [dueAgeDays, code]
export const CHILD_SCHEDULE = [
  [0, 'BCG'], [0, 'OPV-0'], [0, 'HepB-0'],
  [42, 'OPV-1'], [42, 'Penta-1'], [42, 'RVV-1'], [42, 'fIPV-1'], [42, 'PCV-1'],
  [70, 'OPV-2'], [70, 'Penta-2'], [70, 'RVV-2'],
  [98, 'OPV-3'], [98, 'Penta-3'], [98, 'RVV-3'], [98, 'fIPV-2'], [98, 'PCV-2'],
  [270, 'MR-1'], [270, 'JE-1'], [270, 'PCV-B'], [270, 'VitA-1'],
  [480, 'MR-2'], [480, 'JE-2'], [480, 'DPT-B1'], [480, 'OPV-B'], [480, 'VitA-2'],
];

// Pregnancy: Td-1 at first contact, Td-2 four weeks after Td-1.
export const PREGNANCY_VACCINES = ['Td-1', 'Td-2'];

// ANC contacts by gestational week windows.
export const ANC_CONTACTS = [
  { n: 1, fromWk: 0, toWk: 12 },
  { n: 2, fromWk: 14, toWk: 26 },
  { n: 3, fromWk: 28, toWk: 34 },
  { n: 4, fromWk: 36, toWk: 40 },
];

// HBNC home visits (institutional birth): day 3, 7, 14, 21, 28, 42.
export const HBNC_DAYS = [3, 7, 14, 21, 28, 42];

const DAY = 86400000;
function daysBetween(a, b) {
  return Math.round((b - a) / DAY);
}
function addDays(d, n) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// Vaccines due now (age reached, not given), soonest first.
export function vaccinesDueForChild(ageDays, given = []) {
  const g = new Set(given.map((v) => v.toUpperCase()));
  return CHILD_SCHEDULE.filter(([d, code]) => d <= ageDays + 3 && !g.has(code.toUpperCase()))
    // birth doses lapse: OPV-0 by 15 days, HepB-0 by 24 hours
    .filter(([, code]) => !(code === 'OPV-0' && ageDays > 15) && !(code === 'HepB-0' && ageDays > 1))
    .map(([, code]) => code);
}

export function nextChildVaccine(ageDays, given = []) {
  const g = new Set(given.map((v) => v.toUpperCase()));
  const next = CHILD_SCHEDULE.find(([d, code]) => d > ageDays + 3 && !g.has(code.toUpperCase()));
  return next ? { code: next[1], inDays: next[0] - ageDays } : null;
}

export function vaccinesDueInPregnancy(given = [], td1Date = null, today = new Date()) {
  const g = new Set(given.map((v) => v.toUpperCase()));
  if (!g.has('TD-1') && !g.has('TT-1')) return ['Td-1'];
  if (!g.has('TD-2') && !g.has('TT-2')) {
    if (!td1Date || daysBetween(toDate(td1Date), today) >= 28) return ['Td-2'];
  }
  return [];
}

// Protocol-suggested next visit date (the ASHA can always say a different date).
export function suggestNextVisit(b, visitType, today = new Date()) {
  if (visitType === 'HBNC' || visitType === 'PNC') {
    const dob = b?.dob ? toDate(b.dob) : null;
    if (dob) {
      const age = daysBetween(dob, today);
      const nxt = HBNC_DAYS.find((d) => d > age);
      if (nxt) return iso(addDays(dob, nxt));
    }
    return iso(addDays(today, 7));
  }
  if (visitType === 'ANC') {
    const lmp = b?.lmp ? toDate(b.lmp) : null;
    if (lmp) {
      const wk = daysBetween(lmp, today) / 7;
      const nxt = ANC_CONTACTS.find((c) => c.fromWk > wk);
      if (nxt) return iso(addDays(lmp, nxt.fromWk * 7));
    }
    return iso(addDays(today, 28));
  }
  if (visitType === 'IMM') {
    const dob = b?.dob ? toDate(b.dob) : null;
    if (dob) {
      const n = nextChildVaccine(daysBetween(dob, today), b.vaccinesGiven || []);
      if (n) return iso(addDays(today, Math.max(1, n.inDays)));
    }
    return iso(addDays(today, 28));
  }
  return iso(addDays(today, 7));
}

export function ageDays(b, today = new Date()) {
  return b?.dob ? daysBetween(toDate(b.dob), today) : null;
}
export function gestWeeks(b, today = new Date()) {
  return b?.lmp ? Math.floor(daysBetween(toDate(b.lmp), today) / 7) : null;
}
