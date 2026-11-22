// Dialogue manager for one home visit: dictate -> (ask missing) -> read back -> confirm/correct -> save.
// Pure logic, no I/O: the browser app and the test suite drive it the same way.
import { extract } from './nlu/parser.js';
import { numericDangers } from './nlu/danger.js';
import { vaccinesDueForChild, vaccinesDueInPregnancy, suggestNextVisit, ageDays, givenSoFar, vaccinationList, CHILD_SCHEDULE } from './nlu/schedule.js';
import { iso } from './nlu/dates.js';
import { phon, transliterate } from './nlu/translit.js';
import { t, dangersSpoken, vaccineSpoken, dateSpoken } from './i18n.js';

const ORDINAL = [
  [0, ['pehli', 'pahli', 'pehla', 'first', 'पहली', 'पहला', 'ಮೊದಲ', 'ಮೊದಲನೇ']],
  [1, ['dusri', 'doosri', 'dusra', 'second', 'दूसरी', 'दूसरा', 'ಎರಡನೇ']],
].map(([i, ws]) => [i, new Set(ws.map((w) => phon(transliterate(w).toLowerCase())))]);

// Weights outside these ranges are almost always a mis-hearing ("aath" for "dhai"), so the
// agent asks before saving instead of recording them silently.
const WEIGHT_RANGE = { newborn: [0.8, 6], child: [1.5, 30], pregnancy: [30, 150], postpartum: [30, 150] };

export function newForm() {
  return {
    visitId: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    beneficiary: null, beneficiaryId: null, name: null, isNew: false,
    visitType: null, visitTypeInferred: false,
    weightKg: null, weightNotTaken: false, bp: null, hb: null, tempC: null, respRate: null, gestWeeks: null, babyAgeDays: null,
    vaccinesGiven: [], vaccinesDueStated: [], vaccinesDueNone: false, vaccinesDueConfirmed: false, vaccinesDueUnknown: false,
    nextVisit: null, ifaGiven: null,
    textDangers: [], dangers: [], dangersAbsent: [],
    transcript: [], startedAt: Date.now(), heardAt: null,
  };
}

// true when the utterance carried no new field values (a bare "haan")
function x0(r) {
  return !r.fields.weightKg && !r.bareNumbers.length;
}

function resolveVaccine(base, dose, given) {
  const g = new Set(given.map((x) => x.toUpperCase()));
  if (base === 'BCG') return 'BCG';
  if (base === 'HepB') return 'HepB-0';
  if (base === 'Td') {
    if (dose === 'B') return 'Td-B';
    if (dose) return `Td-${dose}`;
    return g.has('TD-1') || g.has('TT-1') ? 'Td-2' : 'Td-1';
  }
  if (base === 'DPT') return 'DPT-B1';
  if (dose !== null && dose !== undefined) return `${base}-${dose}`;
  const codes = CHILD_SCHEDULE.map(([, c]) => c).filter((c) => c.split('-')[0] === base);
  return codes.find((c) => !g.has(c.toUpperCase())) || codes[codes.length - 1] || base;
}

export class VisitAgent {
  // `clock` (ms) times how long recording a visit takes; `now` is the calendar date.
  // `records` returns the visits saved on this phone (for history and the vaccine list).
  constructor({ lang = 'hi', registry = [], now = () => new Date(), followups = () => [], clock = () => Date.now(), records = () => [] } = {}) {
    this.lang = lang;
    this.registry = registry;
    this.now = now;
    this.clock = clock;
    this.getFollowups = followups;
    this.getRecords = records;
    this.reset();
  }

  // Earlier saved visits of the person in this visit, latest first (never the visit itself).
  priorVisits() {
    const f = this.form;
    if (!f.beneficiaryId) return [];
    // correcting an old visit: only what came before it counts
    const upTo = this.editing?.visitDate || '9999';
    return this.getRecords().filter((r) => r.beneficiaryId === f.beneficiaryId && r.visitId !== f.visitId && (r.visitDate || '') <= upTo)
      .sort((a, b) => (b.visitDate || '').localeCompare(a.visitDate || '') || (b.savedAt || '').localeCompare(a.savedAt || ''));
  }

  lastVisit() {
    return this.priorVisits()[0] || null;
  }

  // Register history plus every earlier saved visit.
  givenBefore() {
    return givenSoFar(this.form.beneficiary, this.priorVisits());
  }

