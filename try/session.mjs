import {Gate} from '../play/turns.mjs';
import {entries, startTrial, hear, repeat} from './flow.mjs';

const $ = id => document.getElementById(id);
const micModule = new URL('../play/mic-worklet.mjs',import.meta.url);
const asr = new URL('../play/asr-worker.mjs',import.meta.url);
let run;
let chosen;
const live = s => run === s;
const clip = cue => new URL(`./audio/${cue}.mp3`,import.meta.url);
function status(state, text) {
  $('status').dataset.state = state;
  $('status').textContent = text;
  $('replay').disabled = state !== 'listen';
}
function listen(s, enabled) {
  clearTimeout(s.timer);
  s.listening = enabled;
  s.gate.reset();
  s.node?.port.postMessage({listen:enabled});
  for (const track of s.stream?.getAudioTracks() || []) track.enabled = enabled;
}
function close(s, text, error = false) {
  if (!live(s)) return;
  run = null;
  listen(s,false);
  s.abort.abort();
  if (s.source) { try { s.source.stop(); } catch {} }
  for (const track of s.stream?.getTracks() || []) track.stop();
  s.worker?.terminate();
  s.node?.disconnect();
  s.context?.close().catch(() => {});
  s.lock?.release().catch(() => {});
  $('replay').hidden = $('stop').hidden = $('progress').hidden = $('help').hidden = true;
  $('restart').hidden = $('back').hidden = false;
  $('restart').textContent = error ? '重试语音' : '再玩一次';
  status(error ? 'error' : 'done', text);
  if (!document.hidden) $('restart').focus({preventScroll:true});
}

