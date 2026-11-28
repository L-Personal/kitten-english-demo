import {advance, classify, cues, line, listenSeconds, promptGuide} from './flow.mjs';
import {localSpeech} from './speech.mjs';

const NAMES = {
  hungry: 'are-you-hungry', today: 'what-did-you-do-today', really: 'really',
  choose: 'apples-or-oranges', apples: 'i-like-apples', oranges: 'i-like-oranges',
  howabout: 'how-about-you', welldone: 'well-done', goodideas: 'you-have-good-ideas',
  isee: 'i-see', again: 'could-you-say-that-again', takeone: 'just-take-one',
  here: 'here-you-are', thanks: 'thank-you', seeyou: 'see-you',
};
const ASK = new Set(['open', 'choose', 'howabout']);
const dom = Object.fromEntries(['entry', 'round', 'status', 'sentence', 'sentence-heard', 'sentence-tag',
  'sentence-full', 'sentence-sub', 'progress', 'voice', 'touch', 'repeat', 'back', 'loading', 'audio',
  'star', 'level-six', 'level-ten'].map(id => [id, document.getElementById(id)]));
const fruitButtons = Object.fromEntries(['apple', 'orange'].map(fruit => [fruit, document.getElementById(`pick-${fruit}`)]));
dom.choices = document.querySelector('.choices');
const clip = cue => new URL(`./audio/${NAMES[cue]}.mp3`, import.meta.url).href;
const canceled = () => new DOMException('Playback superseded', 'AbortError');
const Audio = window.AudioContext || window.webkitAudioContext;
const fallback = '语音没接上，点水果继续走完这一轮。';
let level = 'six';
let round;

function deadline(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('Timed out')), ms);
  })]).finally(() => clearTimeout(timer));
}
const isLive = (s, turn = s.turn) => round === s && s.turn === turn;

function renderGuide(s, state) {
  const guide = promptGuide(level, s.step, s.chosen);
  if (!guide || state === 'done') {
    dom.sentence.hidden = true;
    return;
  }
  dom.sentence.hidden = false;
  dom.sentence.dataset.active = String(state === 'listen');
  dom['sentence-heard'].textContent = guide.heard;
  dom['sentence-tag'].textContent = s.step === 'like-apple' || s.step === 'like-orange' ? '示范整句' : '说完整句子';
  dom['sentence-full'].textContent = guide.full;
  dom['sentence-sub'].textContent = guide.sub;
}

function listenBanner(id) {
  if (id === 'howabout') return '🎤 现在轮到你说完整句子！（直接照着下面读）';
  if (id === 'choose') return '🎤 现在请开口选水果！（说整句、单词，或点盘子）';
  return '🎤 现在请开口回答！（说整句或一个词都行）';
}

function show(s, state, text) {
  s.state = state;
  dom.status.dataset.state = state;
  dom.status.textContent = text;
  renderGuide(s, state);
  dom.progress.textContent = s.said ? `已听过 ${s.said} 句真人录音` : '';
  const picking = s.step === 'choose' && ['listen', 'say', 'fallback', 'error'].includes(state);
  dom.choices?.classList.toggle('armed', picking);
  for (const [fruit, button] of Object.entries(fruitButtons)) {
    button.disabled = !picking;
    button.setAttribute('aria-pressed', String(s.answer === fruit));
  }
  dom.repeat.disabled = ['play', 'think', 'done'].includes(state);
  dom.back.textContent = '结束';
}

function closeSpeech(s) {
  clearTimeout(s.listenTimer);
  clearTimeout(s.autoTimer);
  s.speech?.close();
  s.speech = null;
}
function closeAudio(s) {
  s.cancelSound?.();
  s.context?.close().catch(() => {});
  s.context = null;
}
function reset(focus = true) {
  if (!round) return;
  const s = round;
  round = null;
  closeSpeech(s);
  s.abort.abort();
  closeAudio(s);
  dom.entry.hidden = false;
  dom.round.hidden = true;
  dom.sentence.hidden = true;
  dom.star.hidden = true;
  for (const button of Object.values(fruitButtons)) {
    button.disabled = true;
    button.setAttribute('aria-pressed', 'false');
  }
  if (focus) dom.voice.focus({preventScroll: true});
}
function newTurn(s) {
  clearTimeout(s.listenTimer);
  clearTimeout(s.autoTimer);
  s.speech?.record(false);
  s.cancelSound?.();
  return ++s.turn;
}