  reset() {
    this.editing = null; // { visitDate, savedAt, recordSeconds } of a saved record being corrected
    this.form = newForm();
    this.state = 'dictate'; // dictate | ask | disambiguate | confirm | referralCheck
    // every visit opens with "whose home are you at?", so a bare name answers it
    this.expect = 'beneficiary';
    this.pendingMatches = null;
    this.pendingWeight = null;
    this.pendingReferral = null;
    this.lastPrompt = null;
  }

  // Start a visit of a chosen kind (pregnancy / newborn buttons), optionally for a known person.
  startVisit(visitType = null, person = null) {
    this.reset();
    if (visitType) { this.form.visitType = visitType; this.form.visitTypeInferred = false; }
    if (person) {
      const b = person.beneficiaryId && this.registry.find((p) => p.id === person.beneficiaryId);
      if (b) {
        const keep = this.form.visitType;
        this.setBeneficiary(b, []);
        if (keep) { this.form.visitType = keep; this.form.visitTypeInferred = false; }
      } else { this.form.beneficiaryId = person.beneficiaryId || null; this.form.name = person.name || null; this.form.isNew = true; }
    }
    return this.form;
  }

  // Reopen a saved record for correction. Saving again overwrites it (same visitId) and keeps
  // its original visit date.
  edit(rec) {
    this.reset();
    const f = this.form;
    const b = rec.beneficiaryId && !rec.isNew ? this.registry.find((p) => p.id === rec.beneficiaryId) : null;
    Object.assign(f, {
      visitId: rec.visitId, beneficiary: b || null, beneficiaryId: rec.beneficiaryId ?? null, name: rec.name ?? null, isNew: Boolean(rec.isNew),
      visitType: rec.visitType ?? null, weightKg: rec.weightKg ?? null, weightNotTaken: Boolean(rec.weightNotTaken), bp: rec.bp ?? null, hb: rec.hb ?? null, tempC: rec.tempC ?? null,
      respRate: rec.respRate ?? null, gestWeeks: rec.gestWeeks ?? null, babyAgeDays: rec.babyAgeDays ?? null, ifaGiven: rec.ifaGiven ?? null,
      vaccinesGiven: [...(rec.vaccinesGiven || [])], nextVisit: rec.nextVisit ?? null, transcript: [...(rec.transcript || [])],
      dangersAbsent: [...(rec.dangerSignsDenied || [])],
    });
    // Signs that came from a number (BP, Hb, temperature) are recomputed, so correcting the
    // number clears them; signs from her words stay until she says otherwise.
    const fromNumbers = numericDangers(f, this.group());
    f.textDangers = (rec.dangerSigns || []).filter((d) => !fromNumbers.includes(d));
    this.updateDangers({ dangers: { present: [] } });
    if (this.vaccinesDue() === null) {
      f.vaccinesDueStated = [...(rec.vaccinesDue || [])];
      if (rec.vaccinesDueUnknown) f.vaccinesDueUnknown = true;
      else if (!f.vaccinesDueStated.length) f.vaccinesDueNone = true;
    }
    this.editing = { visitDate: rec.visitDate, savedAt: rec.savedAt, recordSeconds: rec.recordSeconds ?? null, dataBytes: rec.dataBytes ?? null };
    this.state = 'confirm';
    this.expect = null;
    return f;
  }

  // Resume an unfinished visit saved as a draft.
  restore(draft) {
    this.reset();
    if (!draft?.form) return;
    this.form = { ...newForm(), ...draft.form };
    this.editing = draft.editing || null;
    this.state = 'dictate';
    this.expect = this.form.beneficiaryId || this.form.name ? null : 'beneficiary';
  }

  snapshot() {
    return { form: this.form, editing: this.editing };
  }

  // true once anything was heard or filled in
  get dirty() {
    const f = this.form;
    return Boolean(f.transcript.length || f.beneficiaryId || f.name || f.weightKg !== null || f.nextVisit || f.dangers.length);
  }

  get L() {
    return t(this.lang);
  }

  greet() {
    return this.out([this.L.greet]);
  }

  // The question the visit is waiting on, as she would hear it; with `hint`, followed by an
  // example answer ("for example: fifty kilo").
  question(hint = false) {
    const L = this.L;
    if (this.state === 'confirm') return [L.confirmQ, hint ? L.hint.confirm : null].filter(Boolean);
    if (this.expect === 'weightCheck' || this.expect === 'yesno' || this.state === 'disambiguate') return this.lastPrompt || [L.notUnderstood];
    const field = this.expect && L.hint[this.expect] ? this.expect : this.missing()[0];
    if (!field) return [L.confirmQ];
    return [this.askFor(field), hint ? L.hint[field] : null].filter(Boolean);
  }

