// Wires mic -> STT -> agent -> TTS, with barge-in, echo rejection, adaptive endpointing
// and a live time-to-first-audio readout. Screens: start, visit, follow-ups, records, settings.
import { VisitAgent } from './agent.js';
import { buildRegistry, registryKeyterms } from './nlu/registry.js';
import { Mic, Vad, Player } from './audio.js';
import { saveRecord, listRecords, deleteAll, followupsFrom, summarize, saveDraft, loadDraft, clearDraft } from './store.js';
import { dangerLabel } from './nlu/danger.js';
import { iso } from './nlu/dates.js';
import { tokenize } from './nlu/translit.js';
import { VISIT_LABEL, LANGS, UI, YES_WORD, screenText } from './i18n.js';
import { stripEcho, isBargeIn } from './echo.js';

const $ = (id) => document.getElementById(id);
const pref = {
  get(k, d) { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// Health words that STT should favour, alongside the beneficiary names.
const HEALTH_TERMS = ['ANC', 'PNC', 'HBNC', 'PHC', 'ANM', 'ASHA', 'TT injection', 'Td', 'IFA', 'IFA goli', 'BCG', 'OPV', 'Penta', 'Pentavalent', 'Rota', 'PCV', 'IPV', 'MR', 'JE', 'Vitamin A', 'Hepatitis B', 'MCP card', 'hemoglobin', 'BP', 'ANC checkup', 'टीटी', 'आईएफए', 'गोली', 'टीका', 'वज़न', 'किलो', 'बुखार', 'नवजात', 'गर्भवती', 'ಲಸಿಕೆ', 'ತೂಕ', 'ಗರ್ಭಿಣಿ'];

const today = new Date();
const registry = buildRegistry(today);
let records = [];
let lang = pref.get('lang', 'hi');
let talkMode = pref.get('talkMode', 'handsfree');
const agent = new VisitAgent({ lang, registry, followups: () => followupsFrom(records, iso(new Date())) });

let config = { gnani: false, llm: false, ttsSampleRate: 24000 };
let ctx = null;
let ws = null;
let mic = null;
let vad = null;
let player = null;
let running = false;
// Silence never needs to reach Gnani: after this long without speech the mic pauses
// (no audio is streamed, no credits used) until the mic button is tapped again.
const IDLE_PAUSE_MS = 60_000;
let paused = false;
let lastActivity = 0;

// Access code: opened once as /?code=..., then remembered and hidden from the address bar.
let accessCode = '';
try {
  const fromUrl = new URLSearchParams(location.search).get('code');
  if (fromUrl) { localStorage.setItem('accessCode', fromUrl); history.replaceState(null, '', location.pathname); }
  accessCode = localStorage.getItem('accessCode') || '';
} catch { /* storage blocked: no code */ }
const codeQuery = accessCode ? `?code=${encodeURIComponent(accessCode)}` : '';
let pttDown = false;
let sayId = 1;
let speakingText = '';
let speakingUntil = 0;
let deferTimer = null;
let recog = null;
const ttfaSamples = [];
const ttsCache = new Map(); // text -> Int16Array[] for instant replay of fixed prompts
const caching = new Map(); // id -> { text, chunks }
let langVotes = { code: null, n: 0 };
let lastFinalKey = null;
// Speaker mode: what the agent said recently (for echo matching), whether the utterance
// being transcribed began while the agent was audible, and the soft barge-in timers.
const recentSaid = [];
let utt = null;
let duckTimer = null;
let commitTimer = null;

// ---------------- UI helpers ----------------
const S = () => screenText(lang);
const locale = () => (lang === 'en' ? 'en-IN' : `${lang}-IN`);

function toast(msg, ms = 3600) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function phoneOnly(s) {
  return String(s).replace(/[^\d+]/g, '').slice(0, 15);
}

// Static screen text: every element with data-t gets its string in the current language.
function applyScreenText() {
  const s = S();
  document.querySelectorAll('[data-t]').forEach((el) => { const v = s[el.dataset.t]; if (typeof v === 'string') el.textContent = v; });
  document.querySelectorAll('[data-t-ph]').forEach((el) => { el.placeholder = s[el.dataset.tPh] || ''; });
  $('aboutList').innerHTML = s.about.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  setNet();
}

function setStatus(kind) {
  const u = UI[lang] || UI.en;
  const m = $('mic');
  m.classList.toggle('listening', kind === 'listening');
  m.classList.toggle('speaking', kind === 'speaking');
  m.classList.toggle('off', kind === 'off');
  $('status').textContent = kind === 'listening' ? u.listening : kind === 'speaking' ? u.speaking : kind === 'thinking' ? '…' : talkMode === 'ptt' ? u.hold : u.tapToTalk;
}

// Connection state is shown as it is: the browser's own online flag. Nothing is synced either way.
function setNet() {
  const on = navigator.onLine;
  const el = $('net');
  el.textContent = on ? S().online : S().offline;
  el.className = `net ${on ? 'on' : 'off'}`;
  $('offlineBar').hidden = on;
}

function fmtDate(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
}

function fmtTime(ts) {
  return new Date(ts).toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function relDay(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  const now = new Date();
  const days = Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  const s = S();
  if (days === 0) return s.today;
  if (days === 1) return s.tomorrow;
  if (days < 0) return s.daysLate(-days);
  return days < 7 ? s.inDays(days) : fmtDate(isoStr);
}

// The visit as field rows, shared by the live visit card and the saved-record view.
function fieldRows(v) {
  const s = S();
  const e = escapeHtml;
  const vitals = [v.bp && `BP ${v.bp.sys}/${v.bp.dia}`, v.hb != null && `Hb ${v.hb}`, v.tempC != null && `Temp ${v.tempC}°C`, v.respRate != null && `Breaths ${v.respRate}/min`, v.gestWeeks != null && `${v.gestWeeks} wk pregnant`, v.babyAgeDays != null && `baby ${v.babyAgeDays} days`, v.ifaGiven && `IFA${v.ifaGiven === true ? '' : `: ${v.ifaGiven}`}`].filter(Boolean).join(' · ');
  const vaccines = () => {
    const parts = (v.vaccinesGiven || []).map((x) => `<span class="chip">✔ ${e(x)} ${e(s.given)}</span>`);
    if (v.vaccinesDue === null) return parts.join('');
    if (!v.vaccinesDue.length) parts.push(`<span class="chip denied">${e(s.noneDue)}</span>`);
    for (const x of v.vaccinesDue) parts.push(`<span class="chip due">${e(x)} ${e(s.due)}</span>`);
    return parts.join('');
  };
  const dangers = () => [
    ...(v.dangers || []).map((d) => `<span class="chip danger">⚠ ${e(dangerLabel(d, lang))}</span>`),
    ...(v.dangersAbsent || []).map((d) => `<span class="chip denied">${e(s.checkedNo)}: ${e(dangerLabel(d, lang))}</span>`),
  ].join('');
  const who = v.beneficiaryId || v.name ? `${v.name || '—'}${v.beneficiaryId ? ` · ID ${v.beneficiaryId}` : ''}${v.ward != null ? ` · ward ${v.ward}` : ''}${v.isNew ? ` · ${s.newPerson}` : ''}` : '';
  return [
    ['beneficiary', s.fBeneficiary, e(who)],
    ['visitType', s.fVisitType, v.visitType ? e(VISIT_LABEL[v.visitType] + (v.visitTypeInferred ? ` (${s.fromRegister})` : '')) : ''],
    ['weightKg', s.fWeight, v.weightKg != null ? `${e(v.weightKg)} kg` : ''],
    ['vitals', s.fVitals, e(vitals), true],
    ['vaccines', s.fVaccines, vaccines()],
    ['nextVisit', s.fNext, v.nextVisit ? e(fmtDate(v.nextVisit)) : ''],
    ['dangers', s.fDangers, dangers(), true],
  ];
}

function dl(rows, flashOf = () => false) {
  return rows.filter(([, , val, optional]) => !(optional && !val))
    .map(([key, label, val]) => `<dt>${escapeHtml(label)}</dt><dd class="${val ? '' : 'empty'}${val && flashOf(key, val) ? ' flash' : ''}">${val || escapeHtml(S().waiting)}</dd>`).join('');
}

const NEED_KEY = { beneficiary: 'needBeneficiary', visitType: 'needVisitType', weightKg: 'needWeight', vaccinesDue: 'needVaccines', nextVisit: 'needNext' };
const needList = (missing) => missing.map((m) => S()[NEED_KEY[m]] || m).join(', ');

let lastRendered = {};
function renderForm(changed = []) {
  const f = agent.form;
  const view = { ...f, ward: f.beneficiary?.ward, vaccinesDue: agent.vaccinesDue() };
  const vitalKeys = ['bp', 'hb', 'tempC', 'respRate', 'gestWeeks', 'babyAgeDays', 'ifaGiven'];
  const flashOf = (key, val) => {
    const hit = changed.includes(key) || (key === 'vitals' && changed.some((c) => vitalKeys.includes(c))) || (lastRendered[key] !== undefined && lastRendered[key] !== val);
    lastRendered[key] = val;
    return hit;
  };
  $('form').innerHTML = dl(fieldRows(view), flashOf);
  $('stateLbl').textContent = { ask: '· asking', disambiguate: '· which person?', confirm: '· confirm?' }[agent.state] || '';
  const missing = agent.missing();
  $('needs').hidden = !agent.dirty || !missing.length;
  $('needs').textContent = S().stillNeeded(needList(missing));
  $('editNote').hidden = !agent.editing;
  if (agent.editing) $('editNote').textContent = S().editing(fmtDate(agent.editing.visitDate));
  const alert = $('alert');
  alert.hidden = !f.dangers.length;
  if (f.dangers.length) {
    $('alertTitle').textContent = (UI[lang] || UI.en).refer;
    $('alertSigns').textContent = f.dangers.map((d) => dangerLabel(d, lang)).join(' · ');
  }
}

// ---------- drafts: an unfinished visit survives a reload or a lost connection ----------
let draftTimer = null;
function persistDraft() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    const job = agent.dirty ? saveDraft(agent.snapshot()) : clearDraft();
    job.catch(() => { /* the visit is still on screen; storage may be blocked */ });
  }, 300);
}

