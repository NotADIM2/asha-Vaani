// Wires mic -> STT -> agent -> TTS, with barge-in, echo rejection, adaptive endpointing
// and a live time-to-first-audio readout.
import { VisitAgent } from './agent.js';
import { buildRegistry, registryKeyterms } from './nlu/registry.js';
import { Mic, Vad, Player } from './audio.js';
import { saveRecord, listRecords, deleteAll, followupsFrom } from './store.js';
import { dangerLabel } from './nlu/danger.js';
import { iso } from './nlu/dates.js';
import { tokenize } from './nlu/translit.js';
import { VISIT_LABEL, LANGS, UI } from './i18n.js';
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
function toast(msg, ms = 3200) {
  const el = $('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, ms);
}

function setStatus(kind) {
  const u = UI[lang] || UI.en;
  const m = $('mic');
  m.classList.toggle('listening', kind === 'listening');
  m.classList.toggle('speaking', kind === 'speaking');
  m.classList.toggle('off', kind === 'off');
  $('status').textContent = kind === 'listening' ? u.listening : kind === 'speaking' ? u.speaking : kind === 'thinking' ? '…' : talkMode === 'ptt' ? u.hold : u.tapToTalk;
}

function fmtDate(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(lang === 'en' ? 'en-IN' : `${lang}-IN`, { day: 'numeric', month: 'short', year: 'numeric' });
}

let lastRendered = {};
function renderForm(changed = []) {
  const f = agent.form;
  const due = agent.vaccinesDue();
  const rows = [
    ['beneficiary', 'Beneficiary', 'लाभार्थी', f.beneficiaryId || f.name ? `${f.name || '—'}${f.beneficiaryId ? ` · ID ${f.beneficiaryId}` : ''}${f.beneficiary ? ` · ward ${f.beneficiary.ward}` : ''}${f.isNew ? ' · new' : ''}` : ''],
    ['visitType', 'Visit type', 'विज़िट', f.visitType ? VISIT_LABEL[f.visitType] + (f.visitTypeInferred ? ' (from register)' : '') : ''],
    ['weightKg', 'Weight', 'वज़न', f.weightKg !== null ? `${f.weightKg} kg` : ''],
    ['vitals', 'Vitals', 'जाँच', [f.bp && `BP ${f.bp.sys}/${f.bp.dia}`, f.hb !== null && `Hb ${f.hb}`, f.tempC !== null && `Temp ${f.tempC}°C`, f.respRate !== null && `Breaths ${f.respRate}/min`, f.gestWeeks !== null && `${f.gestWeeks} wk pregnant`, f.babyAgeDays !== null && `baby ${f.babyAgeDays} days`, f.ifaGiven && `IFA given${f.ifaGiven === true ? '' : `: ${f.ifaGiven}`}`].filter(Boolean).join(' · '), true],
    ['vaccines', 'Vaccines', 'टीके', '', false, () => {
      const parts = [];
      for (const v of f.vaccinesGiven) parts.push(`<span class="chip">✔ ${v} given</span>`);
      if (due === null) return parts.join('');
      if (!due.length) parts.push('<span class="chip">none due</span>');
      for (const v of due) parts.push(`<span class="chip due">${v} due</span>`);
      return parts.join('');
    }],
    ['nextVisit', 'Next visit', 'अगली विज़िट', f.nextVisit ? fmtDate(f.nextVisit) : ''],
    ['dangers', 'Danger signs', 'खतरे के संकेत', '', true, () => {
      const p = f.dangers.map((d) => `<span class="chip danger">⚠ ${dangerLabel(d, 'en')}</span>`);
      p.push(...f.dangersAbsent.map((d) => `<span class="chip denied">checked: no ${dangerLabel(d, 'en')}</span>`));
      return p.join('') || '';
    }],
  ];
  const html = [];
  for (const [key, en, hi, text, optional, fn] of rows) {
    const value = fn ? fn() : text;
    if (optional && !value) continue;
    const flash = changed.includes(key) || (key === 'vitals' && changed.some((c) => ['bp', 'hb', 'tempC', 'respRate', 'gestWeeks', 'babyAgeDays', 'ifaGiven'].includes(c))) || (key === 'dangers' && changed.includes('dangers')) || (lastRendered[key] !== undefined && lastRendered[key] !== value);
    lastRendered[key] = value;
    const safe = fn ? value : escapeHtml(value);
    html.push(`<dt>${en}<small>${hi}</small></dt><dd class="${value ? '' : 'empty'}${flash && value ? ' flash' : ''}">${value ? safe : 'waiting…'}</dd>`);
  }
  $('form').innerHTML = html.join('');
  $('stateLbl').textContent = { dictate: 'listening', ask: 'asking', disambiguate: 'which person?', confirm: 'confirm?' }[agent.state] || '';
  const alert = $('alert');
  alert.hidden = !f.dangers.length;
  if (f.dangers.length) {
    $('alertTitle').textContent = (UI[lang] || UI.en).refer;
    $('alertSigns').textContent = f.dangers.map((d) => dangerLabel(d, lang)).join(' · ');
  }
}

function phoneOnly(s) {
  return String(s).replace(/[^\d+]/g, '').slice(0, 15);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const GREET = {
  hi: 'नमस्ते, <b>आशा दीदी</b> 👋',
  en: 'Namaste, <b>ASHA didi</b> 👋',
  kn: 'ನಮಸ್ಕಾರ, <b>ಆಶಾ ಅಕ್ಕ</b> 👋',
};
const DAILY_GOAL = 5;
const locale = () => (lang === 'en' ? 'en-IN' : `${lang}-IN`);
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

function initials(name) {
  const w = String(name || '?').trim().split(/\s+/);
  return escapeHtml(((w[0] || '?')[0] + (w[1] ? w[1][0] : '')).toUpperCase());
}

function relDay(isoStr) {
  if (!isoStr) return '';
  const [y, m, d] = isoStr.split('-').map(Number);
  const now = new Date();
  const days = Math.round((new Date(y, m - 1, d) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days > 1 && days < 7) return `In ${days} days`;
  if (days < 0) return `${-days} d overdue`;
  return fmtDate(isoStr);
}

function setRing(id, pct) {
  $(id).style.setProperty('--p', String(Math.max(0, Math.min(100, Math.round(pct)))));
}

// Home: today's snapshot, the week's visits and the next three follow-ups.
function renderHome(fu) {
  const now = new Date();
  const todayIso = iso(now);
  $('greet').innerHTML = GREET[lang] || GREET.en;
  $('todayLbl').textContent = `Today is ${now.toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}`;

  const visits = records.filter((r) => r.visitDate === todayIso).length;
  const refer = fu.filter((x) => x.refer).length;
  const weekEnd = iso(addDays(now, 7));
  const due = fu.filter((x) => !x.refer && x.when <= weekEnd).length;
  const vax = fu.reduce((n, x) => n + (x.vaccinesDue?.length || 0), 0);
  $('stVisits').textContent = visits;
  $('stRefer').textContent = refer;
  $('stDue').textContent = due;
  $('stVax').textContent = vax;
  setRing('ringVisits', (visits / DAILY_GOAL) * 100);
  setRing('ringRefer', refer ? 100 : 0);
  setRing('ringDue', fu.length ? (due / fu.length) * 100 : 0);
  setRing('ringVax', Math.min(100, vax * 12.5));
  $('referTag').textContent = refer ? 'act today' : 'all clear';
  $('referTag').classList.toggle('alert-tag', refer > 0);

  const days = Array.from({ length: 7 }, (_, i) => addDays(now, i - 6));
  const counts = days.map((d) => records.filter((r) => r.visitDate === iso(d)).length);
  const max = Math.max(1, ...counts);
  $('weekTotal').textContent = counts.reduce((a, b) => a + b, 0);
  $('weekBars').innerHTML = days.map((d, i) => `<div class="bar${i === 6 ? ' today' : ''}"><span class="n">${counts[i]}</span><span class="col"></span><span class="d">${escapeHtml(d.toLocaleDateString(locale(), { weekday: 'short' }))}</span></div>`).join('');
  $('weekBars').querySelectorAll('.col').forEach((el, i) => {
    el.style.setProperty('--h', '0');
    requestAnimationFrame(() => el.style.setProperty('--h', String((counts[i] / max) * 100)));
  });

  $('nextUp').innerHTML = fu.length
    ? fu.slice(0, 3).map((x) => `<li class="glass"><span class="av${x.refer ? ' refer' : ''}">${initials(x.name)}</span><span class="who"><b>${escapeHtml(x.name || '—')}</b><span>${x.beneficiaryId ? `ID ${escapeHtml(x.beneficiaryId)} · ` : ''}${escapeHtml(VISIT_LABEL[x.visitType] || 'Visit')}${x.vaccinesDue?.length ? ` · ${escapeHtml(x.vaccinesDue.join(', '))} due` : ''}</span></span><span class="when${x.refer ? ' refer' : ''}">${x.refer ? 'Refer today' : escapeHtml(relDay(x.when))}</span></li>`).join('')
    : '<li class="glass empty">No follow-ups yet. Start a visit to build your list.</li>';
}

// Deterministic barcode drawn from the visit id (decoration; the id is printed below it).
function barcodeSvg(seed) {
  const s = String(seed || 'asha');
  const bars = [];
  let x = 0;
  for (let i = 0; i < 46; i++) {
    const c = s.charCodeAt(i % s.length) * (i + 3);
    const w = 1 + (c % 3);
    bars.push(`<rect x="${x}" y="0" width="${w}" height="40"/>`);
    x += w + 1 + ((c >> 3) % 2);
  }
  return `<svg class="barcode" viewBox="0 0 ${x} 40" preserveAspectRatio="none" aria-hidden="true">${bars.join('')}</svg>`;
}

// Records are shown as printed visit slips: what was recorded, what was heard, what is next.
function slipHtml(r) {
  const e = escapeHtml;
  // the slip is printed in one script, like a real receipt
  const fmtDate = (isoStr) => {
    if (!isoStr) return '';
    const [y, m, d] = isoStr.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
  };
  const ln = (k, v) => `<div class="ln"><span>${e(k)}</span><span>${e(v)}</span></div>`;
  const saved = r.savedAt ? new Date(r.savedAt) : null;
  const slipNo = String(r.visitId || '').slice(-6).toUpperCase();
  const vitals = [
    r.weightKg != null && ln('WEIGHT', `${Number(r.weightKg).toFixed(1)} kg`),
    r.bp && ln('BP', `${r.bp.sys}/${r.bp.dia}`),
    r.hb != null && ln('HB', `${r.hb} g/dL`),
    r.tempC != null && ln('TEMP', `${r.tempC} °C`),
    r.respRate != null && ln('BREATHS', `${r.respRate}/min`),
    r.gestWeeks != null && ln('PREGNANCY', `${r.gestWeeks} wk`),
    r.babyAgeDays != null && ln('BABY AGE', `${r.babyAgeDays} d`),
    r.ifaGiven && ln('IFA', r.ifaGiven === true ? 'given' : r.ifaGiven),
  ].filter(Boolean).join('');
  const given = (r.vaccinesGiven || []).map((v) => `<div class="ln ind"><span>${e(v)}</span><span>given</span></div>`).join('');
  const due = (r.vaccinesDue || []).map((v) => `<div class="ln ind"><span>${e(v)}</span><span>due</span></div>`).join('');
  const signs = (r.dangerSigns || []).map((d) => dangerLabel(d, 'en'));
  const denied = (r.dangerSignsDenied || []).map((d) => dangerLabel(d, 'en'));
  const heard = (r.transcript || []).slice(-3).map((t) => `<div class="heard">“${e(typeof t === 'string' ? t : t?.text || '')}”</div>`).join('');
  const receipt = `<div class="receipt">
    <div class="c ttl">ASHA VAANI</div>
    <div class="c">VOICE VISIT SLIP</div>
    <div class="c">${r.ward != null ? `Ward ${e(r.ward)} · ` : ''}Sub-centre register</div>
    <hr>
    ${ln(`SLIP ${slipNo}`, r.lang ? `SPOKEN ${String(r.lang).toUpperCase()}` : '')}
    ${ln(fmtDate(r.visitDate).toUpperCase(), saved ? saved.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '')}
    <hr>
    ${ln(r.name || '—', r.beneficiaryId ? `ID ${r.beneficiaryId}` : (r.isNew ? 'NEW' : ''))}
    <div>${e(VISIT_LABEL[r.visitType] || 'Visit')}</div>
    ${vitals ? `<hr>${vitals}` : ''}
    ${given || due ? `<hr><div>VACCINES</div>${given}${due}` : ''}
    <hr>
    ${signs.length ? `<div class="flag">REFER TO PHC TODAY</div>${signs.map((x) => `<div class="ind">! ${e(x)}</div>`).join('')}` : ln('STATUS', 'ROUTINE')}
    ${denied.length ? `<div class="ind">checked, not present: ${e(denied.join(', '))}</div>` : ''}
    <hr>
    <div class="ln big"><span>NEXT VISIT</span><span>${e(r.nextVisit ? fmtDate(r.nextVisit).toUpperCase() : '—')}</span></div>
    ${heard ? `<hr><div>HEARD</div>${heard}` : ''}
    ${barcodeSvg(r.visitId)}
    <div class="code">${e(String(r.visitId || '').toUpperCase())}</div>
    <div class="thanks">DHANYAVAAD, DIDI</div>
    <div class="c">encrypted on this phone</div>
  </div>`;
  const kv = (k, v, cls = '') => `<div class="kv"><span>${e(k)}</span><span class="${cls}">${e(v)}</span></div>`;
  const cards = `<div class="slip-cards">
    <div class="slip-card"><h3>Weight</h3>
      <div class="amt">${r.weightKg != null ? e(r.weightKg) : '–'} <span class="unit">KG</span></div>
      ${r.bp ? kv('BP', `${r.bp.sys}/${r.bp.dia}`) : ''}${r.hb != null ? kv('Hb', `${r.hb} g/dL`) : ''}${r.tempC != null ? kv('Temp', `${r.tempC} °C`) : ''}
      <div class="note">Range-checked before saving</div>
    </div>
    <div class="slip-card"><h3>Details</h3>
      ${kv('Visit', r.visitType || '—')}
      ${kv('Date', fmtDate(r.visitDate))}
      ${r.ward != null ? kv('Ward', r.ward) : ''}
      ${kv('Next visit', r.nextVisit ? fmtDate(r.nextVisit) : '—', 'hl')}
      ${kv('Status', signs.length ? 'Referred' : 'Routine', signs.length ? 'bad' : '')}
    </div>
  </div>`;
  return `<div class="tray">${receipt}${cards}</div>`;
}

async function refreshLists() {
  try { records = await listRecords(); } catch { records = []; }
  const fu = followupsFrom(records, iso(new Date()));
  $('followList').innerHTML = fu.length ? fu.map((x) => `<li><div class="li-top"><span>${escapeHtml(x.name || '—')}${x.beneficiaryId ? ` <small class="muted">ID ${escapeHtml(x.beneficiaryId)}</small>` : ''}</span><span>${x.refer ? '<span class="chip danger">Refer PHC today</span>' : escapeHtml(fmtDate(x.when))}</span></div><div class="li-sub">${escapeHtml(VISIT_LABEL[x.visitType] || '')}${x.vaccinesDue?.length ? ` · due: ${escapeHtml(x.vaccinesDue.join(', '))}` : ''}${x.refer ? ` · ${escapeHtml(x.dangerSigns.map((d) => dangerLabel(d, 'en')).join(', '))} · next visit ${escapeHtml(fmtDate(x.nextVisit))}` : ''}</div></li>`).join('') : '<li class="empty-note">No follow-ups yet. Saved visits appear here.</li>';
  const refers = fu.filter((x) => x.refer).length;
  $('followCount').hidden = !refers;
  $('followCount').textContent = refers;
  $('recordList').innerHTML = records.length
    ? records.map((r, i) => `<li><details class="glass"${i === 0 ? ' open' : ''}><summary><span class="av${r.referToPHC ? ' refer' : ''}">${initials(r.name)}</span><span class="who"><b>${escapeHtml(r.name || '—')}</b><span>${escapeHtml(VISIT_LABEL[r.visitType] || 'Visit')} · ${escapeHtml(fmtDate(r.visitDate))}${r.referToPHC ? ' · <b class="referred">referred</b>' : ''}</span></span><svg class="chev" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="m9 6 6 6-6 6-1.4-1.4 4.6-4.6-4.6-4.6z"/></svg></summary>${slipHtml(r)}</details></li>`).join('')
    : '<li class="glass empty-note">No saved visits yet. Speak a visit and say “haan” to save it.</li>';
  renderHome(fu);
}

function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${name}`));
  window.scrollTo({ top: 0 });
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
    if (changed.length || fresh.length) renderForm(changed);
    if (fresh.length) speak(agent.L.alert(fresh.map((d) => dangerLabel(d, lang)).join(', ')));
  } catch { /* LLM is optional */ }
}

async function onTranscript(text, meta = {}) {
  text = (text || '').trim();
  if (!text) return;
  const speechEndAt = meta.speechEndAt || vad?.lastVoiceAt || performance.now();
  // follow the language she's actually speaking
  const code = meta.detectedLang?.slice(0, 2);
  if (code && code !== lang && LANGS[code]) {
    langVotes = langVotes.code === code ? { code, n: langVotes.n + 1 } : { code, n: 1 };
    if (langVotes.n >= 2) setLang(code, false);
  } else langVotes = { code: null, n: 0 };

  const res0 = agent.handle(text);
  // nothing usable (room chatter): leave the agent talking and the screen as it was
  if (!res0.say.length && !res0.changed?.length && !res0.saved) { player?.duck(false); return; }
  if (player?.playing || window.speechSynthesis?.speaking) stopSpeaking(); // she spoke over the agent: barge-in
  clearTimeout(deferTimer);
  $('youSaid').textContent = text;
  $('youSaid').classList.remove('muted');

  const res = res0;
  renderForm(res.changed || []);
  if (res.saved) {
    try { await saveRecord(res.saved); } catch (e) { toast(`Could not save: ${e.message}`); }
    lastRendered = {};
    renderForm();
    refreshLists();
  }
  const reply = res.say.join(' ');
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
      if (running) { toast('Connection lost, reconnecting…'); setTimeout(() => { if (running) connect(); }, 1500); }
    };
  });
}

// Browser speech recognition, used only when no Gnani key is configured.
function startBrowserStt() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('This browser has no speech recognition. Use Chrome, or add a Gnani key on the server.'); return; }
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
  recog.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone permission denied.'); };
  recog.start();
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
    } else {
      startBrowserStt();
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
  renderForm();
  refreshLists();
}

// ---------------- wiring ----------------
async function init() {
  try { config = await (await fetch(`/api/config${codeQuery}`)).json(); } catch { /* offline: browser fallback */ }
  setBadge();
  $('lang').value = lang;
  document.documentElement.lang = lang;
  $('talkMode').value = talkMode;
  $('phcNumber').value = pref.get('phc', '');
  $('callPhc').href = `tel:${phoneOnly(pref.get('phc', ''))}`;
  $('retention').value = pref.get('retentionDays', '7');
  renderForm();
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
    if (!confirm('Delete all saved visit records from this phone?')) return;
    await deleteAll();
    await refreshLists();
    toast('All records deleted.');
  });
  $('newVisit').addEventListener('click', () => { agent.reset(); lastRendered = {}; renderForm(); if (running) speak(agent.L.newVisit); });
  $('readback').addEventListener('click', () => { const t = agent.readback(); renderForm(); speak(t); });
  $('saveBtn').addEventListener('click', () => {
    if (agent.state !== 'confirm') { const t = agent.readback(); renderForm(); speak(t); return; }
    onTranscript(lang === 'kn' ? 'ಹೌದು' : lang === 'en' ? 'yes' : 'हाँ');
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
  $('startVisit').addEventListener('click', () => { showTab('visit'); if (!running) start(); });
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