  out(say, extra = {}) {
    // the visit saved when she moved on to the next house goes out with this turn's reply
    const moved = this.movedOn;
    this.movedOn = null;
    const text = [moved?.say, ...say].filter(Boolean);
    if (text.length) this.lastPrompt = text;
    return { say: text, state: this.state, expect: this.expect, form: this.form, due: this.vaccinesDue(), missing: this.missing(), ...(moved ? { saved: moved.rec } : {}), ...extra };
  }

  // Anything recorded beyond who she is and the visit type.
  hasData() {
    const f = this.form;
    return f.weightKg !== null || f.weightNotTaken || Boolean(f.bp) || f.hb !== null || f.tempC !== null || f.respRate !== null
      || f.gestWeeks !== null || f.babyAgeDays !== null || Boolean(f.nextVisit) || f.vaccinesGiven.length > 0 || f.vaccinesDueStated.length > 0 || f.dangers.length > 0;
  }

  group() {
    const f = this.form;
    if (f.visitType === 'ANC') return 'pregnancy';
    if (f.visitType === 'PNC') return 'postpartum';
    if (f.visitType === 'HBNC') return 'newborn';
    const age = f.babyAgeDays ?? ageDays(f.beneficiary, this.now());
    if (age !== null && age <= 60) return 'newborn';
    if (f.beneficiary?.kind === 'pregnant') return 'pregnancy';
    if (!f.beneficiary && !f.visitType && f.babyAgeDays === null) return 'unknown';
    return 'child';
  }

  // Vaccines due: protocol table + anything she said is due, minus what was given today.
  // null = unknown (we must ask), [] = none due.
  vaccinesDue() {
    const f = this.form;
    const b = f.beneficiary;
    const today = this.now();
    const before = this.givenBefore();
    const givenAll = [...before.given, ...f.vaccinesGiven];
    let sched = null;
    const g = this.group();
    if (g === 'pregnancy') {
      const td1 = f.vaccinesGiven.some((v) => /^T[DT]-1$/i.test(v)) ? today : before.td1Date;
      if (b || f.vaccinesGiven.length || f.gestWeeks || before.given.length) sched = vaccinesDueInPregnancy(givenAll, td1, today);
    } else {
      const age = f.babyAgeDays ?? ageDays(b, today);
      if (age !== null) sched = vaccinesDueForChild(age, givenAll);
    }
    if (sched === null && !f.vaccinesDueStated.length && !f.vaccinesDueNone && !f.vaccinesDueConfirmed && !f.vaccinesDueUnknown) return null;
    const given = new Set(f.vaccinesGiven.map((v) => v.toUpperCase()));
    const out = [];
    for (const v of [...f.vaccinesDueStated, ...(f.vaccinesDueNone ? [] : sched || [])]) {
      if (!given.has(v.toUpperCase()) && !out.includes(v)) out.push(v);
    }
    return out;
  }

  plausibleWeight(kg) {
    if (kg === null || kg === undefined) return true;
    const [lo, hi] = WEIGHT_RANGE[this.group()] || [0.5, 150];
    return kg >= lo && kg <= hi;
  }

  suggestion() {
    const f = this.form;
    if (!f.visitType) return null;
    return suggestNextVisit(f.beneficiary, f.visitType, this.now());
  }

  missing() {
    const f = this.form;
    const m = [];
    if (!f.beneficiaryId && !f.name) m.push('beneficiary');
    if (!f.visitType) m.push('visitType');
    if (f.weightKg === null && !f.weightNotTaken) m.push('weightKg');
    if (this.vaccinesDue() === null) m.push('vaccinesDue');
    if (!f.nextVisit) m.push('nextVisit');
    return m;
  }

  askFor(field) {
    const L = this.L;
    this.expect = field;
    switch (field) {
      case 'beneficiary': return L.askBeneficiary;
      case 'visitType': return L.askVisitType;
      case 'weightKg': return L.askWeight;
      case 'vaccinesDue': return L.askVaccinesDue;
      case 'nextVisit': {
        const s = this.suggestion();
        return L.askNextVisit(s ? dateSpoken(s, this.lang) : null);
      }
      default: return null;
    }
  }