async function showDraftCard() {
  let d = null;
  try { d = await loadDraft(); } catch { /* storage blocked */ }
  const card = $('draftCard');
  if (!d?.form || agent.dirty) { card.hidden = true; return; }
  const peek = new VisitAgent({ lang, registry });
  peek.restore(d);
  const f = peek.form;
  const who = [f.name, f.beneficiaryId && `ID ${f.beneficiaryId}`, f.visitType && VISIT_LABEL[f.visitType]].filter(Boolean).join(' · ') || '—';
  const missing = peek.missing();
  $('draftText').textContent = `${who}${missing.length ? `. ${S().draftNeeds(needList(missing))}` : ''}`;
  card.hidden = false;
  card.dataset.ready = '1';
  showDraftCard.draft = d;
}

// ---------- lists ----------
let listError = null;
async function refreshLists() {
  listError = null;
  try { records = await listRecords(); } catch (e) { listError = e?.message || String(e); records = []; }
  renderFollowups();
  renderRecords();
  showDraftCard();
}

function followItem(x, { compact = false } = {}) {
  const s = S();
  const e = escapeHtml;
  const sub = [
    VISIT_LABEL[x.visitType] || '',
    x.refer ? s.referredOn(fmtDate(x.referredOn)) : '',
    x.refer && x.dangerSigns.length ? x.dangerSigns.map((d) => dangerLabel(d, lang)).join(', ') : '',
    !compact && x.vaccinesDue.length ? `${s.due}: ${x.vaccinesDue.join(', ')}` : '',
  ].filter(Boolean).join(' · ');
  const when = x.due ? `${relDay(x.due)}${x.status === 'soon' || x.status === 'later' ? '' : ` · ${fmtDate(x.due)}`}` : '';
  return `<li class="item${x.refer ? ' refer' : ''}">
    <span class="who"><b>${e(x.name || '—')}${x.beneficiaryId ? ` · ID ${e(x.beneficiaryId)}` : ''}</b><span>${e(sub)}</span>
      <span class="when ${x.refer ? 'refer' : x.status}">${e(x.due ? s.nextOn(when) : '')}</span></span>
    <button class="btn small" data-follow="${e(x.visitId)}">${e(s.startThis)}</button>
  </li>`;
}

