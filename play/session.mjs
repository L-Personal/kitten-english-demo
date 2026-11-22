import {Gate, voiceReply, voiceStart} from './turns.mjs';

const $ = id => document.getElementById(id);
const voiceStop = '结束试玩';
let run;
const status = (key, text) => {
  $('status').dataset.state = key;
  $('status').textContent = text;
};
const here = s => run === s;
const asset = file => new URL(`./assets/audio/${file}.mp3`, import.meta.url);

function capture(s, enabled) {
  clearTimeout(s.timer);
  s.accept = enabled;
  s.gate.reset();
  s.node?.port.postMessage({listen:enabled});
  for (const track of s.stream?.getAudioTracks() || []) track.enabled = enabled;
}
function end(s, text, failed = false) {
  if (!here(s)) return;
  run = null;
  capture(s,false);
  if (s.source) { try { s.source.stop(); } catch {} }
  s.abort.abort();
  for (const track of s.stream?.getTracks() || []) track.stop();
  s.worker?.terminate();
  s.node?.disconnect();
  s.context?.close().catch(() => {});
  s.lock?.release().catch(() => {});
  $('progress').hidden = $('stop').hidden = true;
  $('restart').hidden = false;
  $('restart').textContent = failed ? '重试语音' : '再玩一次';
  status(failed ? 'error' : 'done',text);
  if (!document.hidden) $('restart').focus({preventScroll:true});
}

function request(s, data = {}) {
  return new Promise((resolve,reject) => {
    const worker = s.worker;
    const signal = s.abort.signal;
    const id = ++s.request;
    const timer = setTimeout(() => finish(reject,new Error('timeout')),data.audio ? 24_000 : 150_000);
    function finish(fn, value) {
      clearTimeout(timer);
      worker.removeEventListener('message',receive);
      worker.removeEventListener('error',failure);
      signal.removeEventListener('abort',failure);
      fn(value);
    }
    function failure() { finish(reject,new Error('recognition unavailable')); }
    function receive({data:reply}) {
      if (reply.id !== id) return;
      if (reply.progress) {
        const {file,loaded,total} = reply.progress;
        if (total && /[.]onnx$/.test(file || '')) {
          s.downloads.set(file,loaded);
          $('progress').value = Math.min(1,[...s.downloads.values()].reduce((a,b)=>a+b,0) / 40852675);
        }
      } else if (reply.error) finish(reject,new Error(reply.error));
      else finish(resolve,reply);
    }
    signal.addEventListener('abort',failure,{once:true});
    worker.addEventListener('message',receive);
    worker.addEventListener('error',failure);
    try { worker.postMessage({...data,id},data.audio ? [data.audio.buffer] : []); }
    catch (err) { finish(reject,err); }
  });
}

async function say(s, cue) {
  if (!here(s)) return;
  if (!s.clips.has(cue)) {
    const response = await fetch(asset(cue),{signal:s.abort.signal});
    if (!response.ok) throw new Error('prompt unavailable');
    s.clips.set(cue,await s.context.decodeAudioData(await response.arrayBuffer()));
  }
  if (!here(s)) return;
  if (s.context.state !== 'running') await s.context.resume();
  const source = s.context.createBufferSource();
  s.source = source;
  source.buffer = s.clips.get(cue);
  source.connect(s.context.destination);
  await new Promise((resolve,reject) => {
    const watchdog = setTimeout(() => reject(new Error('prompt interrupted')),1000*source.buffer.duration+2200);
    source.onended = () => { clearTimeout(watchdog); resolve(); };
    source.start();
  });
  if (s.source === source) s.source = null;
}