  setBeneficiary(b, changed) {
    const f = this.form;
    if (f.beneficiary?.id === b.id) return;
    f.beneficiary = b;
    f.beneficiaryId = b.id;
    f.name = b.name;
    f.isNew = false;
    if (!f.visitType || f.visitTypeInferred) { f.visitType = b.defaultVisit; f.visitTypeInferred = true; }
    changed.push('beneficiary');
  }

  narrow(matches, r) {
    let list = matches;
    if (r.fields.ward !== undefined) {
      const byWard = list.filter((b) => b.ward === r.fields.ward);
      if (byWard.length) list = byWard;
    }
    const keys = new Set(r.tokens.map((x) => x.key));
    const byHusband = list.filter((b) => keys.has(phon(b.husband.toLowerCase())));
    if (byHusband.length) list = byHusband;
    for (const [i, set] of ORDINAL) {
      if (r.tokens.some((x) => set.has(x.key)) && this.pendingMatches?.[i]) return [this.pendingMatches[i]];
    }
    return list.length ? list : matches;
  }

  applyFields(r, changed) {
    const f = this.form;
    const x = r.fields;
    // beneficiary
    if (x.beneficiaryId) {
      const b = this.registry.find((p) => p.id === x.beneficiaryId);
      if (b) { this.setBeneficiary(b, changed); this.pendingMatches = null; } else if (f.beneficiary && !r.intent.newVisit) {
        // A registered person is already set and this ID is not in the register: far more
        // likely a mis-heard number (noise, echo) than a new person. Keep her and ask again.
        this.unknownId = x.beneficiaryId;
      } else if (f.beneficiaryId !== x.beneficiaryId) {
        f.beneficiary = null; f.beneficiaryId = x.beneficiaryId; f.isNew = true; changed.push('beneficiary');
      }
    } else if (x.beneficiaryMatches && f.beneficiary && !x.beneficiaryMatches.some((b) => b.id === f.beneficiary.id) && !r.intent.no && !r.intent.newVisit) {
      // A different name alone (no ID, no "nahi/galat") once the person is known is far more
      // often room chatter picked up by STT than a real change: keep the person. A real
      // change is said as "nahi, Sunita Devi" or with the ID.
      this.heardChatter = true;
    } else if (x.beneficiaryMatches) {
      const cand = this.narrow(x.beneficiaryMatches, r);
      if (cand.length === 1) { this.setBeneficiary(cand[0], changed); this.pendingMatches = null; } else if (!f.beneficiary || !cand.some((b) => b.id === f.beneficiary.id)) {
        this.pendingMatches = cand;
      }
    } else if (x.rawName && !f.beneficiary) {
      f.name = x.rawName; f.isNew = true; changed.push('beneficiary');
    } else if (this.state === 'disambiguate' && this.pendingMatches) {
      const cand = this.narrow(this.pendingMatches, r);
      if (cand.length === 1) { this.setBeneficiary(cand[0], changed); this.pendingMatches = null; }
    }

    if (x.visitType && x.visitType !== f.visitType) { f.visitType = x.visitType; f.visitTypeInferred = false; changed.push('visitType'); }
    for (const k of ['weightKg', 'hb', 'tempC', 'respRate', 'gestWeeks', 'babyAgeDays', 'ifaGiven', 'nextVisit']) {
      if (x[k] !== undefined && x[k] !== f[k]) { f[k] = x[k]; changed.push(k); }
    }
    if (x.bp && (!f.bp || f.bp.sys !== x.bp.sys || f.bp.dia !== x.bp.dia)) { f.bp = x.bp; changed.push('bp'); }
    if (x.weightKg !== undefined) f.weightNotTaken = false;
    if (x.vaccines) f.vaccinesDueUnknown = false;

    if (x.vaccines) {
      const givenAll = [...this.givenBefore().given, ...f.vaccinesGiven];
      for (const v of x.vaccines) {
        const code = resolveVaccine(v.base, v.dose, v.status === 'given' ? givenAll : [...givenAll]);
        if (v.status === 'given') {
          if (!f.vaccinesGiven.includes(code)) f.vaccinesGiven.push(code);
          f.vaccinesDueStated = f.vaccinesDueStated.filter((c) => c !== code);
        } else if (!f.vaccinesDueStated.includes(code)) {
          f.vaccinesDueStated.push(code);
        }
        f.vaccinesDueNone = false;
      }
      changed.push('vaccines');
    }

    // answers to a direct question, where the value comes without its keyword
    const bare = r.bareNumbers;
    if ((this.expect === 'weightKg' || this.expect === 'weightCheck') && x.weightKg === undefined && bare.length) {
      const n = bare[bare.length - 1];
      const kg = n.unit === 'g' || n.value >= 500 ? n.value / 1000 : n.value;
      if (kg > 0 && kg < 150) { f.weightKg = kg; f.weightNotTaken = false; changed.push('weightKg'); }
    }
    // "wajan nahi liya" / "machine nahi thi": weight not measured at this visit
    const aboutWeight = this.expect === 'weightKg' || r.mentions.includes('weightKg');
    if (aboutWeight && x.weightKg === undefined && !bare.length && (r.intent.skip || (this.expect === 'weightKg' && (r.intent.unknown || (r.intent.no && !r.intent.yes))))) {
      if (f.weightKg !== null || !f.weightNotTaken) { f.weightKg = null; f.weightNotTaken = true; changed.push('weightKg'); }
    }
    if (this.expect === 'beneficiary' && !x.beneficiaryId && bare.length && bare[0].digitString) {
      const b = this.registry.find((p) => p.id === bare[0].digitString);
      if (b) this.setBeneficiary(b, changed);
    }
    if (this.expect === 'nextVisit' && !x.nextVisit) {
      if (r.anyDate) { f.nextVisit = r.anyDate; changed.push('nextVisit'); } else if (r.intent.yes && this.suggestion()) { f.nextVisit = this.suggestion(); changed.push('nextVisit'); }
    }
    if (this.expect === 'vaccinesDue' && !x.vaccines) {
      // "pata nahi" is not "none due": it is recorded as not known
      if (r.intent.unknown) { f.vaccinesDueUnknown = true; f.vaccinesDueNone = false; f.vaccinesDueStated = []; changed.push('vaccines'); } else if (r.intent.none || (r.intent.no && !r.intent.yes)) { f.vaccinesDueNone = true; f.vaccinesDueUnknown = false; f.vaccinesDueStated = []; changed.push('vaccines'); } else if (r.intent.yes) { f.vaccinesDueConfirmed = true; changed.push('vaccines'); }
    }
    if (this.expect === 'visitType' && !x.visitType && f.visitType && r.intent.yes) changed.push('visitType');

    // explicit "no X" for a sign recorded earlier, only when correcting the read-back
    for (const id of r.dangers.absent) {
      if (!f.dangersAbsent.includes(id)) f.dangersAbsent.push(id);
      if (this.state === 'confirm' && r.intent.no && f.textDangers.includes(id)) {
        f.textDangers = f.textDangers.filter((d) => d !== id);
        changed.push('dangers');
      }
    }
  }

