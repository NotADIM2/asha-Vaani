// Visit records stay on the phone, encrypted at rest with AES-GCM (WebCrypto). The key is
// non-extractable and lives in IndexedDB, so the ciphertext can't be read outside this app.
// Records expire automatically (default 7 days) to honour "delete after judging".

const DB = 'asha-vaani';
const VERSION = 1;
const DAY = 86400000;

function req(r) {
  return new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
}

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const r = indexedDB.open(DB, VERSION);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('keys');
        r.result.createObjectStore('records', { keyPath: 'id' });
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }
  return dbp;
}

async function store(name, mode = 'readonly') {
  return (await db()).transaction(name, mode).objectStore(name);
}

let keyp = null;
async function key() {
  if (!keyp) {
    keyp = (async () => {
      const existing = await req((await store('keys')).get('main'));
      if (existing) return existing;
      const k = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      await req((await store('keys', 'readwrite')).put(k, 'main'));
      return k;
    })();
  }
  return keyp;
}

export function retentionDays() {
  try { return Number(localStorage.getItem('retentionDays')) || 7; } catch { return 7; }
}

// Nothing here is sent to a server: this prototype has no sync. The UI says so.
const DRAFT = '__draft';

async function seal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(obj)));
  return { iv, data };
}

async function open(row, k) {
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, k, row.data);
  return JSON.parse(new TextDecoder().decode(plain));
}

// Resolves only after IndexedDB has committed the write, so "saved" is never said early.
export async function saveRecord(rec) {
  const sealed = await seal(rec);
  const s = await store('records', 'readwrite');
  const done = new Promise((resolve, reject) => { s.transaction.oncomplete = resolve; s.transaction.onerror = () => reject(s.transaction.error); s.transaction.onabort = () => reject(s.transaction.error || new Error('write aborted')); });
  s.put({ id: rec.visitId, ...sealed, expiresAt: Date.now() + retentionDays() * DAY });
  await done;
}

// Change a few fields of a saved visit (the referral outcome) without moving its delete date.
export async function updateRecord(visitId, patch) {
  const k = await key();
  const row = await req((await store('records')).get(visitId));
  if (!row) throw new Error('visit not found');
  const sealed = await seal({ ...(await open(row, k)), ...patch });
  const s = await store('records', 'readwrite');
  const done = new Promise((resolve, reject) => { s.transaction.oncomplete = resolve; s.transaction.onerror = () => reject(s.transaction.error); s.transaction.onabort = () => reject(s.transaction.error || new Error('write aborted')); });
  s.put({ id: visitId, ...sealed, expiresAt: row.expiresAt });
  await done;
}

// Each record comes back with `expiresAt` so the screen can say when it will be deleted.
export async function listRecords() {
  await purgeExpired();
  const rows = await req((await store('records')).getAll());
  const k = await key();
  const out = [];
  for (const row of rows) {
    if (row.id === DRAFT) continue;
    try { out.push({ ...(await open(row, k)), expiresAt: row.expiresAt }); } catch { /* undecryptable rows are skipped */ }
  }
  return sortLatestFirst(out);
}

// An unfinished visit, kept (encrypted) so a reload or a dropped connection doesn't lose it.
export async function saveDraft(form) {
  const sealed = await seal(form);
  await req((await store('records', 'readwrite')).put({ id: DRAFT, ...sealed, expiresAt: Date.now() + retentionDays() * DAY }));
}

export async function loadDraft() {
  const row = await req((await store('records')).get(DRAFT));
  if (!row || row.expiresAt < Date.now()) return null;
  try { return await open(row, await key()); } catch { return null; }
}

export async function clearDraft() {
  await req((await store('records', 'readwrite')).delete(DRAFT));
}

export async function purgeExpired() {
  const s = await store('records', 'readwrite');
  const rows = await req(s.getAll());
  const now = Date.now();
  await Promise.all(rows.filter((r) => r.expiresAt < now).map((r) => req(s.delete(r.id))));
}

export async function deleteAll() {
  await req((await store('records', 'readwrite')).clear());
}

// ---------- pure helpers (no storage), shared by every screen and the spoken list ----------

export function sortLatestFirst(records) {
  return [...records].sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || '') || (b.savedAt || '').localeCompare(a.savedAt || ''));
}

