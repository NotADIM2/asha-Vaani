// Runs on the audio thread: resamples the mic to 16 kHz, packs 512-sample (1024-byte)
// Int16 frames exactly as Prisma's streaming API expects, and reports frame loudness for VAD.
// The context rate follows the output device: 44.1/48 kHz normally, but a Bluetooth headset
// in hands-free mode can run it at 8 kHz, which has to be upsampled (or the voice reaches
// Prisma at double speed and comes back as "speech unclear").
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000; // input samples per output sample
    this.frame = new Int16Array(512);
    this.n = 0;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
    this.prev = 0;
  }

  emit(v) {
    v = Math.max(-1, Math.min(1, v));
    this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
    if (this.n === 512) {
      let sum = 0;
      for (let k = 0; k < 512; k++) { const x = this.frame[k] / 32768; sum += x * x; }
      const pcm = this.frame.slice().buffer;
      this.port.postMessage({ pcm, rms: Math.sqrt(sum / 512) }, [pcm]);
      this.n = 0;
    }
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    if (this.ratio >= 1) {
      // downsample: box-filter decimation, average the input samples behind one output sample
      for (let i = 0; i < ch.length; i++) {
        this.acc += ch[i];
        this.cnt++;
        this.pos += 1;
        if (this.pos < this.ratio) continue;
        this.pos -= this.ratio;
        this.emit(this.acc / this.cnt);
        this.acc = 0;
        this.cnt = 0;
      }
    } else {
      // upsample: linear interpolation between neighbouring input samples
      for (let i = 0; i < ch.length; i++) {
        const x = ch[i];
        while (this.pos < 1) {
          this.emit(this.prev + (x - this.prev) * this.pos);
          this.pos += this.ratio;
        }
        this.pos -= 1;
        this.prev = x;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