  updateDangers(r) {
    const f = this.form;
    for (const id of r.dangers.present) if (!f.textDangers.includes(id)) f.textDangers.push(id);
    const all = [...new Set([...f.textDangers, ...numericDangers(f, this.group())])];
    const fresh = all.filter((id) => !f.dangers.includes(id));
    f.dangers = all;
    f.dangersAbsent = f.dangersAbsent.filter((id) => !all.includes(id));
    return fresh;
  }

  part(field) {
    const f = this.form;
    const L = this.L;
    const lang = this.lang;
    switch (field) {
      case 'beneficiary': {
        const nm = f.beneficiary ? ((lang === 'hi' || lang === 'mr') ? f.beneficiary.nameHi : lang === 'kn' ? f.beneficiary.nameKn : null) || f.beneficiary.name : f.name;
        return [nm, f.beneficiaryId ? L.idPart(f.beneficiaryId) : null].filter(Boolean).join(', ');
      }
      case 'visitType': return f.visitType ? L.visitPart(f.visitType) : null;
      case 'weightKg': {
        if (f.weightKg === null) return f.weightNotTaken ? L.weightNotTaken : null;
        // the last saved weight, said alongside, so a mis-hearing or a real change stands out
        const last = this.lastVisit();
        return last?.weightKg != null ? `${L.weightPart(f.weightKg)}, ${L.lastWeight(last.weightKg, dateSpoken(last.visitDate, lang))}` : L.weightPart(f.weightKg);
      }
      case 'bp': return f.bp ? L.bpPart(f.bp) : null;
      case 'hb': return f.hb !== null ? L.hbPart(f.hb) : null;
      case 'tempC': return f.tempC !== null ? L.tempPart(f.tempC) : null;
      case 'vaccines': {
        const parts = [];
        if (f.vaccinesGiven.length) parts.push(L.givenPart(f.vaccinesGiven.map((v) => vaccineSpoken(v, lang))));
        const due = this.vaccinesDue();
        // "don't know" is said as such, never as "no vaccine due"
        if (due && !due.length && f.vaccinesDueUnknown) parts.push(L.dueUnknown);
        else if (due) parts.push(L.duePart(due.map((v) => vaccineSpoken(v, lang))));
        return parts.join(lang === 'hi' ? '। ' : '. ');
      }
      case 'nextVisit': return f.nextVisit ? L.nextPart(dateSpoken(f.nextVisit, lang)) : null;
      case 'dangers': return f.dangers.length ? L.dangerPart(dangersSpoken(f.dangers, lang)) : null;
      default: return null;
    }
  }

