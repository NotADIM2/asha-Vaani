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

export async function saveRecord(rec) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await key(), new TextEncoder().encode(JSON.stringify(rec)));
  await req((await store('records', 'readwrite')).put({ id: rec.visitId, iv, data, expiresAt: Date.now() + retentionDays() * DAY }));
}

export async function listRecords() {
  await purgeExpired();
  const rows = await req((await store('records')).getAll());
  const k = await key();
  const out = [];
  for (const row of rows) {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: row.iv }, k, row.data);
      out.push(JSON.parse(new TextDecoder().decode(plain)));
    } catch { /* undecryptable rows are skipped */ }
  }
  return out.sort((a, b) => (b.savedAt || '').localeCompare(a.savedAt || ''));
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

// Follow-up list: referrals first (due today), then upcoming visits by date.
export function followupsFrom(records, todayIso) {
  const latest = new Map();
  for (const r of records) {
    const k = r.beneficiaryId || r.name;
    if (!latest.has(k)) latest.set(k, r);
  }
  return [...latest.values()]
    .filter((r) => r.nextVisit || r.referToPHC)
    .map((r) => ({
      name: r.name,
      beneficiaryId: r.beneficiaryId,
      refer: r.referToPHC,
      dangerSigns: r.dangerSigns,
      when: r.referToPHC ? todayIso : r.nextVisit,
      nextVisit: r.nextVisit,
      vaccinesDue: r.vaccinesDue,
      visitType: r.visitType,
    }))
    .sort((a, b) => (b.refer - a.refer) || a.when.localeCompare(b.when));
}
