// Downsample the device's native clock and transfer 20 ms frames to the gate.
class KittenMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.clear();
    this.port.onmessage = ({data}) => { this.enabled = !!data.listen; this.clear(); };
  }
  clear() {
    this.frame = new Float32Array(320);
    this.pos = this.phase = this.sum = this.n = 0;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!this.enabled || !input) return true;
    for (const sample of input) {
      this.sum += sample;
      this.n++;
      this.phase += 16000;
      if (this.phase < sampleRate) continue;
      this.phase -= sampleRate;
      this.frame[this.pos++] = this.sum / this.n;
      this.sum = this.n = 0;
      if (this.pos === this.frame.length) {
        this.port.postMessage(this.frame, [this.frame.buffer]);
        this.frame = new Float32Array(320);
        this.pos = 0;
      }
    }
    return true;
  }
}
registerProcessor('kitten-mic', KittenMic);
