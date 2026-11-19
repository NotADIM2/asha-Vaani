import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripEcho, isBargeIn } from '../public/js/echo.js';
import { Vad } from '../public/js/audio.js';

// What the agent says during a Hindi read-back (as sent to TTS)
const READBACK = 'मैं पढ़कर सुनाती हूँ। सुनीता देवी, ए एन सी, वज़न बावन किलो, अगली विज़िट तीन दिसंबर। क्या सब सही है? हाँ या नहीं बोलिए।';

test('speaker echo with numbers re-written as digits is recognised', () => {
  const r = stripEcho('सुनीता देवी ANC वजन 52 kg अगली visit 3 December', [READBACK], { playing: true });
  assert.equal(r.echo, true);
});

test('echo of the "हाँ" inside the agent\'s own question is never a yes', () => {
  const r = stripEcho('क्या सब सही है हाँ या नहीं बोलिए', [READBACK], { playing: true });
  assert.equal(r.echo, true);
});

test('worker cutting in over the echo is kept, echo part dropped', () => {
  const r = stripEcho('क्या सब सही है नहीं वजन 54 किलो', [READBACK], { playing: true });
  assert.equal(r.echo, false);
  assert.equal(r.rest, 'नहीं वजन 54 किलो');
  assert.ok(isBargeIn(r.restUnits));
});

test('Hinglish correction over the agent is a barge-in', () => {
  const r = stripEcho('nahi weight 54 kilo hai', [READBACK], { playing: true });
  assert.equal(r.echo, false);
  assert.ok(isBargeIn(r.restUnits));
});

test('a short real answer after the agent finished is kept', () => {
  const r = stripEcho('हाँ', [READBACK], { playing: false });
  assert.equal(r.echo, false);
  assert.equal(r.rest, 'हाँ');
});

test('English and Kannada echo are recognised too', () => {
  assert.equal(stripEcho('Sunita Devi weight 52 kg next visit 3 December', ['Let me read it back. Sunita Devi, A N C, weight fifty two kilo, next visit three December. Is everything correct?'], { playing: true }).echo, true);
  assert.equal(stripEcho('ಗೌರಮ್ಮ ತೂಕ 52 ಕೆಜಿ', ['ಓದಿ ಹೇಳುತ್ತೇನೆ. ಗೌರಮ್ಮ, ತೂಕ ಐವತ್ತೆರಡು ಕೆಜಿ.'], { playing: true }).echo, true);
});

test('one stray word is not a barge-in, "ruko" is', () => {
  assert.equal(isBargeIn(['acha']), false);
  assert.equal(isBargeIn(['ruko']), true);
  assert.equal(isBargeIn(['#54']), true);
});

// ---- VAD: feed 32 ms frames of RMS
function run(vad, frames, agentPlaying = false) {
  for (const f of frames) vad.push(f, agentPlaying);
}
const repeat = (v, n) => Array.from({ length: n }, (_, i) => (typeof v === 'function' ? v(i) : v));
// speech: loud with short syllable dips
const speech = (n, level) => repeat((i) => (i % 7 === 6 ? level * 0.25 : level), n);

test('VAD: quiet room, speech starts and ends', () => {
  const ev = [];
  const vad = new Vad({ onStart: () => ev.push('start'), onEnd: () => ev.push('end') });
  run(vad, repeat(0.003, 60));
  run(vad, speech(40, 0.08));
  run(vad, repeat(0.003, 20));
  assert.deepEqual(ev, ['start', 'end']);
});

test('VAD: room gets loud mid-session, VAD keeps ending turns (no stuck "speaking")', () => {
  const ev = [];
  const vad = new Vad({ onStart: () => ev.push('start'), onEnd: () => ev.push('end') });
  run(vad, repeat(0.003, 60));
  // babble starts and stays: fluctuating 0.025-0.04
  const babble = (n) => repeat((i) => 0.025 + 0.015 * Math.abs(Math.sin(i * 0.7)), n);
  run(vad, babble(90));
  ev.length = 0;
  vad.speaking && run(vad, babble(30));
  // near-field worker, ~10 dB above the babble
  run(vad, speech(40, 0.16));
  run(vad, babble(25));
  assert.deepEqual(ev.filter((e) => e === 'start').length >= 1, true);
  assert.equal(ev.at(-1), 'end', 'turn must end once she stops, even with babble');
  assert.equal(vad.speaking, false);
});

test('VAD: steady babble alone stops triggering once learnt', () => {
  const ev = [];
  const vad = new Vad({ onStart: () => ev.push('start'), onEnd: () => ev.push('end') });
  const babble = (n) => repeat((i) => 0.025 + 0.015 * Math.abs(Math.sin(i * 0.7)), n);
  run(vad, babble(120));
  ev.length = 0;
  run(vad, babble(150));
  assert.equal(ev.filter((e) => e === 'start').length, 0);
});

test('ordinals: agent said "दूसरा", STT wrote "2nd" -> still echo', () => {
  const said = 'बाकी टीके: टी डी दूसरा। अगली विज़िट तीन दिसंबर।';
  assert.equal(stripEcho('बाकी टीके TD 2nd अगली विजिट 3 December', [said], { playing: true }).echo, true);
});
