// Multi-turn snack round: classification of a child reply, step graph, and
// explicit word + full-sentence prompts for each turn.

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
         zh: {six: '正在问你：饿了吗？听完直接开口答。', ten: '正在问你：今天做了什么？听完直接开口答。'},
         wait: {six: 6, ten: 6}},
  really: {cues: {both: ['really']}, zh: {both: '正在回应你：Really?（真的呀？）'}},
  choose: {cues: {both: ['choose']},
           zh: {six: '正在问你：喜欢苹果还是橙子？', ten: '正在问你：喜欢哪种水果？试试说整句。'},
           wait: {six: 7, ten: 7}},
  'like-apple': {cues: {both: ['apples']}, zh: {both: '正在示范整句：I like apples.'}},
  'like-orange': {cues: {both: ['oranges']}, zh: {both: '正在示范整句：I like oranges.'}},
  howabout: {cues: {both: ['howabout']},
             zh: {both: '正在问你：How about you?（轮到你说整句啦）'}, wait: {six: 7, ten: 7}},
  praise: {cues: {six: ['welldone'], ten: ['goodideas']}, zh: {both: '正在夸你刚才那句说得好！'}},
  isee: {cues: {both: ['isee']}, zh: {both: '听到了，接着往下走。'}},
  give: {cues: {both: ['takeone', 'here']}, zh: {both: '送你一份水果：Just take one. Here you are.'}},
  end: {cues: {both: ['thanks', 'seeyou']}, zh: {both: '这一轮结束啦：Thank you. See you!'}},
  again: {cues: {both: ['again']}, zh: {both: '刚才没听清，照着下面的提示再说一次。'}},
};

// Structured prompt card so the child always sees both an easy word entry and
// the target full English sentence to say out loud.
export function promptGuide(level, id, fruit = null) {
  const chosen = fruit === 'orange' ? 'orange' : 'apple';
  const chosenSentence = chosen === 'orange' ? 'I like oranges.' : 'I like apples.';
  const chosenZh = chosen === 'orange' ? '我喜欢橙子。' : '我喜欢苹果。';
  switch (id) {
    case 'open':
      return level === 'ten'
        ? {
          heard: 'What did you do today?（你今天做了什么？）',
          full: 'I played with my friends.',
          sub: '也可以先蹦单词：School / Homework / Played，或用中文说',
        }
        : {
          heard: 'Are you hungry?（你饿了吗？）',
          full: 'Yes, I am hungry.',
          sub: '也可以只说一个词：Yes / Hungry / 饿了',
        };
    case 'choose':
      return level === 'ten'
        ? {
          heard: 'Do you like apples or oranges?',
          full: 'I like apples. / I like oranges.',
          sub: '直接说上面整句；只说 Apple / Orange 或点盘子也行',
        }
        : {
          heard: 'Do you like apples or oranges?',
          full: 'I like apples. / I like oranges.',
          sub: '先说单词 Apple / Orange，或者直接试着说整句、点盘子',
        };
    case 'like-apple':
      return {
        heard: '认真听这句示范，下一句就轮到你说：',
        full: 'I like apples.',
        sub: '意思：我喜欢苹果。',
      };
    case 'like-orange':
      return {
        heard: '认真听这句示范，下一句就轮到你说：',
        full: 'I like oranges.',
        sub: '意思：我喜欢橙子。',
      };
    case 'howabout':
      return {
        heard: '刚才问你：How about you?（你呢？）',
        full: fruit ? chosenSentence : 'I like apples. / I like oranges.',
        sub: level === 'ten'
          ? `大声说出整句（${fruit ? chosenZh : '我喜欢…'}），还可以加一句 It is sweet!`
          : `照着上面这句大声说出来（${fruit ? chosenZh : '说完整的一句英文'}）`,
      };
    case 'again':
      return {
        heard: 'Could you say that again?（再试一次）',
        full: fruit ? chosenSentence : 'I like apples.',
        sub: '靠近麦克风，大声说上面这句或一个单词就行',
      };
    default:
      return null;
  }
}

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
  return (step && step.wait && (step.wait[level] || step.wait.both)) || 6;
}
