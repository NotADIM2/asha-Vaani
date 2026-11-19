// Dialogue manager for one home visit: dictate -> (ask missing) -> read back -> confirm/correct -> save.
// Pure logic, no I/O: the browser app and the test suite drive it the same way.
import { extract } from './nlu/parser.js';
import { numericDangers } from './nlu/danger.js';
import { vaccinesDueForChild, vaccinesDueInPregnancy, suggestNextVisit, ageDays, CHILD_SCHEDULE } from './nlu/schedule.js';
import { iso } from './nlu/dates.js';
import { phon, transliterate } from './nlu/translit.js';
import { t, dangersSpoken, vaccineSpoken, dateSpoken } from './i18n.js';

const ORDINAL = [
  [0, ['pehli', 'pahli', 'pehla', 'first', 'पहली', 'पहला', 'ಮೊದಲ', 'ಮೊದಲನೇ']],
  [1, ['dusri', 'doosri', 'dusra', 'second', 'दूसरी', 'दूसरा', 'ಎರಡನೇ']],
].map(([i, ws]) => [i, new Set(ws.map((w) => phon(transliterate(w).toLowerCase())))]);

export function newForm() {
  return {
    visitId: `v${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    beneficiary: null, beneficiaryId: null, name: null, isNew: false,
    visitType: null, visitTypeInferred: false,
    weightKg: null, bp: null, hb: null, tempC: null, respRate: null, gestWeeks: null, babyAgeDays: null,
    vaccinesGiven: [], vaccinesDueStated: [], vaccinesDueNone: false, vaccinesDueConfirmed: false,
    nextVisit: null, ifaGiven: null,
    textDangers: [], dangers: [], dangersAbsent: [],
    transcript: [], startedAt: Date.now(),
  };
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
  constructor({ lang = 'hi', registry = [], now = () => new Date(), followups = () => [] } = {}) {
    this.lang = lang;
    this.registry = registry;
    this.now = now;
    this.getFollowups = followups;
    this.reset();
  }

  reset() {
    this.form = newForm();
    this.state = 'dictate'; // dictate | ask | disambiguate | confirm
    this.expect = null;
    this.pendingMatches = null;
    this.lastPrompt = null;
  }

  get L() {
    return t(this.lang);
  }

  greet() {
    return this.out([this.L.greet]);
  }

  out(say, extra = {}) {
    const text = say.filter(Boolean);
    if (text.length) this.lastPrompt = text;
    return { say: text, state: this.state, expect: this.expect, form: this.form, due: this.vaccinesDue(), missing: this.missing(), ...extra };
  }

  group() {
    const f = this.form;
    if (f.visitType === 'ANC') return 'pregnancy';
    if (f.visitType === 'PNC') return 'postpartum';
    if (f.visitType === 'HBNC') return 'newborn';
    const age = f.babyAgeDays ?? ageDays(f.beneficiary, this.now());
    if (age !== null && age <= 60) return 'newborn';
    if (f.beneficiary?.kind === 'pregnant') return 'pregnancy';
    return 'child';
  }

  // Vaccines due: protocol table + anything she said is due, minus what was given today.
  // null = unknown (we must ask), [] = none due.
  vaccinesDue() {
    const f = this.form;
    const b = f.beneficiary;
    const today = this.now();
    const givenAll = [...(b?.vaccinesGiven || []), ...f.vaccinesGiven];
    let sched = null;
    const g = this.group();
    if (g === 'pregnancy') {
      const td1 = f.vaccinesGiven.some((v) => /^T[DT]-1$/i.test(v)) ? today : b?.td1Date || null;
      if (b || f.vaccinesGiven.length || f.gestWeeks) sched = vaccinesDueInPregnancy(givenAll, td1, today);
    } else {
      const age = f.babyAgeDays ?? ageDays(b, today);
      if (age !== null) sched = vaccinesDueForChild(age, givenAll);
    }
    if (sched === null && !f.vaccinesDueStated.length && !f.vaccinesDueNone && !f.vaccinesDueConfirmed) return null;
    const given = new Set(f.vaccinesGiven.map((v) => v.toUpperCase()));
    const out = [];
    for (const v of [...f.vaccinesDueStated, ...(f.vaccinesDueNone ? [] : sched || [])]) {
      if (!given.has(v.toUpperCase()) && !out.includes(v)) out.push(v);
    }
    return out;
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
    if (f.weightKg === null) m.push('weightKg');
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
      if (b) { this.setBeneficiary(b, changed); this.pendingMatches = null; } else if (f.beneficiaryId !== x.beneficiaryId) {
        f.beneficiary = null; f.beneficiaryId = x.beneficiaryId; f.isNew = true; changed.push('beneficiary');
      }
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

    if (x.vaccines) {
      const givenAll = [...(f.beneficiary?.vaccinesGiven || []), ...f.vaccinesGiven];
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
    if (this.expect === 'weightKg' && x.weightKg === undefined && bare.length) {
      const n = bare[bare.length - 1];
      const kg = n.unit === 'g' || n.value >= 500 ? n.value / 1000 : n.value;
      if (kg > 0 && kg < 150) { f.weightKg = kg; changed.push('weightKg'); }
    }
    if (this.expect === 'beneficiary' && !x.beneficiaryId && bare.length && bare[0].digitString) {
      const b = this.registry.find((p) => p.id === bare[0].digitString);
      if (b) this.setBeneficiary(b, changed);
    }
    if (this.expect === 'nextVisit' && !x.nextVisit) {
      if (r.anyDate) { f.nextVisit = r.anyDate; changed.push('nextVisit'); } else if (r.intent.yes && this.suggestion()) { f.nextVisit = this.suggestion(); changed.push('nextVisit'); }
    }
    if (this.expect === 'vaccinesDue' && !x.vaccines) {
      if (r.intent.none || (r.intent.no && !r.intent.yes)) { f.vaccinesDueNone = true; f.vaccinesDueStated = []; changed.push('vaccines'); } else if (r.intent.yes) { f.vaccinesDueConfirmed = true; changed.push('vaccines'); }
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
        const nm = f.beneficiary ? (lang === 'hi' ? f.beneficiary.nameHi : lang === 'kn' ? f.beneficiary.nameKn : null) || f.beneficiary.name : f.name;
        return [nm, f.beneficiaryId ? L.idPart(f.beneficiaryId) : null].filter(Boolean).join(', ');
      }
      case 'visitType': return f.visitType ? L.visitPart(f.visitType) : null;
      case 'weightKg': return f.weightKg !== null ? L.weightPart(f.weightKg) : null;
      case 'bp': return f.bp ? L.bpPart(f.bp) : null;
      case 'hb': return f.hb !== null ? L.hbPart(f.hb) : null;
      case 'tempC': return f.tempC !== null ? L.tempPart(f.tempC) : null;
      case 'vaccines': {
        const parts = [];
        if (f.vaccinesGiven.length) parts.push(L.givenPart(f.vaccinesGiven.map((v) => vaccineSpoken(v, lang))));
        const due = this.vaccinesDue();
        if (due) parts.push(L.duePart(due.map((v) => vaccineSpoken(v, lang))));
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
      bp: f.bp, hb: f.hb, tempC: f.tempC, respRate: f.respRate, gestWeeks: f.gestWeeks, babyAgeDays: f.babyAgeDays,
      ifaGiven: f.ifaGiven,
      vaccinesGiven: f.vaccinesGiven,
      vaccinesDue: this.vaccinesDue() || [],
      nextVisit: f.nextVisit,
      dangerSigns: f.dangers,
      dangerSignsDenied: f.dangersAbsent,
      referToPHC: f.dangers.length > 0,
      transcript: f.transcript,
      lang: this.lang,
      visitDate: iso(this.now()),
      savedAt: new Date().toISOString(),
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
    const r = extract(text, { now, registry: this.registry, expect: this.expect });
    const f = this.form;
    f.transcript.push(text);
    const say = [];
    const changed = [];

    if (r.intent.cancel) {
      this.reset();
      return this.out([L.cancelled], { reset: true });
    }
    if (r.intent.followups) {
      const items = this.getFollowups().slice(0, 3).map((x) => L.followItem({ ...x, when: x.when === iso(now) ? L.today : dateSpoken(x.when, this.lang) }));
      return this.out([L.followups(items)]);
    }
    if (r.intent.newVisit && Object.keys(r.fields).length === 0) {
      this.reset();
      return this.out([L.newVisit], { reset: true });
    }
    if (r.intent.repeat && Object.keys(r.fields).length === 0) {
      if (this.state === 'confirm') return this.out([this.readback()]);
      return this.out(this.lastPrompt || [L.notUnderstood]);
    }

    const wasState = this.state;
    this.applyFields(r, changed);
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
      } else if (!r.empty || r.tokens.length > 2) {
        say.push(L.notUnderstood);
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
    if (!say.length && !r.empty && r.tokens.length > 1 && !r.dangers.absent.length) say.push(L.notUnderstood);
    if (!say.length && this.expect && r.tokens.length > 0 && !r.dangers.absent.length) say.push(this.askFor(this.expect));
    return this.out(say, { alert, changed });
  }
}