function recognize(s, audio) {
  return new Promise((resolve,reject) => {
    const {worker,abort:{signal}} = s;
    const id = ++s.id;
    const fail = () => finish(reject,new Error('recognizer unavailable'));
    const timer = setTimeout(fail,audio ? 24_000 : 150_000);
    function finish(fn,value) {
      clearTimeout(timer);
      worker.removeEventListener('message',received);
      worker.removeEventListener('error',fail);
      signal.removeEventListener('abort',fail);
      fn(value);
    }
    function received({data}) {
      if (data.id !== id) return;
      if (data.progress) return;
      if (data.error) finish(reject,new Error(data.error));
      else finish(resolve,data);
    }
    worker.addEventListener('message',received);
    worker.addEventListener('error',fail);
    signal.addEventListener('abort',fail,{once:true});
    try { worker.postMessage({id,audio},audio ? [audio.buffer] : []); }
    catch (err) { finish(reject,err); }
  });
}
function loadClip(s,cue) {
  if (!s.clips.has(cue)) s.clips.set(cue,(async () => {
    const res = await fetch(clip(cue),{signal:s.abort.signal});
    if (!res.ok) throw new Error('missing audio');
    return s.context.decodeAudioData(await res.arrayBuffer());
  })());
  return s.clips.get(cue);
}
async function playClip(s,cue) {
  if (!live(s)) return;
  const buffer = await loadClip(s,cue);
  if (!live(s)) return;
  if (s.context.state !== 'running') await s.context.resume();
  if (!live(s)) return;
  const source = s.source = s.context.createBufferSource();
  source.buffer = buffer;
  source.connect(s.context.destination);
  try {
    await new Promise((resolve,reject) => {
      const timer = setTimeout(() => reject(new Error('playback interrupted')),buffer.duration*1000+2500);
      source.onended = () => { clearTimeout(timer); resolve(); };
      try { source.start(); } catch (err) { clearTimeout(timer); reject(err); }
    });
  } finally {
    source.disconnect();
    if (s.source === source) s.source = null;
  }
}
async function play(s,next,replaying = false) {
  if (!live(s)) return;
  listen(s,false);
  s.state = next.state;
  status('play',replaying ? '再听一遍…' : '听搭档说…');
  try {
    // Load in parallel so there is no extra gap between an answer and its effect.
    await Promise.all(next.cues.map(cue => loadClip(s,cue)));
    for (const cue of next.cues) await playClip(s,cue);
    if (!live(s)) return;
    if (s.state.phase === 'done') {
      const chose = next.cues.some(cue => cue.startsWith('fx-'));
      return close(s,chose ? '就这么定！麦克风已关闭。' : '试玩到这里。麦克风已关闭。');
    }
    await playClip(s,'ding');
    if (!live(s)) return;
    status('listen','轮到你说了 · 正在听');
    $('help').hidden = false;
    listen(s,true);
    s.timer = setTimeout(() => close(s,'麦克风没有返回声音。请保持页面打开，再试一次。',true),20_000);
  } catch {
    close(s,'声音没能播放。请打开媒体音量，在手机浏览器中重试。',true);
  }
}
async function heard(s,result) {
  listen(s,false);
  if (result.kind === 'silence') return play(s,hear(s.state,null));
  status('think','在听你说的这句…');
  try {
    const {text} = await recognize(s,result.audio);
    if (live(s)) await play(s,hear(s.state,text));
  } catch {
    close(s,'本机语音没能接上。可以在安静一点的地方重试。',true);
  }
}
async function start(mode) {
  if (run) return;
  const first = startTrial(mode);
  chosen = mode;
  $('sample').pause();
  $('intro').hidden = $('restart').hidden = $('back').hidden = true;
  $('session').hidden = $('stop').hidden = $('replay').hidden = false;
  $('mode').textContent = entries[mode];
  status('prepare','准备语音。第一次要加载语音包…');
  const s = run = {abort:new AbortController(),gate:new Gate(),id:0,clips:new Map()};
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    return close(s,'请在手机 Safari 或 Chrome 里打开。也可以返回试听声音。',true);
  }
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    s.context = new Audio();
    const unlocked = s.context.resume();
    const mic = navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false}).then(stream => {
      if (!live(s)) { for (const track of stream.getTracks()) track.stop(); return; }
      s.stream = stream;
      listen(s,false);
    });
    await Promise.all([unlocked,mic]);
    if (!live(s)) return;
    if (navigator.wakeLock) void navigator.wakeLock.request('screen').then(lock => {
      if (live(s)) s.lock = lock; else void lock.release();
    }).catch(() => {});
    const track = s.stream.getAudioTracks()[0];
    track.addEventListener('ended',() => close(s,'麦克风已断开，请重试。',true),{once:true});
    s.worker = new Worker(asr,{type:'module'});
    $('progress').hidden = false;
    await Promise.all([recognize(s),s.context.audioWorklet.addModule(micModule),...['ding',...first.cues].map(cue => loadClip(s,cue))]);
    if (!live(s)) return;
    const input = s.context.createMediaStreamSource(s.stream);
    s.node = new AudioWorkletNode(s.context,'kitten-mic',{numberOfOutputs:1,outputChannelCount:[1]});
    s.node.port.onmessage = ({data}) => {
      if (!live(s) || !s.listening) return;
      const result = s.gate.push(data);
      if (result) void heard(s,result);
    };
    const mute = s.context.createGain();
    mute.gain.value = 0;
    input.connect(s.node).connect(mute).connect(s.context.destination);
    $('progress').hidden = true;
    await play(s,first);
  } catch (err) {
    const denied = ['NotAllowedError','PermissionDeniedError','NotFoundError','NotReadableError'].includes(err?.name);
    close(s,denied ? '麦克风没打开。可在浏览器中允许麦克风后重试，也可返回先试听。' : '语音包没能启动。确认网络后重试，或返回先试听。',true);
  }
}

for (const mode of Object.keys(entries)) $(mode).onclick = () => { void start(mode); };
$('restart').onclick = () => { void start(chosen); };
$('replay').onclick = () => { if (run?.listening) void play(run,repeat(run.state),true); };
$('stop').onclick = () => { if (run) close(run,'试玩已结束，麦克风已关闭。'); };
$('back').onclick = () => { $('session').hidden = true; $('intro').hidden = false; $(chosen).focus(); };
$('sample').addEventListener('error',() => { $('sample-note').textContent = '试听没能加载，刷新页面再试。'; });
function leave() {
  $('sample').pause();
  if (run) close(run,'已离开试玩，麦克风已关闭。');
}
window.addEventListener('pagehide',leave);
document.addEventListener('visibilitychange',() => { if (document.hidden) leave(); });
