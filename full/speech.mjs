const workerURL = new URL('../play/asr-worker.mjs', import.meta.url);
const workletURL = new URL('../play/mic-worklet.mjs', import.meta.url);
const aborted = () => new DOMException('Round ended', 'AbortError');

let sharedWorker = null;
let sharedReady = null;
let nextID = 0;
let progressListener = null;

// Fast end-of-speech gate tuned for short child utterances on phones:
// adapts to room noise floor, trims after ~360 ms of trailing silence, and caps
// any single utterance at ~2.7 s so background noise cannot stall the turn for 8 s.
export class FastGate {
  constructor() { this.reset(); }
  reset() {
    this.lead = [];
    this.parts = [];
    this.frames = 0;
    this.hot = 0;
    this.talking = false;
    this.quiet = 0;
    this.noise = 0.004 ** 2;
  }
  push(frame) {
    this.frames++;
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const mean = power / frame.length;
    if (!this.talking) {
      const startThreshold = Math.max(0.011 ** 2, Math.min(0.035 ** 2, this.noise * 3.2));
      const active = mean > startThreshold;
      if (!active) {
        this.noise = Math.min(0.025 ** 2, this.noise * 0.92 + mean * 0.08);
      }
      this.lead.push(frame);
      if (this.lead.length > 10) this.lead.shift();
      this.hot = active ? this.hot + 1 : 0;
      if (this.hot >= 2) {
        this.talking = true;
        this.parts = this.lead;
        this.lead = [];
      }
      if (!this.talking && this.frames >= 260) {
        this.reset();
        return {kind: 'silence'};
      }
      return;
    }
    const keepThreshold = Math.max(0.009 ** 2, Math.min(0.028 ** 2, this.noise * 2.2));
    const active = mean > keepThreshold;
    this.parts.push(frame);
    this.quiet = active ? 0 : this.quiet + 1;
    if (this.quiet < 18 && this.parts.length < 135) return;
    const parts = this.parts.slice(0, this.parts.length - Math.max(0, this.quiet - 5));
    const audio = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) {
      audio.set(part, at);
      at += part.length;
    }
    this.reset();
    return {kind: 'speech', audio};
  }
}

function sendWorker(worker, signal, audio) {
  if (signal?.aborted) return Promise.reject(aborted());
  return new Promise((resolve, reject) => {
    const id = ++nextID;
    const timer = setTimeout(() => fail(new Error('Speech timed out')), audio ? 12_000 : 42_000);
    const fail = err => finish(reject, err instanceof Error ? err : new Error('Speech unavailable'));
    const cancel = () => fail(aborted());
    const receive = ({data}) => {
      if (data.id !== id) return;
      if (data.progress) {
        progressListener?.(data.progress);
        return;
      }
      if (data.error) fail(new Error(data.error));
      else finish(resolve, data);
    };
    function finish(action, value) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      worker.removeEventListener('message', receive);
      worker.removeEventListener('error', fail);
      action(value);
    }
    signal?.addEventListener('abort', cancel, {once: true});
    worker.addEventListener('message', receive);
    worker.addEventListener('error', fail);
    try {
      worker.postMessage({id, audio}, audio ? [audio.buffer] : []);
    } catch (err) {
      fail(err);
    }
  });
}

function ensureWorker(onProgress) {
  progressListener = onProgress || null;
  if (sharedWorker && sharedReady) return sharedReady;
  try {
    const worker = new Worker(workerURL, {type: 'module'});
    sharedWorker = worker;
    sharedReady = sendWorker(worker, null, undefined).then(ack => {
      if (!ack?.ready) throw new Error('Unexpected ASR response');
      return worker;
    }).catch(err => {
      try { worker.terminate(); } catch {}
      if (sharedWorker === worker) {
        sharedWorker = null;
        sharedReady = null;
      }
      throw err;
    });
    return sharedReady;
  } catch (err) {
    sharedWorker = null;
    sharedReady = null;
    return Promise.reject(err);
  }
}

export function localSpeech(context, onInput, onLoss, onProgress) {
  const controller = new AbortController();
  const {signal} = controller;
  let gate, stream, node, input, mute, listening = false;

  // Start loading the local ASR worker immediately in parallel with the browser
  // microphone permission prompt so the child does not wait twice in series.
  const workerPromise = ensureWorker(onProgress);

  function record(enabled) {
    listening = enabled;
    gate?.reset();
    node?.port.postMessage({listen: enabled});
    for (const track of stream?.getAudioTracks() || []) track.enabled = enabled;
  }
  function close() {
    if (signal.aborted) return;
    record(false);
    controller.abort();
    for (const track of stream?.getTracks() || []) track.stop();
    if (node) { node.port.onmessage = null; node.port.close(); node.disconnect(); }
    input?.disconnect();
    mute?.disconnect();
  }
  const ready = (async () => {
    const micPromise = navigator.mediaDevices.getUserMedia({
      audio: {channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true},
      video: false,
    });
    const workletPromise = context.audioWorklet.addModule(workletURL);
    let mic;
    try {
      mic = await micPromise;
    } catch (err) {
      throw err;
    }
    if (signal.aborted) {
      for (const track of mic.getTracks()) track.stop();
      throw aborted();
    }
    stream = mic;
    record(false);
    for (const track of stream.getAudioTracks()) track.addEventListener('ended', onLoss, {once: true});
    await Promise.all([workerPromise, workletPromise]);
    if (signal.aborted) throw aborted();
    gate = new FastGate();
    input = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context, 'kitten-mic', {numberOfOutputs: 1, outputChannelCount: [1]});
    mute = context.createGain();
    mute.gain.value = 0;
    node.port.onmessage = ({data}) => {
      if (!listening || signal.aborted) return;
      const result = gate.push(data);
      if (result) {
        record(false);
        onInput(result);
      }
    };
    input.connect(node).connect(mute).connect(context.destination);
  })();
  return {
    ready,
    record,
    close,
    async transcribe(audio) {
      const worker = await workerPromise;
      return (await sendWorker(worker, signal, audio)).text;
    },
  };
}