function renderFollowups() {
  const s = S();
  const fu = followupsFrom(records, iso(new Date()));
  const groups = [
    ['grpRefer', fu.filter((x) => x.refer)],
    ['grpOverdue', fu.filter((x) => !x.refer && x.status === 'overdue')],
    ['grpToday', fu.filter((x) => !x.refer && x.status === 'today')],
    ['grpSoon', fu.filter((x) => !x.refer && x.status === 'soon')],
    ['grpLater', fu.filter((x) => !x.refer && (x.status === 'later' || x.status === 'none'))],
  ].filter(([, xs]) => xs.length);
  $('followGroups').innerHTML = listError
    ? `<p class="error">${escapeHtml(s.readFailed(listError))}</p>`
    : groups.length
      ? groups.map(([k, xs]) => `<h3 class="group">${escapeHtml(s[k])} (${xs.length})</h3><ul class="items">${xs.map((x) => followItem(x)).join('')}</ul>`).join('')
      : `<p class="empty">${escapeHtml(s.fuEmpty)}</p>`;
  const attention = fu.filter((x) => x.refer || x.status === 'overdue' || x.status === 'today');
  $('dueCard').hidden = !attention.length;
  $('dueList').innerHTML = attention.slice(0, 3).map((x) => followItem(x, { compact: true })).join('');
  $('followCount').hidden = !attention.length;
  $('followCount').textContent = attention.length;
}

