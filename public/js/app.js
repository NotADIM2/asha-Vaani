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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function refreshLists() {
  try { records = await listRecords(); } catch { records = []; }
  const fu = followupsFrom(records, iso(new Date()));
  $('followList').innerHTML = fu.length ? fu.map((x) => `<li><div class="li-top"><span>${escapeHtml(x.name || '—')}${x.beneficiaryId ? ` <small class="muted">ID ${x.beneficiaryId}</small>` : ''}</span><span>${x.refer ? '<span class="chip danger">Refer PHC today</span>' : escapeHtml(fmtDate(x.when))}</span></div><div class="li-sub">${escapeHtml(VISIT_LABEL[x.visitType] || '')}${x.vaccinesDue?.length ? ` · due: ${escapeHtml(x.vaccinesDue.join(', '))}` : ''}${x.refer ? ` · ${escapeHtml(x.dangerSigns.map((d) => dangerLabel(d, 'en')).join(', '))} · next visit ${escapeHtml(fmtDate(x.nextVisit))}` : ''}</div></li>`).join('') : '<li class="empty-note">No follow-ups yet. Saved visits appear here.</li>';
  const refers = fu.filter((x) => x.refer).length;
  $('followCount').hidden = !refers;
  $('followCount').textContent = refers;
  $('recordList').innerHTML = records.length ? records.map((r) => `<li><div class="li-top"><span>${escapeHtml(r.name || '—')}</span><span class="muted">${escapeHtml(fmtDate(r.visitDate))}</span></div><div class="li-sub">${escapeHtml(VISIT_LABEL[r.visitType] || '')} · ${r.weightKg ?? '–'} kg${r.referToPHC ? ' · <b style="color:var(--danger)">referred</b>' : ''}</div><details><summary>Full record</summary><pre>${escapeHtml(JSON.stringify(r, null, 2))}</pre></details></li>`).join('') : '<li class="empty-note">No saved visits.</li>';
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
  if (running) setStatus('listening');
}

function speak(text, { speechEndAt = null } = {}) {
  if (!text) return;
  $('agentSaid').textContent = text;
  $('agentSaid').classList.remove('muted');
  speakingText = text;
  stopSpeaking();
  setStatus('speaking');
  if (config.gnani && player && ws?.readyState === 1) {
    const id = sayId++;
    player.begin(id, (at) => recordTtfa(at, speechEndAt));
    const cached = ttsCache.get(`${lang}|${text}`);
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
    u.onend = () => { if (running) setStatus('listening'); };
    speechSynthesis.speak(u);
  }
}

// Fixed prompts are pre-synthesised once so they can play with near-zero latency.
function prewarm() {
  if (!config.gnani || !ws || ws.readyState !== 1) return;
  const L = agent.L;
  const texts = [L.askWeight, L.askVaccinesDue, L.askBeneficiary, L.askVisitType, L.notUnderstood, L.refuse, L.whatWrong, L.askCorrectWeight, L.newVisit];
  texts.forEach((text, i) => {
    const key = `${lang}|${text}`;
    if (ttsCache.has(key)) return;
    setTimeout(() => {
      const id = sayId++;
      caching.set(id, { key, chunks: [], silent: true });
      ws.send(JSON.stringify({ type: 'say', id, text, lang }));
    }, 1500 + i * 700);
  });
}

// ---------------- understanding ----------------
function isEcho(text) {
  if (!speakingText || performance.now() > speakingUntil + 2500) return false;
  const said = new Set(tokenize(speakingText).map((t) => t.key));
  const heard = tokenize(text).map((t) => t.key).filter((k) => k.length > 1);
  if (heard.length < 2) return false;
  const overlap = heard.filter((k) => said.has(k)).length / heard.length;
  return overlap >= 0.6;
}

