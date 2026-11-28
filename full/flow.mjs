// Multi-turn snack round: classification of a child reply and the step graph.
// Pure functions only; the browser session drives audio and timing.

const NORMALIZE = value => (value || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").trim();

// apple/orange are the two offered fruit; yes/no answer a yes-or-no question;
// any is a usable answer to an open question; empty is silence or noise.
export function classify(value) {
  const text = NORMALIZE(value);
  if (!text || !/[\p{L}\p{N}]/u.test(text)) return 'empty';
  if (/再.{0,2}[聽听說说]|[聽听]一遍|\brepeat\b|\bsay (?:that|it) again\b|\bagain\b/u.test(text)) return 'repeat';
  const apple = /\bapples?\b|[蘋苹]果/u.test(text);
  const orange = /\boranges?\b|橙/u.test(text);
  if (apple !== orange) return apple ? 'apple' : 'orange';
  const no = /^(?:no|nope|not really)\b|[不沒没]/u.test(text);
  const yes = /^(?:yes|yeah|yep|sure|ok(?:ay)?)\b|[是對对好要]/u.test(text);
  if (yes !== no) return yes ? 'yes' : 'no';
  return 'any';
}

// Each step: the recordings to play in order, the on-screen line, and where a
// reply leads. `again` re-asks the step named by `retry`.
export const STEPS = {
  open: {cues: {six: ['hungry'], ten: ['today']},
         zh: {six: '先听一句，然后随便说点什么。', ten: '先听一句，用你自己的想法回答。'},
         wait: {six: 9, ten: 8}},
  really: {cues: {both: ['really']}, zh: {both: '真人录音在回应你。'}},
  choose: {cues: {both: ['choose']},
           zh: {six: '说 apple、orange，或者点水果。', ten: '说说你想吃哪个，中英文都行。'},
           wait: {six: 9, ten: 8}},
  'like-apple': {cues: {both: ['apples']}, zh: {both: '听完整的一句。'}},
  'like-orange': {cues: {both: ['oranges']}, zh: {both: '听完整的一句。'}},
  howabout: {cues: {both: ['howabout']},
             zh: {both: '换你说一句，想到什么说什么。'}, wait: {six: 10, ten: 9}},
  praise: {cues: {six: ['welldone'], ten: ['goodideas']}, zh: {both: '说得好。'}},
  isee: {cues: {both: ['isee']}, zh: {both: '没关系，往下走。'}},
  give: {cues: {both: ['takeone', 'here']}, zh: {both: '给你一份。'}},
  end: {cues: {both: ['thanks', 'seeyou']}, zh: {both: '这一轮结束了。'}},
  again: {cues: {both: ['again']}, zh: {both: '再说一次，一个词就行。'}},
};

// kind: classify() output. misses: how many times this same question was missed.
export function advance(step, kind, misses = 0) {
  switch (step) {
    case 'open':
      if (kind === 'empty' || kind === 'repeat') return misses < 1 ? {id: 'again', retry: 'open', misses: misses + 1} : {id: 'really'};
      return {id: 'really'};
    case 'really':
      return {id: 'choose'};
    case 'choose':
      if (kind === 'apple') return {id: 'like-apple'};
      if (kind === 'orange') return {id: 'like-orange'};
      if (kind === 'empty' || kind === 'repeat') return misses < 1 ? {id: 'again', retry: 'choose', misses: misses + 1} : {id: 'howabout'};
      return {id: 'isee'};
    case 'like-apple':
    case 'like-orange':
      return {id: 'howabout'};
    case 'howabout':
      if (kind === 'empty' || kind === 'repeat') return misses < 1 ? {id: 'again', retry: 'howabout', misses: misses + 1} : {id: 'praise'};
      return {id: 'praise'};
    case 'praise':
      return {id: 'give'};
    case 'give':
      return {id: 'end'};
    case 'end':
      return {id: 'done'};
    default:
      return {id: 'done'};
  }
}

export function cues(level, id) {
  const step = STEPS[id];
  if (!step) return [];
  return step.cues[level] || step.cues.both || [];
}

export function line(level, id) {
  const step = STEPS[id];
  if (!step) return '';
  return step.zh[level] || step.zh.both || '';
}

export function listenSeconds(level, id) {
  const step = STEPS[id];
  return (step && step.wait && (step.wait[level] || step.wait.both)) || 8;
}