// ---- audio ---------------------------------------------------------------
function warmClip(s, cue) {
  if (!s.context || s.clips.has(cue)) return s.clips.get(cue);
  const context = s.context;
  const p = (async () => {
    const response = await fetch(clip(cue), {signal: s.abort.signal});
    if (!response.ok) throw new Error('Missing voice clip');
    return context.decodeAudioData(await response.arrayBuffer());
  })();
  p.catch(() => s.clips.delete(cue));
  s.clips.set(cue, p);
  return p;
}
function warmNextClips(s, id) {
  if (!s.context) return;
  const upcoming = id === 'open'
    ? ['really', 'choose']
    : id === 'choose'
      ? ['apples', 'oranges', 'howabout']
      : id === 'howabout'
        ? [level === 'six' ? 'welldone' : 'goodideas', 'takeone', 'here', 'thanks', 'seeyou']
        : [];
  for (const cue of upcoming) warmClip(s, cue);
}
function native(s, cue) {
  const audio = dom.audio;
  return new Promise((resolve, reject) => {
    audio.src = clip(cue);
    const timer = setTimeout(() => finish(new Error('Audio timed out')), 9500);
    const end = () => finish();
    const fail = () => finish(new Error('Audio unavailable'));
    const cancel = () => finish(canceled());
    function finish(err) {
      clearTimeout(timer);
      audio.removeEventListener('ended', end);
      audio.removeEventListener('error', fail);
      if (s.cancelSound === cancel) s.cancelSound = null;
      if (err) { audio.pause(); audio.removeAttribute('src'); audio.load(); reject(err); }
      else resolve();
    }
    s.cancelSound = cancel;
    audio.addEventListener('ended', end, {once: true});
    audio.addEventListener('error', fail, {once: true});
    audio.play().catch(err => { if (s.cancelSound === cancel) finish(err); });
  });
}
function output(s, node, duration) {
  const context = s.context;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Audio interrupted')), duration * 1000 + 2300);
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
    try { node.start(); } catch (err) { finish(err); }
  });
}
async function play(s, cue, turn, forceNative = false) {
  if (forceNative || !s.context) return native(s, cue);
  const context = s.context;
  const clipPromise = warmClip(s, cue);
  const [buffer] = await deadline(Promise.all([clipPromise, s.unlocked]), 7600);
  if (!isLive(s, turn)) return;
  if (context.state !== 'running') await deadline(context.resume(), 1500);
  if (!isLive(s, turn)) return;
  const source = context.createBufferSource();
  source.buffer = buffer;
  await output(s, source, buffer.duration);
}
function ding(s) {
  const context = s.context;
  if (!context || context.state !== 'running') return;
  try {
    const buffer = context.createBuffer(1, Math.round(context.sampleRate * .08), context.sampleRate);
    const tone = buffer.getChannelData(0);
    for (let i = 0; i < tone.length; ++i) {
      const time = i / context.sampleRate;
      tone[i] = .14 * Math.sin(2 * Math.PI * 780 * time) * Math.min(1, time / .01) * Math.exp(-time * 32);
    }
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);
    source.start();
  } catch {}
}