async function llmAssist(text) {
  if (!config.llm) return;
  try {
    const res = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, lang }) });
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
  if (isEcho(text)) return;
  const speechEndAt = meta.speechEndAt || vad?.lastVoiceAt || performance.now();
  if (player?.playing || window.speechSynthesis?.speaking) stopSpeaking(); // she spoke over the agent: barge-in
  clearTimeout(deferTimer);
  $('youSaid').textContent = text;
  $('youSaid').classList.remove('muted');

  // follow the language she's actually speaking
  const code = meta.detectedLang?.slice(0, 2);
  if (code && code !== lang && LANGS[code]) {
    langVotes = langVotes.code === code ? { code, n: langVotes.n + 1 } : { code, n: 1 };
    if (langVotes.n >= 2) setLang(code, false);
  } else langVotes = { code: null, n: 0 };

  const res = agent.handle(text);
  renderForm(res.changed || []);
  if (res.saved) {
    try { await saveRecord(res.saved); } catch (e) { toast(`Could not save: ${e.message}`); }
    lastRendered = {};
    renderForm();
    refreshLists();
  }
  const reply = res.say.join(' ');
  if (res.deferrable && talkMode === 'handsfree') {
    // give her a moment to keep dictating before asking the next question
    deferTimer = setTimeout(() => { if (!vad?.speaking) speak(reply, { speechEndAt }); }, 450);
  } else {
    speak(reply, { speechEndAt });
  }
  if (!res.changed?.length && !res.saved && text.split(/\s+/).length >= 3 && agent.state !== 'confirm') llmAssist(text);
}

// ---------------- connection ----------------
function connect() {
  return new Promise((resolve) => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
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
        case 'stt_speech_start': if (player?.playing) player.duck(true); break;
        case 'stt_processing': setStatus('thinking'); break;
        case 'stt_transcript':
          player?.duck(false);
          onTranscript(m.text, { detectedLang: m.detected_language_code });
          if (!player?.playing) setStatus('listening');
          break;
        case 'stt_error': toast(`Speech service: ${m.message}`); break;
        case 'tts_end': {
          const c = caching.get(m.id);
          if (c) { if (c.chunks.length) ttsCache.set(c.key, c.chunks); caching.delete(m.id); }
          player?.finish(m.id);
          break;
        }
        case 'tts_error': caching.delete(m.id); toast(`Voice output failed: ${m.message}`); break;
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
      if (r.isFinal) onTranscript(r[0].transcript, { speechEndAt: performance.now() });
      else $('youSaid').textContent = r[0].transcript;
    }
  };
  recog.onspeechstart = () => { if (window.speechSynthesis?.speaking) stopSpeaking(); };
  recog.onend = () => { if (running) { try { recog.start(); } catch { /* already running */ } } };
  recog.onerror = (e) => { if (e.error === 'not-allowed') toast('Microphone permission denied.'); };
  recog.start();
}

function onFrame({ pcm, rms }) {
  $('level').style.width = `${Math.min(100, Math.round(rms * 900))}%`;
  vad.push(rms, player?.playing || false);
  if (!config.gnani || ws?.readyState !== 1) return;
  if (talkMode === 'ptt' && !pttDown) return;
  ws.send(pcm);
}

async function start() {
  if (running) return;
  running = true;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  await ctx.resume();
  player = new Player(ctx, config.ttsSampleRate || 24000);
  player.onIdle = () => { speakingUntil = performance.now(); if (running) setStatus('listening'); };
  vad = new Vad({
    onStart: (overAgent) => {
      // barge-in: she started talking while the agent was speaking
      if (overAgent && player?.playing) stopSpeaking();
      if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
    },
    onEnd: () => {
      // short answers (yes/no, a number, a date): close the utterance now instead of
      // waiting for the server's longer dictation pause
      if (config.gnani && ws?.readyState === 1 && agent.state !== 'dictate' && talkMode === 'handsfree') ws.send(JSON.stringify({ type: 'commit' }));
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
}

// ---------------- wiring ----------------
async function init() {
  try { config = await (await fetch('/api/config')).json(); } catch { /* offline: browser fallback */ }
  const badge = $('modeBadge');
  badge.textContent = config.gnani ? 'Gnani live' : 'browser speech';
  badge.className = `badge ${config.gnani ? 'live' : 'fallback'}`;
  $('lang').value = lang;
  document.documentElement.lang = lang;
  $('talkMode').value = talkMode;
  $('phcNumber').value = pref.get('phc', '');
  $('callPhc').href = `tel:${pref.get('phc', '')}`;
  $('retention').value = pref.get('retentionDays', '7');
  renderForm();
  refreshLists();
  setStatus('idle');

  const micBtn = $('mic');
  micBtn.addEventListener('click', () => { if (!running) start(); else if (player?.playing || window.speechSynthesis?.speaking) stopSpeaking(); });
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
  $('phcNumber').addEventListener('change', (e) => { pref.set('phc', e.target.value.trim()); $('callPhc').href = `tel:${e.target.value.trim()}`; });
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
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
    document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x.id === `tab-${b.dataset.tab}`));
  }));
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

init();