function plusDays(isoStr, n) {
  const [y, m, d] = isoStr.split('-').map(Number);
  const x = new Date(y, m - 1, d + n);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

// One definition of "due" used everywhere: overdue | today | soon (next 7 days) | later | none.
export function dueStatus(dueIso, todayIso) {
  if (!dueIso) return 'none';
  if (dueIso < todayIso) return 'overdue';
  if (dueIso === todayIso) return 'today';
  if (dueIso <= plusDays(todayIso, 7)) return 'soon';
  return 'later';
}

const STATUS_ORDER = { overdue: 0, today: 1, soon: 2, later: 3, none: 4 };

// Did a referred woman actually reach the PHC? Asked from the day after the referral, and
// again each day while the answer is "not yet". Once she reached, the referral is closed.
function referralCheckDue(r, todayIso) {
  if (!r.referToPHC || r.referralOutcome === 'reached') return false;
  if (r.referralOutcome === 'not_reached') return (r.referralCheckedOn || '') < todayIso;
  return (r.visitDate || '') < todayIso;
}

// Follow-up list from each person's latest visit. A referral stays dated to the visit where
// it was advised (it is not re-dated to "today" every day); the next-visit date is the due date.
export function followupsFrom(records, todayIso) {
  const latest = new Map();
  for (const r of sortLatestFirst(records)) {
    const k = r.beneficiaryId || r.name || r.visitId;
    if (!latest.has(k)) latest.set(k, r);
  }
  return [...latest.values()]
    .filter((r) => r.nextVisit || r.referToPHC)
    .map((r) => ({
      visitId: r.visitId,
      name: r.name,
      beneficiaryId: r.beneficiaryId,
      refer: Boolean(r.referToPHC) && r.referralOutcome !== 'reached',
      referredOn: r.referToPHC ? r.visitDate : null,
      referralOutcome: r.referToPHC ? r.referralOutcome || null : null,
      referralCheckedOn: r.referralCheckedOn || null,
      checkDue: referralCheckDue(r, todayIso),
      dangerSigns: r.dangerSigns || [],
      due: r.nextVisit || null,
      when: r.nextVisit || r.visitDate,
      nextVisit: r.nextVisit,
      status: dueStatus(r.nextVisit, todayIso),
      vaccinesDue: r.vaccinesDue || [],
      visitType: r.visitType,
    }))
    .sort((a, b) => (b.refer - a.refer) || (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || (a.when || '').localeCompare(b.when || ''));
}

// One day's visits as register rows, in the order they were saved, so she can copy them into
// the official register or show the ANM. Columns follow `regCols` in i18n.js. `label` turns a
// danger-sign id into words; `words` gives the referral cell text.
export function registerRows(records, dayIso, { label = (d) => d, words = { yes: 'Yes', reached: 'Yes, reached PHC', notYet: 'Yes, not yet reached' } } = {}) {
  const day = records.filter((r) => r.visitDate === dayIso)
    .sort((a, b) => (a.savedAt || '').localeCompare(b.savedAt || ''));
  return day.map((r, i) => [
    String(i + 1),
    r.visitDate || '',
    r.beneficiaryId || '',
    r.name || '',
    r.ward ?? '',
    r.visitType || '',
    r.weightKg ?? (r.weightNotTaken ? 'not weighed' : ''),
    r.bp ? `${r.bp.sys}/${r.bp.dia}` : '',
    r.hb ?? '',
    r.tempC ?? '',
    [r.gestWeeks != null && `${r.gestWeeks} wk`, r.babyAgeDays != null && `baby ${r.babyAgeDays} d`, r.respRate != null && `breaths ${r.respRate}/min`, r.ifaGiven && 'IFA'].filter(Boolean).join('; '),
    (r.vaccinesGiven || []).join(', '),
    (r.vaccinesDue || []).join(', '),
    (r.dangerSigns || []).map(label).join(', '),
    !r.referToPHC ? '' : r.referralOutcome === 'reached' ? words.reached : r.referralOutcome === 'not_reached' ? words.notYet : words.yes,
    r.nextVisit || '',
  ].map(String));
}

// CSV that opens correctly in Excel (UTF-8 BOM for Indic scripts). A cell that starts like a
// formula is prefixed with ' so a spreadsheet shows it as text instead of running it.
export function toCsv(header, rows) {
  const cell = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return `﻿${[header, ...rows].map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

function countByType(records) {
  const byType = { ANC: 0, PNC: 0, HBNC: 0, IMM: 0 };
  for (const r of records) if (r.visitType in byType) byType[r.visitType]++;
  return byType;
}

// Counts only, for a review screen: no names, no per-worker scores, no location.
// `month` is the calendar month of todayIso: the activities an ASHA lists on her monthly
// incentive claim (visits by type, doses given, referrals). Amounts differ by state, so none
// are shown. `timing` is how long recording took, from her first word to the save.
export function summarize(records, todayIso) {
  const fu = followupsFrom(records, todayIso);
  const month = records.filter((r) => (r.visitDate || '').slice(0, 7) === todayIso.slice(0, 7));
  const timed = records.map((r) => r.recordSeconds).filter((s) => typeof s === 'number' && s > 0);
  const total = timed.reduce((a, b) => a + b, 0);
  const measured = records.map((r) => r.dataBytes).filter((b) => typeof b === 'number' && b > 0);
  const bytes = measured.reduce((a, b) => a + b, 0);
  return {
    visits: records.length,
    byType: countByType(records),
    referrals: records.filter((r) => r.referToPHC).length,
    reachedPHC: records.filter((r) => r.referToPHC && r.referralOutcome === 'reached').length,
    overdue: fu.filter((x) => x.status === 'overdue').length,
    dueSoon: fu.filter((x) => x.status === 'today' || x.status === 'soon').length,
    newPeople: records.filter((r) => r.isNew).length,
    month: {
      key: todayIso.slice(0, 7),
      visits: month.length,
      byType: countByType(month),
      dosesGiven: month.reduce((n, r) => n + (r.vaccinesGiven || []).length, 0),
      referrals: month.filter((r) => r.referToPHC).length,
      reachedPHC: month.filter((r) => r.referToPHC && r.referralOutcome === 'reached').length,
    },
    timing: { visits: timed.length, avgSeconds: timed.length ? Math.round(total / timed.length) : null, totalSeconds: total },
    data: { visits: measured.length, avgBytes: measured.length ? Math.round(bytes / measured.length) : null, totalBytes: bytes },
  };
}