// ---- flow ----------------------------------------------------------------
function mediaFailed(s, text) {
  closeSpeech(s);
  closeAudio(s);
  s.fault = '点水果，也能接着往下走。';
  show(s, 'error', text);
}
async function run(s, id, forceNative = false) {
  if (!isLive(s)) return;
  if (id === 'done') return finish(s);
  s.step = id;
  s.answer = null;
  if (id === 'like-apple') s.chosen = 'apple';
  if (id === 'like-orange') s.chosen = 'orange';
  const turn = newTurn(s);
  warmNextClips(s, id);
  show(s, 'play', `🔊 先听他说：${line(level, id)}`);
  try {
    for (const cue of cues(level, id)) {
      if (!isLive(s, turn)) return;
      await play(s, cue, turn, forceNative);
      if (!isLive(s, turn)) return;
      s.said = (s.said || 0) + 1;
      show(s, 'play', `🔊 先听他说：${line(level, id)}`);
    }
  } catch {
    if (isLive(s, turn)) mediaFailed(s, '这句没播出来。点「再试一次」。');
    return;
  }
  if (id === 'again') return run(s, s.retry || 'choose', forceNative);
  if (id === 'end') return finish(s);
  if (ASK.has(id) && s.voice && s.speech && !s.fault) {
    if (s.ready) return listen(s, id, turn);
    return waitReady(s, id, turn);
  }
  if (id === 'choose') return promptChoice(s, turn);
  s.autoTimer = setTimeout(() => {
    if (isLive(s, turn)) advanceStep(s, id, s.voice ? 'empty' : 'any');
  }, 650);
}
function promptChoice(s, turn) {
  const text = s.voice ? '这句没等到。点苹果或橙子，接着玩。' : '点苹果或橙子，听下一句。';
  show(s, s.voice ? 'fallback' : 'listen', text);
  s.listenTimer = setTimeout(() => {
    if (isLive(s, turn)) advanceStep(s, 'choose', 'empty');
  }, 20_000);
}
async function waitReady(s, id, turn) {
  const pct = s.loadPct ? `（已完成 ${s.loadPct}%）` : '';
  show(s, 'say', `⏳ 首次准备语音识别${pct}，马上就轮到你开口…`);
  try {
    await deadline(s.speech.ready, 30_000);
  } catch {
    if (isLive(s, turn)) { s.fault = fallback; advanceStep(s, id, 'any'); }
    return;
  }
  if (!isLive(s, turn)) return;
  s.ready = true;
  return listen(s, id, turn);
}
function listen(s, id, turn) {
  if (s.fault || !s.speech) return promptChoice(s, turn);
  if (!isLive(s, turn)) return;
  // Switch to the active microphone state immediately without waiting for a tone
  // to finish first, so there is zero dead gap after the human prompt ends.
  show(s, 'listen', listenBanner(id));
  ding(s);
  s.speech.record(true);
  s.listenTimer = setTimeout(() => {
    if (isLive(s, turn)) advanceStep(s, id, 'empty');
  }, listenSeconds(level, id) * 1000);
}
function advanceStep(s, id, kind) {
  clearTimeout(s.listenTimer);
  clearTimeout(s.autoTimer);
  s.speech?.record(false);
  s.cancelSound?.();
  if (id === 'choose' && (kind === 'apple' || kind === 'orange')) s.chosen = kind;
  const next = advance(id, kind, s.misses || 0);
  s.misses = next.misses || 0;
  if (next.id === 'again') {
    s.retry = next.retry;
    void run(s, 'again');
  } else {
    s.misses = 0;
    void run(s, next.id);
  }
}
function finish(s) {
  clearTimeout(s.listenTimer);
  clearTimeout(s.autoTimer);
  closeSpeech(s);
  closeAudio(s);
  s.state = 'done';
  dom.status.dataset.state = 'done';
  dom.status.textContent = '这一轮说完了。想再玩一轮或换一档都行。';
  dom.sentence.hidden = true;
  dom.progress.textContent = `这一轮一共 ${s.said} 句真人录音`;
  dom.star.hidden = false;
  dom.repeat.disabled = false;
  dom.repeat.textContent = '再玩一轮';
  for (const button of Object.values(fruitButtons)) button.disabled = true;
}
async function heard(s, result) {
  if (!isLive(s) || !s.speech || s.state !== 'listen') return;
  clearTimeout(s.listenTimer);
  const turn = s.turn;
  const id = s.step;
  if (result.kind !== 'speech') return advanceStep(s, id, 'empty');
  show(s, 'think', '✨ 听到了，马上回应你…');
  try {
    const job = s.speech.transcribe(result.audio);
    // Open-ended turns ('open' and 'howabout') advance on any spoken answer;
    // cap the UI wait at 900 ms on slow phone CPUs while letting the worker finish.
    const text = id === 'open' || id === 'howabout'
      ? await Promise.race([
        job,
        new Promise(resolve => { setTimeout(() => resolve('ok'), 900); }),
      ])
      : await job;
    if (!isLive(s, turn)) return;
    advanceStep(s, id, classify(text));
  } catch {
    if (isLive(s, turn)) advanceStep(s, id, 'empty');
  }
}

