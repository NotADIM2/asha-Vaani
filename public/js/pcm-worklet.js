// Runs on the audio thread: downsamples the mic to 16 kHz, packs 512-sample (1024-byte)
// Int16 frames exactly as Prisma's streaming API expects, and reports frame loudness for VAD.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.frame = new Int16Array(512);
    this.n = 0;
    this.pos = 0;
    this.acc = 0;
    this.cnt = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      // box-filter decimation: average the input samples that fall into one output sample
      this.acc += ch[i];
      this.cnt++;
      this.pos += 1;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.acc / this.cnt));
      this.acc = 0;
      this.cnt = 0;
      this.frame[this.n++] = v < 0 ? v * 0x8000 : v * 0x7fff;
      if (this.n === 512) {
        let sum = 0;
        for (let k = 0; k < 512; k++) { const x = this.frame[k] / 32768; sum += x * x; }
        const pcm = this.frame.slice().buffer;
        this.port.postMessage({ pcm, rms: Math.sqrt(sum / 512) }, [pcm]);
        this.n = 0;
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);