  readback() {
    const sep = this.lang === 'hi' ? '। ' : '. ';
    const fields = ['beneficiary', 'visitType', 'weightKg', 'bp', 'hb', 'tempC', 'vaccines', 'nextVisit', 'dangers'];
    const body = fields.map((k) => this.part(k)).filter(Boolean).join(sep);
    this.state = 'confirm';
    this.expect = null;
    return `${this.L.readIntro} ${body}${sep}${this.L.confirmQ}`;
  }

  describe(changed) {
    const map = { gestWeeks: null, babyAgeDays: null, respRate: null, ifaGiven: null };
    const keys = [...new Set(changed.map((c) => (c in map ? null : c)).filter(Boolean))];
    return keys.map((k) => this.part(k)).filter(Boolean).join(this.lang === 'hi' ? '। ' : '. ');
  }

  // Build the record that gets saved.
  record() {
    const f = this.form;
    return {
      visitId: f.visitId,
      beneficiaryId: f.beneficiaryId,
      name: f.name,
      isNew: f.isNew,
      ward: f.beneficiary?.ward ?? null,
      visitType: f.visitType,
      weightKg: f.weightKg,
      weightNotTaken: f.weightKg === null && f.weightNotTaken,
      bp: f.bp, hb: f.hb, tempC: f.tempC, respRate: f.respRate, gestWeeks: f.gestWeeks, babyAgeDays: f.babyAgeDays,
      ifaGiven: f.ifaGiven,
      vaccinesGiven: f.vaccinesGiven,
      vaccinesDue: this.vaccinesDue() || [],
      vaccinesDueUnknown: f.vaccinesDueUnknown && !f.vaccinesDueStated.length,
      nextVisit: f.nextVisit,
      dangerSigns: f.dangers,
      dangerSignsDenied: f.dangersAbsent,
      referToPHC: f.dangers.length > 0,
      transcript: f.transcript,
      // from her first word to the save; a correction keeps the original time
      recordSeconds: this.editing ? this.editing.recordSeconds : f.heardAt ? Math.max(1, Math.round((this.clock() - f.heardAt) / 1000)) : null,
      turns: f.transcript.length,
      // measured by the app on the voice connection; a correction keeps the original figure
      dataBytes: this.editing ? this.editing.dataBytes : null,
      lang: this.lang,
      visitDate: this.editing?.visitDate || iso(this.now()),
      savedAt: this.editing?.savedAt || new Date().toISOString(),
      updatedAt: this.editing ? new Date().toISOString() : null,
    };
  }

  // Merge fields from the optional LLM extractor: fills gaps only, never overwrites,
  // and danger signs can only be added.
  applyExternal(x) {
    const f = this.form;
    const changed = [];
    if (x.visitType && !f.visitType) { f.visitType = x.visitType; changed.push('visitType'); }
    if (typeof x.weightKg === 'number' && f.weightKg === null) { f.weightKg = x.weightKg; changed.push('weightKg'); }
    if (x.nextVisit && !f.nextVisit) { f.nextVisit = x.nextVisit; changed.push('nextVisit'); }
    if (x.beneficiaryId && !f.beneficiaryId) {
      const b = this.registry.find((p) => p.id === x.beneficiaryId);
      if (b) this.setBeneficiary(b, changed);
    }
    const fresh = this.updateDangers({ dangers: { present: x.dangerSigns || [] } });
    return { changed, fresh };
  }