async function turn(s, next) {
  if (!here(s)) return;
  capture(s,false);
  s.state = next.state;
  status('play','听故事…');
  try {
    for (const cue of next.cues) {
      await say(s,cue);
      if (cue.startsWith('effect-')) await say(s,`reward-${cue.slice(7)}`);
      if (cue === 'finish') await say(s,'reward-finish');
    }
    if (!here(s)) return;
    if (next.state.phase === 'done') {
      const message = next.cues.includes('finish') ? '小猫安全啦，要睡觉了。' : '故事暂停了，麦克风已关闭。';
      return end(s,message);
    }
    await say(s,'turn');
    if (!here(s)) return;
    status('listen','轮到孩子说了');
    capture(s,true);
    s.timer = setTimeout(() => end(s,'麦克风没有返回声音。请保持页面打开并重试。',true),20_000);
  } catch {
    end(s,'语音没能播放。请打开媒体音量，在系统浏览器中重试。',true);
  }
}

async function heard(s, result) {
  capture(s,false);
  if (result.kind === 'silence') return turn(s,voiceReply(s.state,null));
  status('think','在想怎么接话…');
  try {
    const {text} = await request(s,{audio:result.audio});
    if (here(s)) await turn(s,voiceReply(s.state,text));
  } catch {
    end(s,'本机暂时没能听清。请在安静的地方重试。',true);
  }
}

async function start() {
  if (run) return;
  $('intro').hidden = $('restart').hidden = true;
  $('session').hidden = $('stop').hidden = false;
  $('stop').textContent = voiceStop;
  status('prepare','准备语音，第一次需要加载语音包…');
  const s = run = {abort:new AbortController(),gate:new Gate(),request:0,clips:new Map(),downloads:new Map()};
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.AudioWorkletNode) {
    return end(s,'请用手机的 Safari 或 Chrome 打开语音网页。',true);
  }
  try {
    const Audio = window.AudioContext || window.webkitAudioContext;
    s.context = new Audio();
    const unlocked = s.context.resume();
    // Request permission in the initial gesture; don't process samples while loading or playing prompts.
    const mic = navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true},video:false});
    mic.then(stream => {
      if (!here(s)) { for (const track of stream.getTracks()) track.stop(); return; }
      s.stream = stream;
      capture(s,false);
    }).catch(() => {});
    await Promise.all([unlocked,mic]);
    if (!here(s)) return;
    if (navigator.wakeLock) void navigator.wakeLock.request('screen').then(lock => {
      if (here(s)) s.lock = lock; else void lock.release();
    }).catch(() => {});
    const track = s.stream.getAudioTracks()[0];
    track.addEventListener('ended',() => end(s,'麦克风已断开，请重试。',true),{once:true});
    s.worker = new Worker('./asr-worker.mjs',{type:'module'});
    $('progress').value = 0;
    $('progress').max = 1;
    $('progress').hidden = false;
    const boot = request(s);
    await Promise.all([boot,s.context.audioWorklet.addModule('./mic-worklet.mjs')]);
    if (!here(s)) return;
    const input = s.context.createMediaStreamSource(s.stream);
    s.node = new AudioWorkletNode(s.context,'kitten-mic',{numberOfOutputs:1,outputChannelCount:[1]});
    s.node.port.onmessage = ({data}) => {
      if (!here(s) || !s.accept) return;
      const result = s.gate.push(data);
      if (result) void heard(s,result);
    };
    const mute = s.context.createGain();
    mute.gain.value = 0;
    input.connect(s.node).connect(mute).connect(s.context.destination);
    $('progress').hidden = true;
    const first = voiceStart();
    await turn(s,{...first,cues:['voice-intro',...first.cues]});
  } catch (err) {
    const denied = ['NotAllowedError','PermissionDeniedError','NotFoundError','NotReadableError'].includes(err?.name);
    end(s,denied ? '麦克风没打开。请在浏览器中允许麦克风，再点重试。' : '语音包没能启动。请确认网络后重试。',true);
  }
}

$('start').onclick = $('restart').onclick = start;
$('stop').onclick = () => { if (run) end(run,'试玩已结束，麦克风已关闭。'); };
window.addEventListener('pagehide',() => { if (run) end(run,'已离开页面，麦克风已关闭。'); });
document.addEventListener('visibilitychange',() => { if (document.hidden && run) end(run,'已离开页面，麦克风已关闭。'); });