function recordHtml(r) {
  const s = S();
  const e = escapeHtml;
  const rows = fieldRows({ ...r, dangers: r.dangerSigns, dangersAbsent: r.dangerSignsDenied });
  const heard = (r.transcript || []).slice(-3).map((t) => `<p class="heard">“${e(typeof t === 'string' ? t : t?.text || '')}”</p>`).join('');
  const store = [s.stored, r.updatedAt ? s.edited(fmtTime(r.updatedAt)) : '', r.expiresAt ? s.deletesOn(fmtDate(iso(new Date(r.expiresAt)))) : ''].filter(Boolean).join(' ');
  return `<details>
    <summary><span><b>${e(r.name || '—')}${r.beneficiaryId ? ` · ID ${e(r.beneficiaryId)}` : ''}</b>
      <span>${e(VISIT_LABEL[r.visitType] || '')} · ${e(fmtDate(r.visitDate))}${r.referToPHC ? ` · <span class="referred">${e(s.referred)}</span>` : ''}</span></span><span aria-hidden="true">›</span></summary>
    <div class="rec-body">
      <dl class="fields">${dl(rows)}</dl>
      ${heard ? `<p class="muted"><b>${e(s.heard)}</b></p>${heard}` : ''}
      <p class="store-line">${e(store)}</p>
      <button class="btn" data-edit="${e(r.visitId)}">${e(s.editBtn)}</button>
    </div>
  </details>`;
}

function renderRecords() {
  const s = S();
  const e = escapeHtml;
  if (listError) {
    $('summary').hidden = true;
    $('recordList').innerHTML = `<li class="error">${e(s.readFailed(listError))}</li>`;
    return;
  }
  $('recordList').innerHTML = records.length ? records.map((r) => `<li>${recordHtml(r)}</li>`).join('') : `<li class="empty">${e(s.recEmpty)}</li>`;
  // the summary only appears once there is something to count
  $('summary').hidden = !records.length;
  if (records.length) {
    const m = summarize(records, iso(new Date()));
    const cell = (n, label) => `<div><b>${n}</b><span>${e(label)}</span></div>`;
    $('summary').innerHTML = `<h3>${e(s.sumTitle)}</h3><div class="sum-grid">
      ${cell(m.visits, s.sumVisits)}
      ${Object.entries(m.byType).filter(([, n]) => n).map(([k, n]) => cell(n, VISIT_LABEL[k])).join('')}
      ${cell(m.referrals, s.sumRefer)}${cell(m.overdue, s.sumOverdue)}${cell(m.dueSoon, s.sumSoon)}${m.newPeople ? cell(m.newPeople, s.sumNew) : ''}
    </div><p class="fine">${e(s.sumNote)}</p>`;
  }
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
}

// Begin a visit from a button: the chosen kind, or the person from a follow-up.
function beginVisit(visitType, person = null) {
  agent.startVisit(visitType || null, person);
  lastRendered = {};
  $('saveStatus').hidden = true;
  renderForm();
  persistDraft();
  showTab('visit');
  if (!navigator.onLine) { $('typeText').focus(); return; }
  if (!running) start(); else speak(agent.L.newVisit);
}

function openForEdit(visitId) {
  const r = records.find((x) => x.visitId === visitId);
  if (!r) return;
  agent.edit(r);
  lastRendered = {};
  $('saveStatus').hidden = true;
  renderForm();
  persistDraft();
  showTab('visit');
  if (running) speak(agent.readback());
}

function showSaved(ok, msg) {
  const el = $('saveStatus');
  el.hidden = false;
  el.classList.toggle('bad', !ok);
  el.textContent = ok ? S().savedLocal(fmtTime(Date.now())) : S().saveFailed(msg);
}

// ---------------- speaking ----------------
function recordTtfa(firstAudioAt, speechEndAt) {
  if (!speechEndAt) return;
  const ms = Math.max(0, Math.round(firstAudioAt - speechEndAt));
  if (ms > 15000) return;
  ttfaSamples.push(ms);
  const sorted = [...ttfaSamples].sort((a, b) => a - b);
  $('ttfa').textContent = `${ms} ms`;
  $('ttfaMed').textContent = `${sorted[Math.floor(sorted.length / 2)]} ms`;
}

function stopSpeaking() {
  clearTimeout(deferTimer);
  deferTimer = null;
  if (player) {
    const id = player.stop();
    if (id && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'cancel', id }));
  }
  if (window.speechSynthesis?.speaking) speechSynthesis.cancel();
  speakingUntil = performance.now() + 600; // a little echo tail can still arrive
  clearTimeout(duckTimer);
  if (running) setStatus('listening');
}

// Something is heard over the agent: lower its voice at once, but only stop it when the
// transcript confirms real words from the worker (echo.js). Unconfirmed, the voice comes
// back up, so room noise or the agent's own echo cannot cut it off.
function softBarge() {
  if (!player?.playing) return;
  player.duck(true);
  clearTimeout(duckTimer);
  duckTimer = setTimeout(() => player?.duck(false), 1400);
}

