const workerURL = new URL('../play/asr-worker.mjs', import.meta.url);
const workletURL = new URL('../play/mic-worklet.mjs', import.meta.url);
const aborted = () => new DOMException('Round ended','AbortError');

export function localSpeech(context, onInput, onLoss) {
  const controller = new AbortController(), {signal} = controller;
  let gate, stream, node, input, mute, worker, listening = false, nextID = 0;

  function record(enabled) {
    listening = enabled;
    gate?.reset();
    node?.port.postMessage({listen:enabled});
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
    worker?.terminate();
  }
  function ask(audio) {
    if (signal.aborted) return Promise.reject(aborted());
    return new Promise((resolve,reject) => {
      const id = ++nextID;
      const timer = setTimeout(() => fail(new Error('Speech timed out')),audio ? 16_000 : 42_000);
      const fail = err => finish(reject, err instanceof Error ? err : new Error('Speech unavailable'));
      const cancel = () => fail(aborted());
      const receive = ({data}) => {
        if (data.id !== id || data.progress) return;
        if (data.error) fail(new Error(data.error));
        else finish(resolve,data);
      };
      function finish(action,value) {
        clearTimeout(timer);
        signal.removeEventListener('abort',cancel);
        worker.removeEventListener('message',receive);
        worker.removeEventListener('error',fail);
        action(value);
      }
      signal.addEventListener('abort',cancel,{once:true});
      worker.addEventListener('message',receive);
      worker.addEventListener('error',fail);
      try { worker.postMessage({id,audio},audio ? [audio.buffer] : []); }
      catch (err) { fail(err); }
    });
  }
  const ready = (async () => {
    const mic = await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    if (signal.aborted) { for (const track of mic.getTracks()) track.stop(); throw aborted(); }
    stream = mic;
    record(false);
    for (const track of stream.getAudioTracks()) track.addEventListener('ended',onLoss,{once:true});
    worker = new Worker(workerURL,{type:'module'});
    const [ack,{Gate}] = await Promise.all([ask(),import('../play/turns.mjs'),context.audioWorklet.addModule(workletURL)]);
    if (signal.aborted) throw aborted();
    if (!ack.ready) throw new Error('Unexpected ASR response');
    gate = new Gate();
    input = context.createMediaStreamSource(stream);
    node = new AudioWorkletNode(context,'kitten-mic',{numberOfOutputs:1,outputChannelCount:[1]});
    mute = context.createGain();
    mute.gain.value = 0;
    node.port.onmessage = ({data}) => {
      if (!listening || signal.aborted) return;
      const result = gate.push(data);
      if (result) { record(false); onInput(result); }
    };
    input.connect(node).connect(mute).connect(context.destination);
  })();
  return {ready,record,close,async transcribe(audio) { return (await ask(audio)).text; }};
}
