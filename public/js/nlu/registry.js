// SYNTHETIC beneficiaries only (track guardrail). Names are invented; dates are relative to
// today so the demo stays current. Two "Sunita"s exist on purpose to show disambiguation.
import { iso } from './dates.js';
import { transliterate, phon } from './translit.js';

const BASE = [
  { id: '1042', name: 'Sunita Devi', nameHi: 'सुनीता देवी', husband: 'Ramesh', ward: 3, kind: 'pregnant', lmpDaysAgo: 196, vaccinesGiven: ['Td-1'], td1DaysAgo: 60 },
  { id: '1043', name: 'Sunita Kumari', nameHi: 'सुनीता कुमारी', husband: 'Mahesh', ward: 5, kind: 'mother', dobDaysAgo: 6, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0'] },
  { id: '1051', name: 'Priya Sharma', nameHi: 'प्रिया शर्मा', husband: 'Anil', ward: 2, kind: 'pregnant', lmpDaysAgo: 84, vaccinesGiven: [] },
  { id: '1057', name: 'Lakshmi Bai', nameHi: 'लक्ष्मी बाई', husband: 'Gopal', ward: 1, kind: 'child', dobDaysAgo: 44, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0'] },
  { id: '1060', name: 'Fatima Begum', nameHi: 'फ़ातिमा बेगम', husband: 'Salim', ward: 4, kind: 'mother', dobDaysAgo: 2, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0'] },
  { id: '1066', name: 'Kavita Yadav', nameHi: 'कविता यादव', husband: 'Suresh', ward: 2, kind: 'pregnant', lmpDaysAgo: 252, vaccinesGiven: ['Td-1', 'Td-2'] },
  { id: '1071', name: 'Anjali Verma', nameHi: 'अंजलि वर्मा', husband: 'Vikas', ward: 6, kind: 'child', dobDaysAgo: 272, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0', 'OPV-1', 'Penta-1', 'RVV-1', 'fIPV-1', 'PCV-1', 'OPV-2', 'Penta-2', 'RVV-2', 'OPV-3', 'Penta-3', 'RVV-3', 'fIPV-2', 'PCV-2'] },
  { id: '1078', name: 'Meena Kumari', nameHi: 'मीना कुमारी', husband: 'Raju', ward: 3, kind: 'mother', dobDaysAgo: 13, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0'] },
  { id: '1083', name: 'Rekha Devi', nameHi: 'रेखा देवी', husband: 'Mohan', ward: 5, kind: 'pregnant', lmpDaysAgo: 140, vaccinesGiven: ['Td-1'], td1DaysAgo: 35 },
  { id: '1090', name: 'Shabnam Khatoon', nameHi: 'शबनम ख़ातून', husband: 'Irfan', ward: 4, kind: 'child', dobDaysAgo: 100, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0', 'OPV-1', 'Penta-1', 'RVV-1', 'fIPV-1', 'PCV-1', 'OPV-2', 'Penta-2', 'RVV-2'] },
  { id: '1095', name: 'Gowramma', nameHi: 'गौरम्मा', nameKn: 'ಗೌರಮ್ಮ', husband: 'Nagaraj', ward: 7, kind: 'pregnant', lmpDaysAgo: 175, vaccinesGiven: [] },
  { id: '1101', name: 'Savitha', nameHi: 'सविता', nameKn: 'ಸವಿತಾ', husband: 'Manjunath', ward: 7, kind: 'child', dobDaysAgo: 99, vaccinesGiven: ['BCG', 'OPV-0', 'HepB-0', 'OPV-1', 'Penta-1', 'RVV-1', 'fIPV-1', 'PCV-1', 'OPV-2', 'Penta-2', 'RVV-2'] },
];

function daysAgo(n, today) {
  return iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - n));
}

export function buildRegistry(today = new Date()) {
  return BASE.map((b) => ({
    ...b,
    lmp: b.lmpDaysAgo != null ? daysAgo(b.lmpDaysAgo, today) : null,
    dob: b.dobDaysAgo != null ? daysAgo(b.dobDaysAgo, today) : null,
    td1Date: b.td1DaysAgo != null ? daysAgo(b.td1DaysAgo, today) : null,
    defaultVisit: b.kind === 'pregnant' ? 'ANC' : b.kind === 'mother' ? 'HBNC' : 'IMM',
    keys: nameKeys(b),
  }));
}

function nameKeys(b) {
  const parts = [b.name, b.nameHi, b.nameKn].filter(Boolean).map((n) => transliterate(n).toLowerCase().split(/\s+/).map(phon));
  return parts;
}

// Words used to bias the STT model (Prisma v3.0 keyterms).
export function registryKeyterms(reg) {
  const out = new Set();
  for (const b of reg) { out.add(b.name); if (b.nameHi) out.add(b.nameHi); if (b.nameKn) out.add(b.nameKn); }
  return [...out];
}

function lev(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

// A mis-heard name keeps its first sound; an everyday word one letter away does not
// ("देखा" dekha is not "रेखा" Rekha).
function close(a, b) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 4 || a[0] !== b[0]) return false;
  return lev(a, b) <= (Math.max(a.length, b.length) >= 7 ? 2 : 1);
}

// Find beneficiaries named in the tokens. Returns [{ b, start, end, full }] - `full` = first+last name matched.
export function findNames(tokens, reg) {
  const hits = [];
  for (const b of reg) {
    for (const parts of b.keys) {
      for (let i = 0; i < tokens.length; i++) {
        if (!close(tokens[i].key, parts[0])) continue;
        let end = i + 1;
        let full = parts.length === 1;
        if (parts.length > 1 && tokens[i + 1] && close(tokens[i + 1].key, parts[1])) { end = i + 2; full = true; }
        // a first name alone must be exact: "मिला" (met) is not Meena, "रखा" (kept) is not Rekha;
        // a near miss counts only with the surname after it
        if (tokens[i].key !== parts[0] && end !== i + 2) continue;
        hits.push({ b, start: i, end, full });
      }
    }
  }
  // keep best per beneficiary
  const best = new Map();
  for (const h of hits) {
    const prev = best.get(h.b.id);
    if (!prev || (h.full && !prev.full)) best.set(h.b.id, h);
  }
  let list = [...best.values()];
  // if any full-name match exists, drop first-name-only matches
  if (list.some((h) => h.full && h.b.keys[0].length > 1)) list = list.filter((h) => h.full);
  return list;
}