// Mark the start of an utterance: did it begin while the agent was audible?
function noteUtterance() {
  if (!utt) utt = { overlap: Boolean(player?.playing) || window.speechSynthesis?.speaking || performance.now() - speakingUntil < 500 };
}

// Echo-checked entry point for everything the microphone produced.
function heard(text, meta = {}) {
  noteUtterance();
  const overlap = utt.overlap;
  utt = null;
  let use = (text || '').trim();
  if (overlap && use) {
    const g = stripEcho(use, recentSaid, { playing: Boolean(player?.playing) || Boolean(window.speechSynthesis?.speaking) });
    if (g.echo) { player?.duck(false); return; }
    use = g.rest;
  }
  onTranscript(use, meta);
}

function speak(text, { speechEndAt = null, ack = false } = {}) {
  if (!text) return;
  $('agentSaid').textContent = text;
  $('agentSaid').classList.remove('muted');
  speakingText = text;
  recentSaid.push(text);
  if (recentSaid.length > 3) recentSaid.shift();
  stopSpeaking();
  setStatus('speaking');
  if (config.gnani && player && ws?.readyState === 1) {
    const id = sayId++;
    player.begin(id, (at) => recordTtfa(at, speechEndAt));
    const cached = ttsCache.get(`${lang}|${text}`);
    // Lowest latency: a short cached acknowledgement ("जी।") starts playing at once while
    // the reply itself is synthesised; its audio is queued gaplessly behind it.
    const ackAudio = ack && !cached ? ttsCache.get(`${lang}|${agent.L.ack}`) : null;
    if (ackAudio) for (const c of ackAudio) player.push(id, c);
    if (cached) {
      for (const c of cached) player.push(id, c);
      player.finish(id);
      return;
    }
    caching.set(id, { key: `${lang}|${text}`, chunks: [] });
    ws.send(JSON.stringify({ type: 'say', id, text, lang }));
  } else if ('speechSynthesis' in window) {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = LANGS[lang].browser;
    const v = speechSynthesis.getVoices().find((x) => x.lang?.toLowerCase().startsWith(lang));
    if (v) u.voice = v;
    u.rate = 1;
    u.onstart = () => recordTtfa(performance.now(), speechEndAt);
    u.onend = () => { speakingUntil = performance.now(); if (running) setStatus('listening'); };
    speechSynthesis.speak(u);
  }
}

// Fixed prompts are pre-synthesised once so they can play with near-zero latency.
function prewarm() {
  if (!config.gnani || !ws || ws.readyState !== 1) return;
  const L = agent.L;
  const texts = [L.ack, L.askWeight, L.askVaccinesDue, L.askBeneficiary, L.askVisitType, L.notUnderstood, L.refuse, L.whatWrong, L.askCorrectWeight, L.newVisit];
  texts.forEach((text, i) => {
    const key = `${lang}|${text}`;
    if (ttsCache.has(key)) return;
    setTimeout(() => {
      const id = sayId++;
      caching.set(id, { key, chunks: [], silent: true });
      ws.send(JSON.stringify({ type: 'say', id, text, lang }));
    }, i === 0 ? 150 : 1200 + i * 600);
  });
}

// ---------------- understanding ----------------
async function llmAssist(text) {
  if (!config.llm) return;
  try {
    const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Access-Code': accessCode }, body: JSON.stringify({ text, lang }) });
    if (!res.ok) return;
    const x = await res.json();
    // Only accept numbers that were actually spoken.
    const spoken = tokenize(text).map((t) => t.rom).join(' ');
    if (typeof x.weightKg === 'number' && !spoken.includes(String(x.weightKg).split('.')[0]) && !/[a-zऀ-ൿ]/i.test(spoken)) delete x.weightKg;
    if (x.beneficiaryId && !registry.some((b) => b.id === x.beneficiaryId)) delete x.beneficiaryId;
    if (x.visitType && !['ANC', 'PNC', 'HBNC', 'IMM'].includes(x.visitType)) delete x.visitType;
    const { changed, fresh } = agent.applyExternal(x);
    if (changed.length || fresh.length) { renderForm(changed); persistDraft(); }
    if (fresh.length) speak(agent.L.alert(fresh.map((d) => dangerLabel(d, lang)).join(', ')));
  } catch { /* LLM is optional */ }
}

// Prisma tags the language from the script, so Marathi comes back as hi-IN (both Devanagari).
// Marathi function words settle it.
const MARATHI = /(^|\s)(आहे|आहेत|आणि|किंवा|नाही|उद्या|पुढची|पुढील|झाले|झालं)(?=\s|[.,।?]|$)|ळ/;
function spokenLang(detected, text) {
  let code = detected?.slice(0, 2);
  if (code === 'hi' && (lang === 'mr' || MARATHI.test(text))) code = 'mr';
  return code;
}

