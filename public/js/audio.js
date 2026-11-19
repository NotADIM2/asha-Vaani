// Mic capture, a small energy VAD (for barge-in and fast endpointing) and a gapless
// streaming PCM player.

const workletReady = new WeakMap(); // AudioContext -> addModule promise (a processor can be registered once)

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.stream = null;
    this.node = null;
    this.label = '';
    this.fellBack = false;
    this.onEnded = null;
  }

  // deviceId '' = the browser default. If the chosen mic is gone (earbuds out of range),
  // fall back to the default instead of failing the visit.
  async start(onFrame, deviceId = '') {
    const base = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 };
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: deviceId ? { ...base, deviceId: { exact: deviceId } } : base });
    } catch (e) {
      if (!deviceId || !['OverconstrainedError', 'NotFoundError', 'NotReadableError', 'AbortError'].includes(e.name)) throw e;
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: base });
      this.fellBack = true;
    }
    const track = this.stream.getAudioTracks()[0];
    this.label = track?.label || '';
    // a Bluetooth headset that disconnects or switches profile ends the track
    track?.addEventListener('ended', () => this.onEnded?.());
    if (!workletReady.has(this.ctx)) workletReady.set(this.ctx, this.ctx.audioWorklet.addModule('/js/pcm-worklet.js'));
    await workletReady.get(this.ctx);
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-capture');
    this.node.port.onmessage = (e) => onFrame(e.data);
    const sink = this.ctx.createGain();
    sink.gain.value = 0;
    src.connect(this.node);
    this.node.connect(sink);
    sink.connect(this.ctx.destination);
  }

  stop() {
    this.onEnded = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); }
    this.stream = null;
    this.node = null;
  }
}

export async function listMics() {
  try { return (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch { return []; }
}

// Loudness of one mic over a few seconds, judged on the same scale as the VAD (RMS of
// 16 kHz frames): silent = nothing is arriving, quiet = below the VAD's speech floor.
export function judgeLevel(peak) {
  if (peak < 0.002) return 'silent';
  if (peak < 0.02) return 'quiet';
  return 'ok';
}

// Energy VAD on 32 ms frames, used for ducking, fast endpointing and the idle pause (never
// to cut the agent off on its own: in speaker mode or a noisy room that is confirmed by
// the transcript, see echo.js).
// The noise floor is the quietest frame of the last ~2 s ("minimum statistics"), so it
// follows a room that gets louder even while someone keeps talking. A floor learnt only
// in silence would freeze the moment the noise starts and the VAD would never end.
export class Vad {
  constructor({ onStart, onEnd } = {}) {
    this.hist = new Float32Array(62).fill(0.004);
    this.hi = 0;
    this.floor = 0.004;
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.lastVoiceAt = 0;
    this.startAt = 0;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.level = 0;
  }

  push(rms, agentPlaying) {
    this.level = rms;
    this.hist[this.hi] = Math.max(rms, 0.0005);
    this.hi = (this.hi + 1) % this.hist.length;
    let min = Infinity;
    for (const v of this.hist) if (v < min) min = v;
    this.floor = 0.85 * this.floor + 0.15 * min;
    // ~9.5 dB above the room (12 dB while the agent's own voice is in the room)
    const thr = Math.max(this.floor * (agentPlaying ? 4 : 3), agentPlaying ? 0.03 : 0.01);
    const voiced = rms > thr;
    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
      this.lastVoiceAt = performance.now();
    } else {
      this.silentRun++;
      this.voicedRun = 0;
    }
    if (!this.speaking && this.voicedRun >= 4) { // ~130 ms of voice
      this.speaking = true;
      this.startAt = performance.now();
      this.onStart?.(agentPlaying);
    } else if (this.speaking && this.silentRun >= 11) { // ~350 ms of silence
      this.speaking = false;
      this.onEnd?.();
    }
  }
}

export class Player {
  constructor(ctx, sampleRate) {
    this.ctx = ctx;
    this.sampleRate = sampleRate;
    this.gain = ctx.createGain();
    this.gain.connect(ctx.destination);
    this.sources = new Set();
    this.current = null;
    this.endAt = 0;
    this.streamDone = true;
    this.onFirstAudio = null;
    this.onIdle = null;
  }

  begin(id, onFirstAudio) {
    this.stop();
    this.current = id;
    this.endAt = 0;
    this.streamDone = false;
    this.onFirstAudio = onFirstAudio;
    this.gain.gain.cancelScheduledValues(this.ctx.currentTime);
    this.gain.gain.value = 1;
  }

  push(id, int16) {
    if (id !== this.current || !int16.length) return;
    const f32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768;
    const buf = this.ctx.createBuffer(1, f32.length, this.sampleRate);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);
    const startAt = Math.max(this.ctx.currentTime + 0.01, this.endAt);
    src.start(startAt);
    this.endAt = startAt + buf.duration;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.checkIdle();
    };
    if (this.onFirstAudio) {
      const cb = this.onFirstAudio;
      this.onFirstAudio = null;
      cb(performance.now() + (startAt - this.ctx.currentTime) * 1000);
    }
  }

  finish(id) {
    if (id !== this.current) return;
    this.streamDone = true;
    this.checkIdle();
  }

  checkIdle() {
    if (this.current !== null && this.streamDone && this.sources.size === 0) {
      this.current = null;
      this.onIdle?.();
    }
  }

  get playing() {
    return this.current !== null;
  }

  duck(on) {
    this.gain.gain.setTargetAtTime(on ? 0.3 : 1, this.ctx.currentTime, 0.03);
  }

  stop() {
    for (const s of this.sources) { try { s.stop(); } catch { /* already stopped */ } }
    this.sources.clear();
    const was = this.current;
    this.current = null;
    this.endAt = 0;
    return was;
  }
}
