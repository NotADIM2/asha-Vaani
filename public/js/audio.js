// Mic capture, a small energy VAD (for barge-in and fast endpointing) and a gapless
// streaming PCM player.

export class Mic {
  constructor(ctx) {
    this.ctx = ctx;
    this.stream = null;
    this.node = null;
  }

  async start(onFrame) {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    await this.ctx.audioWorklet.addModule('/js/pcm-worklet.js');
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
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    this.stream = null;
    this.node = null;
  }
}

// Adaptive-threshold VAD on 32 ms frames. While the agent is talking the threshold is
// raised so leftover echo doesn't count as the user interrupting.
export class Vad {
  constructor({ onStart, onEnd } = {}) {
    this.floor = 0.004;
    this.speaking = false;
    this.voicedRun = 0;
    this.silentRun = 0;
    this.lastVoiceAt = 0;
    this.onStart = onStart;
    this.onEnd = onEnd;
    this.level = 0;
  }

  push(rms, agentPlaying) {
    this.level = rms;
    const thr = Math.max(this.floor * (agentPlaying ? 7 : 3), agentPlaying ? 0.045 : 0.012);
    const voiced = rms > thr;
    if (!voiced && !this.speaking && !agentPlaying) this.floor = 0.95 * this.floor + 0.05 * Math.max(rms, 0.001);
    if (voiced) {
      this.voicedRun++;
      this.silentRun = 0;
      this.lastVoiceAt = performance.now();
    } else {
      this.silentRun++;
      this.voicedRun = 0;
    }
    if (!this.speaking && this.voicedRun >= (agentPlaying ? 6 : 4)) {
      this.speaking = true;
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
    this.gain.gain.setTargetAtTime(on ? 0.2 : 1, this.ctx.currentTime, 0.03);
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
