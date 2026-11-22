import {choice} from './choice.mjs';
import {localSpeech} from './speech.mjs';

const dom = Object.fromEntries(['entry','round','status','sentence','voice','touch','repeat','back','loading','audio']
  .map(id => [id,document.getElementById(id)]));
const fruitButtons = Object.fromEntries(['apple','orange'].map(fruit => [fruit,document.getElementById(`pick-${fruit}`)]));
const replies = {apple:'I like apples.', orange:'I like oranges.'};
const files = {question:'apples-or-oranges',apple:'i-like-apples',orange:'i-like-oranges',clarify:'say-that-again'};
const clip = cue => new URL(`./${files[cue]}.mp3`,import.meta.url).href;
const canceled = () => new DOMException('Playback superseded','AbortError');
const Audio = window.AudioContext || window.webkitAudioContext;
const fallback = '语音暂时没接上。点苹果或橙子，也能继续。';
let round;

function deadline(promise,ms) {
  let timer;
  return Promise.race([promise,new Promise((_,reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')),ms);
  })]).finally(() => clearTimeout(timer));
}
function isLive(s,turn = s.turn) { return round === s && s.turn === turn; }
function show(s,state,text) {
  s.state = state;
  dom.status.dataset.state = state;
  dom.status.textContent = text;
  dom.sentence.hidden = !s.answer;
  dom.sentence.textContent = replies[s.answer] || '';
  for (const [fruit,button] of Object.entries(fruitButtons)) {
    button.disabled = Boolean(s.answer);
    button.setAttribute('aria-pressed',String(s.answer === fruit));
  }
  dom.repeat.disabled = ['prompt','reply','think'].includes(state);
  dom.repeat.textContent = state === 'error' ? '重试听' : s.answer ? '再听这句' : '再听一遍';
  dom.back.textContent = s.answer ? '再玩一次' : '结束';
}
function closeSpeech(s) {
  clearTimeout(s.listeningTimer);
  s.speech?.close();
  s.speech = null;
}
function closeAudio(s) {
  s.context?.close().catch(() => {});
  s.context = null;
}
function reset(focus = true) {
  if (!round) return;
  const s = round;
  round = null;
  closeSpeech(s);
  s.abort.abort();
  s.cancelSound?.();
  closeAudio(s);
  dom.entry.hidden = false;
  dom.round.hidden = true;
  for (const button of Object.values(fruitButtons)) {
    button.disabled = true;
    button.setAttribute('aria-pressed','false');
  }
  if (focus) dom[s.voice ? 'voice' : 'touch'].focus({preventScroll:true});
}
function newTurn(s) {
  clearTimeout(s.listeningTimer);
  s.speech?.record(false);
  s.cancelSound?.();
  return ++s.turn;
}
function native(s,cue) {
  const audio = dom.audio;
  return new Promise((resolve,reject) => {
    audio.src = clip(cue);
    const timer = setTimeout(() => finish(new Error('Audio timed out')),9500);
    const end = () => finish();
    const fail = () => finish(new Error('Audio unavailable'));
    const cancel = () => finish(canceled());
    function finish(err) {
      clearTimeout(timer);
      audio.removeEventListener('ended',end);
      audio.removeEventListener('error',fail);
      if (s.cancelSound === cancel) s.cancelSound = null;
      if (err) { audio.pause(); audio.removeAttribute('src'); audio.load(); reject(err); }
      else resolve();
    }
    s.cancelSound = cancel;
    audio.addEventListener('ended',end,{once:true});
    audio.addEventListener('error',fail,{once:true});
    audio.play().catch(err => { if (s.cancelSound === cancel) finish(err); });
  });
}
function output(s,node,duration) {
  const context = s.context;
  return new Promise((resolve,reject) => {
    const timer = setTimeout(() => finish(new Error('Audio interrupted')),duration*1000+2300);
    const cancel = () => finish(canceled());
    function finish(err) {
      clearTimeout(timer);
      node.onended = null;
      if (s.cancelSound === cancel) s.cancelSound = null;
      if (err) { try { node.stop(); } catch {} }
      node.disconnect();
      if (err) reject(err); else resolve();
    }
    s.cancelSound = cancel;
    node.connect(context.destination);
    node.onended = () => finish();
    try { node.start(); }
    catch (err) { finish(err); }
  });
}
async function play(s,cue,turn,forceNative = false) {
  if (forceNative || !s.context) return native(s,cue);
  const context = s.context;
  if (!s.clips.has(cue)) {
    const p = (async () => {
      const response = await fetch(clip(cue),{signal:s.abort.signal});
      if (!response.ok) throw new Error('Missing voice clip');
      return context.decodeAudioData(await response.arrayBuffer());
    })();
    p.catch(() => s.clips.delete(cue));
    s.clips.set(cue,p);
  }
  const [buffer] = await deadline(Promise.all([s.clips.get(cue),s.unlocked]),7600);
  if (!isLive(s,turn)) return;
  if (context.state !== 'running') await deadline(context.resume(),1500);
  if (!isLive(s,turn)) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  await output(s,source,buffer.duration);
}
async function listen(s,turn) {
  if (s.fault) return show(s,'fallback',s.fault);
  const context = s.context;
  const buffer = context.createBuffer(1,Math.round(context.sampleRate*.18),context.sampleRate);
  const tone = buffer.getChannelData(0);
  for (let i=0; i<tone.length; ++i) {
    const time = i/context.sampleRate;
    tone[i] = .18*Math.sin(2*Math.PI*740*time)*Math.min(1,time/.013)*Math.exp(-time*24);
  }
  const source = context.createBufferSource();
  source.buffer = buffer;
  await output(s,source,buffer.duration);
  if (!isLive(s,turn)) return;
  if (s.fault) { closeAudio(s); return show(s,'fallback',s.fault); }
  if (!s.speech) return;
  show(s,'listen','轮到你说了：apple、orange，或中文。');
  s.speech.record(true);
  s.listeningTimer = setTimeout(() => speechFailed(s,'先歇一会儿。想选了就点一个水果。'),14_000);
}
function speechFailed(s,text) {
  if (!isLive(s) || s.answer || !s.speech) return;
  closeSpeech(s);
  s.fault = text;
  if (s.state !== 'prompt' && s.state !== 'error') {
    s.cancelSound?.();
    closeAudio(s);
    show(s,'fallback',text);
  }
}
function mediaFailed(s,text) {
  closeSpeech(s);
  closeAudio(s);
  if (s.voice && !s.answer) s.fault = '点一个水果，也可以继续玩。';
  show(s,'error',text);
}
async function question(s,cue = 'question',forceNative = false) {
  const turn = newTurn(s);
  show(s,'prompt',cue === 'clarify' ? '再说一次，一个词就行。' : '先听问题。');
  try {
    await play(s,cue,turn,forceNative);
    if (!isLive(s,turn)) return;
    if (s.fault) { closeAudio(s); return show(s,'fallback',s.fault); }
    if (!s.speech) return show(s,'touch','点一个水果，听完整的英语句子。');
    if (!s.ready) return show(s,'prepare','语音正在准备。也可以直接点水果。');
    await listen(s,turn);
  } catch {
    if (isLive(s,turn)) mediaFailed(s,'这句没播出来。可以重试听，或直接点水果。');
  }
}
async function answer(s,fruit,spoken = false) {
  if (!isLive(s) || s.answer) return;
  const turn = newTurn(s);
  s.answer = fruit;
  closeSpeech(s);
  if (!spoken) closeAudio(s);
  await reply(s,turn,!spoken);
}
async function reply(s,turn,forceNative) {
  show(s,'reply',`${s.answer === 'apple' ? '苹果' : '橙子'}选好了，听这一句。`);
  try {
    await play(s,s.answer,turn,forceNative);
    if (isLive(s,turn)) {
      closeAudio(s);
      show(s,'done','你选好了。');
    }
  } catch {
    if (isLive(s,turn)) mediaFailed(s,'这句没播出来。点「重试听」再试一次。');
  }
}
async function heard(s,result) {
  if (!isLive(s) || s.state !== 'listen' || !s.speech) return;
  clearTimeout(s.listeningTimer);
  const turn = s.turn;
  if (result.kind !== 'speech') return speechFailed(s,'没听到声音。想选了就点一个水果。');
  show(s,'think','在听你说的这句…');
  try {
    const text = await s.speech.transcribe(result.audio);
    if (!isLive(s,turn)) return;
    const picked = choice(text);
    if (picked === 'repeat') return question(s);
    if (picked) return answer(s,picked,true);
    if (++s.misses === 1) return question(s,'clarify');
    speechFailed(s,'这次没听清。点苹果或橙子，也能继续。');
  } catch {
    if (isLive(s,turn)) speechFailed(s,fallback);
  }
}
function start(voice) {
  if (round) return;
  const s = round = {voice,turn:0,misses:0,clips:new Map(),abort:new AbortController()};
  dom.entry.hidden = true;
  dom.round.hidden = false;
  const capable = voice && Audio && isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode;
  if (capable) {
    try {
      s.context = new Audio();
      s.unlocked = s.context.resume();
      s.unlocked.catch(() => {});
      s.speech = localSpeech(s.context,result => void heard(s,result),() => speechFailed(s,fallback));
      deadline(s.speech.ready,45_000).then(() => {
        if (!isLive(s) || !s.speech) return;
        s.ready = true;
        if (s.state === 'prepare') void question(s);
      }).catch(err => {
        const permission = ['NotAllowedError','NotFoundError','NotReadableError','SecurityError'].includes(err?.name);
        speechFailed(s,permission ? '麦克风没打开。点一个水果，也能继续。' : fallback);
      });
    } catch {
      closeSpeech(s);
      closeAudio(s);
      s.fault = fallback;
    }
  } else if (voice) s.fault = '这个浏览器不能开语音。点一个水果，也能继续。';
  void question(s);
}

dom.voice.onclick = () => start(true);
dom.touch.onclick = () => start(false);
for (const [fruit,button] of Object.entries(fruitButtons)) button.onclick = () => { if (round) void answer(round,fruit); };
dom.repeat.onclick = () => {
  const s = round;
  if (!s || dom.repeat.disabled) return;
  if (s.answer) void reply(s,newTurn(s),true);
  else void question(s,'question',Boolean(s.fault));
};
dom.back.onclick = () => reset();
window.addEventListener('pagehide',() => reset(false));
document.addEventListener('visibilitychange',() => { if (document.hidden) reset(false); });
dom.loading.hidden = true;
dom.entry.hidden = false;