function start(voice) {
  if (round) return;
  dom.repeat.textContent = '再听这句';
  const s = round = {voice, turn: 0, misses: 0, said: 0, chosen: null, loadPct: 0, clips: new Map(), abort: new AbortController()};
  dom.entry.hidden = true;
  dom.round.hidden = false;
  dom.star.hidden = true;
  const capable = voice && Audio && isSecureContext && navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode;
  if (capable) {
    try {
      s.context = new Audio();
      s.unlocked = s.context.resume();
      s.unlocked.catch(() => {});
      s.speech = localSpeech(
        s.context,
        result => void heard(s, result),
        () => { if (isLive(s)) s.fault = fallback; },
        prog => {
          if (!isLive(s) || !prog?.total) return;
          s.loadPct = Math.min(99, Math.max(s.loadPct || 0, Math.round((prog.loaded / prog.total) * 100)));
          if (s.state === 'say') {
            dom.status.textContent = `⏳ 首次准备语音识别（已完成 ${s.loadPct}%），马上就轮到你开口…`;
          }
        },
      );
      deadline(s.speech.ready, 45_000).then(() => {
        if (!isLive(s) || !s.speech) return;
        s.ready = true;
        if (s.state === 'say' && ASK.has(s.step)) void listen(s, s.step, s.turn);
      }).catch(err => {
        if (!isLive(s)) return;
        const denied = ['NotAllowedError', 'NotFoundError', 'NotReadableError', 'SecurityError'].includes(err?.name);
        s.fault = denied ? '麦克风没打开。点水果，也能接着玩。' : fallback;
        if (ASK.has(s.step) && s.state === 'say') promptChoice(s, s.turn);
      });
    } catch {
      closeSpeech(s);
      closeAudio(s);
      s.fault = fallback;
    }
  } else if (voice) s.fault = '这个浏览器不能开语音。点水果，也能接着玩。';
  void run(s, 'open');
}

for (const [name, button] of [['six', dom['level-six']], ['ten', dom['level-ten']]]) {
  if (!button) continue;
  button.onclick = () => {
    if (round) return;
    level = name;
    dom['level-six'].setAttribute('aria-pressed', String(name === 'six'));
    dom['level-ten'].setAttribute('aria-pressed', String(name === 'ten'));
  };
}
dom.voice.onclick = () => start(true);
dom.touch.onclick = () => start(false);
for (const [fruit, button] of Object.entries(fruitButtons)) {
  button.onclick = () => {
    const s = round;
    if (!s || s.step !== 'choose' || s.state === 'done' || s.answer) return;
    s.answer = fruit;
    advanceStep(s, 'choose', fruit);
  };
}
dom.repeat.onclick = () => {
  const s = round;
  if (!s || dom.repeat.disabled) return;
  if (s.state === 'done') { const voice = s.voice; reset(false); start(voice); return; }
  void run(s, s.step || 'open', Boolean(s.fault));
};
dom.back.onclick = () => reset();
window.addEventListener('pagehide', () => reset(false));
document.addEventListener('visibilitychange', () => { if (document.hidden) reset(false); });
dom.loading.hidden = true;
dom.entry.hidden = false;