async function onTranscript(text, meta = {}) {
  text = (text || '').trim();
  if (!text) return;
  const speechEndAt = meta.speechEndAt || vad?.lastVoiceAt || performance.now();
  // follow the language she's actually speaking
  const code = spokenLang(meta.detectedLang, text);
  if (code && code !== lang && LANGS[code]) {
    langVotes = langVotes.code === code ? { code, n: langVotes.n + 1 } : { code, n: 1 };
    // a regional script is unambiguous: switch on the first sentence, so a judge who starts
    // in Tamil hears the reply in Tamil. Hindi/English/Marathi swaps wait for a second one
    // (Hinglish, or a single English sentence, shouldn't flip the language).
    if (langVotes.n >= 2 || !['hi', 'en', 'mr'].includes(code)) setLang(code, false);
  } else langVotes = { code: null, n: 0 };

  // kept so a failed save can put the visit back exactly as it was
  const before = JSON.parse(JSON.stringify(agent.snapshot()));
  const res0 = agent.handle(text);
  // nothing usable (room chatter): leave the agent talking and the screen as it was
  if (!res0.say.length && !res0.changed?.length && !res0.saved) { player?.duck(false); return; }
  if (player?.playing || window.speechSynthesis?.speaking) stopSpeaking(); // she spoke over the agent: barge-in
  clearTimeout(deferTimer);
  $('youSaid').textContent = text;
  $('youSaid').classList.remove('muted');

  const res = res0;
  let reply = res.say.join(' ');
  if (res.saved) {
    try {
      await saveRecord(res.saved);
      showSaved(true);
      lastRendered = {};
      renderForm();
      refreshLists();
    } catch (e) {
      // nothing was written: put the visit back on screen and say so, never "saved"
      agent.restore(before);
      agent.state = 'confirm';
      renderForm();
      showSaved(false, e?.message || 'storage error');
      reply = agent.L.saveFailed;
    }
  } else {
    renderForm(res.changed || []);
  }
  persistDraft();
  if (res.deferrable && talkMode === 'handsfree') {
    // acknowledge now, then give her a moment to keep dictating before the next question
    if (config.gnani && ttsCache.has(`${lang}|${agent.L.ack}`)) speak(agent.L.ack, { speechEndAt });
    // she may still be talking; in a loud room the VAD can stay on, so ask after 1.35 s at most
    let tries = 0;
    const ask = () => { if (vad?.speaking && ++tries < 3) deferTimer = setTimeout(ask, 450); else speak(reply); };
    deferTimer = setTimeout(ask, 450);
  } else {
    speak(reply, { speechEndAt, ack: true });
  }
  if (!res.changed?.length && !res.saved && text.split(/\s+/).length >= 3 && agent.state !== 'confirm') llmAssist(text);
}