  handle(text, meta = {}) {
    const L = this.L;
    const now = this.now();
    const r = extract(text, { now, registry: this.registry, expect: this.expect, lang: this.lang });
    // Another registered person's ID, not said as a correction ("nahi, 1043"), while this
    // visit already holds data: she has moved on to the next house. Save this visit as it
    // stands, so its danger signs and referral stay with this person, and start a clean one.
    this.movedOn = null;
    const other = r.fields.beneficiaryId && this.registry.find((p) => p.id === r.fields.beneficiaryId);
    const cur = this.form.beneficiary;
    if (other && cur && other.id !== cur.id && !r.intent.no && !this.editing && this.state !== 'disambiguate' && this.hasData()) {
      const rec = this.record();
      this.reset();
      this.movedOn = { rec, say: L.savedEarlier(cur, rec.referToPHC) };
    }
    const f = this.form;
    const wasDirty = this.dirty;
    const heardBefore = f.heardAt;
    // `meta.heard`: her own words, when `text` is the language model's reading of them
    f.transcript.push(meta.heard || text);
    const say = [];
    const changed = [];
    // Nothing usable in what she said. Ask the open question again with an example answer
    // (never a bare "say it again"), and take the words back out of the note so the app can
    // try the language model on them.
    const unclear = (extra) => {
      f.transcript.pop();
      if (!heardBefore) f.heardAt = null;
      return this.out([...say, ...this.question(true)], { ...extra, unclear: true });
    };

    if (r.intent.cancel) {
      this.reset();
      return this.out([L.cancelled], { reset: true });
    }
    // "Did she reach the PHC?" A plain yes or no closes the question; anything else is
    // treated as the start of a visit note.
    if (this.state === 'referralCheck') {
      const ref = this.pendingReferral;
      this.pendingReferral = null;
      this.state = 'dictate';
      this.expect = null;
      const answer = r.intent.no ? 'not_reached' : r.intent.yes ? 'reached' : null;
      if (ref && answer && x0(r) && !r.dangers.present.length) {
        f.transcript.pop();
        const say1 = answer === 'reached' ? L.reachedNoted(ref.name) : L.notReachedNoted(ref.name);
        return this.out([say1], { referralOutcome: { visitId: ref.visitId, outcome: answer, checkedOn: iso(now) } });
      }
    }
    if (r.intent.vaccineList) {
      if (!wasDirty) f.transcript.pop();
      const groups = vaccinationList(this.registry, this.getRecords(), now);
      const items = groups.slice(0, 4).map((g) => L.vaccineGroup(vaccineSpoken(g.code, this.lang), g.people.map((p) => p.name || p.id)));
      return this.out([L.vaccineList(items, Math.max(0, groups.length - 4))]);
    }
    if (r.intent.followups) {
      // asking for the list is not part of a visit note
      if (!wasDirty) f.transcript.pop();
      const fu = this.getFollowups();
      const items = fu.slice(0, 3).map((x) => L.followItem({ ...x, when: x.when === iso(now) ? L.today : dateSpoken(x.when, this.lang) }));
      const say0 = [L.followups(items)];
      // Referral follow-through: ask about the first referral still waiting for an answer,
      // but never in the middle of a visit.
      const check = !wasDirty && fu.find((x) => x.checkDue);
      if (check) {
        this.pendingReferral = check;
        this.state = 'referralCheck';
        this.expect = 'yesno';
        say0.push(L.askReached(check.name || L.none, dateSpoken(check.referredOn, this.lang)));
      }
      return this.out(say0);
    }
    // A greeting, "shuru karo" or "kya bolna hai" is talk to the assistant, not a note: answer
    // with how this works and the question it is waiting on.
    const talk = (r.intent.greet || r.intent.start || r.intent.help) && !Object.keys(r.fields).length && !r.dangers.present.length;
    if (talk && !(this.state === 'confirm' && r.intent.yes && !r.intent.help)) {
      f.transcript.pop();
      return this.out([r.intent.help || !wasDirty ? L.help : null, ...this.question(Boolean(r.intent.help))]);
    }
    if (!f.heardAt) f.heardAt = this.clock();
    if (r.intent.newVisit && Object.keys(r.fields).length === 0) {
      this.reset();
      return this.out([L.newVisit], { reset: true });
    }
    if (r.intent.repeat && Object.keys(r.fields).length === 0) {
      if (this.state === 'confirm') return this.out([this.readback()]);
      return this.out(this.lastPrompt || [L.notUnderstood]);
    }

    const wasState = this.state;
    const prevWeight = f.weightKg;
    if (this.expect === 'weightCheck' && r.intent.yes && x0(r) && this.pendingWeight !== null) {
      f.weightKg = this.pendingWeight;
      this.pendingWeight = null;
      this.expect = null;
      changed.push('weightKg', 'weightChecked');
    }
    this.heardChatter = false;
    this.unknownId = null;
    this.applyFields(r, changed);
    if (this.unknownId) {
      this.state = 'ask';
      this.expect = 'beneficiary';
      return this.out([L.askCorrectId], { changed });
    }
    // nothing but a stray name from the room: stay quiet rather than answer the chatter
    if (this.heardChatter && !changed.length && !r.dangers.present.length && !Object.keys(r.intent).length) {
      f.transcript.pop();
      if (!f.transcript.length) f.heardAt = null;
      return this.out([], { changed });
    }
    if (changed.includes('weightKg') && !changed.includes('weightChecked') && !this.plausibleWeight(f.weightKg)) {
      this.pendingWeight = f.weightKg;
      f.weightKg = prevWeight;
      changed.splice(changed.indexOf('weightKg'), 1);
      this.state = 'ask';
      this.expect = 'weightCheck';
      const fresh0 = this.updateDangers(r);
      const pre = fresh0.length ? [L.alert(dangersSpoken(fresh0, this.lang))] : [];
      return this.out([...pre, L.checkWeight(this.pendingWeight, L.who[this.group()] || L.who.child)], { alert: fresh0.length > 0, changed });
    }
    if (changed.includes('weightKg')) this.pendingWeight = null;
    const fresh = this.updateDangers(r);
    let alert = false;
    if (fresh.length) { say.push(L.alert(dangersSpoken(fresh, this.lang))); alert = true; }
    if (r.intent.advice) say.push(L.refuse);

    if (this.pendingMatches && this.pendingMatches.length > 1) {
      this.state = 'disambiguate';
      this.expect = 'beneficiary';
      say.push(L.disambiguate(this.pendingMatches.map((b) => L.option(b))));
      return this.out(say, { alert, changed });
    }
    if (wasState === 'disambiguate' && changed.includes('beneficiary')) this.state = 'dictate';
    if (changed.includes('beneficiary') && f.isNew && f.name) say.push(L.newPerson(f.name));

    if (wasState === 'confirm') {
      if (changed.length) {
        say.push(L.fixed(this.describe(changed)));
        this.state = 'confirm';
        this.expect = null;
      } else if (r.intent.yes && !fresh.length && !r.intent.no) {
        const missing = this.missing();
        if (missing.length) {
          this.state = 'ask';
          say.push(this.askFor(missing[0]));
        } else {
          const rec = this.record();
          const follow = rec.nextVisit ? L.savedFollow(dateSpoken(rec.nextVisit, this.lang), rec.referToPHC) : '';
          this.reset();
          return this.out([...say, L.saved(follow)], { saved: rec, alert });
        }
      } else if (r.intent.no) {
        const m = r.mentions[0];
        if (m === 'weightKg') { this.expect = 'weightKg'; say.push(L.askCorrectWeight); } else if (m === 'nextVisit') { this.expect = 'nextVisit'; say.push(L.askCorrectDate); } else if (m === 'beneficiaryId') { this.expect = 'beneficiary'; say.push(L.askCorrectId); } else say.push(L.whatWrong);
      } else if (fresh.length || r.intent.advice) {
        say.push(L.confirmQ);
      } else if (!r.empty || r.tokens.length > 1) {
        return unclear({ alert, changed });
      }
      return this.out(say, { alert, changed });
    }

    // dictate / ask / disambiguate
    const missing = this.missing();
    const progressed = changed.length > 0;
    if (r.intent.done || (missing.length === 0 && progressed)) {
      if (missing.length) {
        this.state = 'ask';
        say.push(this.askFor(missing[0]));
      } else {
        say.push(this.readback());
      }
      return this.out(say, { alert, changed });
    }
    if (progressed) {
      this.state = 'ask';
      say.push(this.askFor(missing[0]));
      // the question can wait a moment in case she keeps talking; alerts never wait
      return this.out(say, { alert, changed, deferrable: !alert && !r.intent.advice });
    }
    if (!say.length && !r.dangers.absent.length && (r.tokens.length > 1 || (this.expect && r.tokens.length > 0))) return unclear({ alert, changed });
    return this.out(say, { alert, changed });
  }
}