// ---------------- connection ----------------
function connect() {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws${codeQuery}`);
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'start', lang, keyterms: [...registryKeyterms(registry), ...HEALTH_TERMS] }));
      resolve();
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== 'string') {
        const id = new DataView(e.data).getUint32(0, true);
        const pcm = new Int16Array(e.data.slice(4));
        const c = caching.get(id);
        if (c) c.chunks.push(pcm);
        if (!c?.silent) player?.push(id, pcm);
        return;
      }
      const m = JSON.parse(e.data);
      switch (m.type) {
        case 'ready': prewarm(); break;
        case 'stt_speech_start': noteUtterance(); softBarge(); break;
        case 'stt_processing':
        case 'stt_speech_end': setStatus('thinking'); break;
        case 'stt_partial_transcript': {
          // live caption; words that survive the echo check over the agent's voice cut it off
          if (!m.text) break;
          noteUtterance();
          const g = utt.overlap ? stripEcho(m.text, recentSaid, { playing: Boolean(player?.playing) }) : { echo: false, rest: m.text, restUnits: ['x', 'x'] };
          if (g.echo) break;
          $('youSaid').textContent = g.rest;
          $('youSaid').classList.add('muted');
          if (player?.playing && isBargeIn(g.restUnits)) stopSpeaking();
          break;
        }
        case 'stt_transcript':
        case 'stt_final_transcript': {
          // with partials on the server sends final_transcript; without, transcript
          const key = m.segment_id || m.utterance_id || m.text;
          if (key && key === lastFinalKey) break;
          lastFinalKey = key;
          heard(m.text, { detectedLang: m.detected_language_code });
          if (!player?.playing) setStatus('listening');
          break;
        }
        case 'stt_error': toast(`Speech service: ${m.message}`); break;
        case 'tts_end': {
          const c = caching.get(m.id);
          if (c) { if (c.chunks.length) ttsCache.set(c.key, c.chunks); caching.delete(m.id); }
          player?.finish(m.id);
          break;
        }
        case 'tts_error':
          caching.delete(m.id);
          if (m.message === 'rate limited') { goFree(); speak(speakingText); } else toast(`Voice output failed: ${m.message}`);
          break;
        case 'budget': goFree(); break;
        default:
      }
    };
    ws.onclose = () => {
      if (!running) return;
      // offline: wait for the connection to come back instead of retrying every second
      if (!navigator.onLine) { window.addEventListener('online', () => { if (running) connect(); }, { once: true }); return; }
      toast('Connection lost, reconnecting…');
      setTimeout(() => { if (running) connect(); }, 1500);
    };
  });
}

// Browser speech recognition, used only when no Gnani key is configured.
function startBrowserStt() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast(S().noSR); return false; }
  recog = new SR();
  recog.lang = LANGS[lang].browser;
  recog.continuous = true;
  recog.interimResults = true;
  recog.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) heard(r[0].transcript, { speechEndAt: performance.now() });
      else $('youSaid').textContent = r[0].transcript;
    }
  };
  recog.onspeechstart = () => noteUtterance();
  recog.onend = () => { if (running) { try { recog.start(); } catch { /* already running */ } } };
  // offline or blocked: stop instead of restarting in a loop, and point to typing
  recog.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') { stopBrowserStt(); toast(S().micDenied); } else if (e.error === 'network') { stopBrowserStt(); toast(S().sttNetwork); }
  };
  recog.start();
  return true;
}

function stopBrowserStt() {
  running = false;
  const r = recog;
  recog = null;
  try { r?.stop(); } catch { /* already stopped */ }
  setStatus('off');
}

function onFrame({ pcm, rms }) {
  $('level').style.width = `${Math.min(100, Math.round(rms * 900))}%`;
  vad.push(rms, player?.playing || false);
  if (!config.gnani || ws?.readyState !== 1 || paused) return;
  if (talkMode === 'ptt' && !pttDown) return;
  const now = performance.now();
  if (vad.speaking || player?.playing || pttDown) lastActivity = now;
  else if (talkMode === 'handsfree' && now - lastActivity > IDLE_PAUSE_MS) {
    paused = true;
    setStatus('idle');
    toast('Mic paused after 1 minute of silence (saves credits). Tap the mic to continue.');
    return;
  }
  ws.send(pcm);
}

// Daily credit cap reached (or access lost): carry on with the browser's free voice.
function goFree() {
  if (!config.gnani) return;
  config.gnani = false;
  config.llm = false;
  setBadge();
  toast('Gnani daily limit reached. Switched to the free browser voice.');
  try { ws?.close(); } catch { /* already closed */ }
  if (running) startBrowserStt();
}

function setBadge() {
  const badge = $('modeBadge');
  badge.textContent = config.gnani ? 'Gnani live' : 'browser speech';
  badge.className = `badge ${config.gnani ? 'live' : 'fallback'}`;
}

async function start() {
  if (running) return;
  if (!navigator.onLine) { toast(S().offlineHint); showTab('visit'); $('typeText').focus(); return; }
  running = true;
  lastActivity = performance.now();
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  player = new Player(ctx, config.ttsSampleRate || 24000);
  player.onIdle = () => { speakingUntil = performance.now(); if (running) setStatus('listening'); };
  vad = new Vad({
    onStart: (overAgent) => {
      clearTimeout(commitTimer);
      if (overAgent) softBarge();
      if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
    },
    onEnd: () => {
      // Close the utterance from the client too. Short answers (yes/no, a number, a date)
      // close after 350 ms of quiet; dictation after 900 ms so natural pauses stay whole.
      // In a noisy hall the server may keep hearing voices and never end the turn: this
      // puts a ceiling on that wait.
      if (!config.gnani || ws?.readyState !== 1 || talkMode !== 'handsfree' || player?.playing) return;
      clearTimeout(commitTimer);
      commitTimer = setTimeout(() => {
        if (!vad.speaking && ws?.readyState === 1) ws.send(JSON.stringify({ type: 'commit' }));
      }, agent.state === 'dictate' ? 550 : 0);
    },
  });
  try {
    if (config.gnani) {
      await connect();
      mic = new Mic(ctx);
      await mic.start(onFrame);
    } else if (!startBrowserStt()) {
      running = false;
      setStatus('off');
      return;
    }
  } catch (e) {
    running = false;
    setStatus('off');
    toast(`Microphone error: ${e.message}`);
    return;
  }
  setStatus('listening');
  const g = agent.greet();
  speak(g.say.join(' '));
}

function setLang(l, announce = true) {
  lang = l;
  agent.lang = l;
  pref.set('lang', l);
  $('lang').value = l;
  document.documentElement.lang = l;
  if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'lang', lang: l, keyterms: [...registryKeyterms(registry), ...HEALTH_TERMS] }));
  if (recog) { recog.lang = LANGS[l].browser; try { recog.stop(); } catch { /* restarts onend */ } }
  if (running && announce) speak(agent.L.greet);
  setStatus(running ? 'listening' : 'idle');
  applyScreenText();
  renderForm();
  refreshLists();
}

// ---------------- wiring ----------------
async function init() {
  try { config = await (await fetch(`/api/config${codeQuery}`)).json(); } catch { /* offline: browser fallback */ }
  setBadge();
  $('lang').replaceChildren(...Object.entries(LANGS).map(([code, l]) => new Option(l.name, code)));
  if (!LANGS[lang]) lang = 'hi';
  $('lang').value = lang;
  document.documentElement.lang = lang;
  $('talkMode').value = talkMode;
  $('phcNumber').value = pref.get('phc', '');
  $('callPhc').href = `tel:${phoneOnly(pref.get('phc', ''))}`;
  $('retention').value = pref.get('retentionDays', '7');
  applyScreenText();
  renderForm();
  $('recordList').innerHTML = `<li class="empty">${escapeHtml(S().loading)}</li>`;
  refreshLists();
  setStatus('idle');

  const micBtn = $('mic');
  micBtn.addEventListener('click', () => {
    if (!running) start();
    else if (paused) { paused = false; lastActivity = performance.now(); setStatus('listening'); }
    else if (player?.playing || window.speechSynthesis?.speaking) stopSpeaking();
  });
  micBtn.addEventListener('pointerdown', () => { if (running && talkMode === 'ptt') { pttDown = true; stopSpeaking(); setStatus('listening'); } });
  const release = () => {
    if (talkMode === 'ptt' && pttDown) {
      pttDown = false;
      if (ws?.readyState === 1) ws.send(JSON.stringify({ type: 'commit' }));
      setStatus('thinking');
    }
  };
  micBtn.addEventListener('pointerup', release);
  micBtn.addEventListener('pointerleave', release);

  $('lang').addEventListener('change', (e) => setLang(e.target.value));
  $('talkMode').addEventListener('change', (e) => { talkMode = e.target.value; pref.set('talkMode', talkMode); setStatus(running ? 'listening' : 'idle'); });
  $('phcNumber').addEventListener('change', (e) => { const n = phoneOnly(e.target.value); e.target.value = n; pref.set('phc', n); $('callPhc').href = `tel:${n}`; });
  $('retention').addEventListener('change', (e) => pref.set('retentionDays', e.target.value));
  $('wipe').addEventListener('click', async () => {
    if (!confirm(S().wipeAsk)) return;
    try { await deleteAll(); toast(S().wiped); } catch (e) { toast(S().readFailed(e?.message || e)); }
    await refreshLists();
  });
  $('newVisit').addEventListener('click', () => { agent.reset(); lastRendered = {}; $('saveStatus').hidden = true; renderForm(); persistDraft(); if (running) speak(agent.L.newVisit); });
  $('readback').addEventListener('click', () => { const t = agent.readback(); renderForm(); speak(t); });
  $('saveBtn').addEventListener('click', () => {
    if (agent.state !== 'confirm') { const t = agent.readback(); renderForm(); speak(t); return; }
    onTranscript(YES_WORD[lang] || 'yes');
  });
  $('typeForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const v = $('typeText').value;
    $('typeText').value = '';
    if (!ctx) { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
    onTranscript(v, { speechEndAt: performance.now() });
  });
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.goto)));
  document.querySelectorAll('[data-start]').forEach((b) => b.addEventListener('click', () => beginVisit(b.dataset.start)));
  // follow-up "Start visit" and saved-record "Correct" buttons are rendered into lists
  document.addEventListener('click', (e) => {
    const fol = e.target.closest('[data-follow]');
    if (fol) {
      const r = records.find((x) => x.visitId === fol.dataset.follow);
      if (r) beginVisit(r.visitType, { beneficiaryId: r.beneficiaryId, name: r.name });
      return;
    }
    const ed = e.target.closest('[data-edit]');
    if (ed) openForEdit(ed.dataset.edit);
  });
  $('draftContinue').addEventListener('click', () => {
    agent.restore(showDraftCard.draft);
    lastRendered = {};
    $('draftCard').hidden = true;
    renderForm();
    showTab('visit');
  });
  $('draftDiscard').addEventListener('click', async () => {
    try { await clearDraft(); } catch { /* nothing to clear */ }
    $('draftCard').hidden = true;
  });
  window.addEventListener('online', () => { setNet(); toast(S().backOnline); });
  window.addEventListener('offline', () => { setNet(); toast(S().wentOffline); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
