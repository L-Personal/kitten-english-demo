const ideas = [
  ['warm', /\b(blankets?|towels?|warm(?:er)?|heat|dry it|dry her|dry him|wrap|dry off)\b/],
  ['safe', /\b(home|shelter|somewhere dry|hotel|inside|indoors?|umbrella|roof|house|boxes?|parking garage|out of the rain)\b/],
  ['drink', /\b(water|drink)\b/],
  ['food', /\b(food|feed|eat|hungry)\b/],
  ['adult', /\b(help|find|ask|call)\b.*\b(mom|mum|dad|mother|father|adult|vet|teacher|grown.?up|parent)s?\b|\b(vet|grown.?up|adult)s?\b/],
];
const normalize = text => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[\u0000-\u001f]/g, ' ').trim();
const ideaFor = text => ideas.find(([,pattern]) => pattern.test(text))?.[0] ?? null;
const isNegative = text => /\b(don't|do not|can't|cannot|shouldn't|won't|wouldn't|never)\b/.test(text) || /^no\b/.test(text);
const isPlan = text => /^(?:well[, ]+|maybe[, ]+|i think[, ]+)*(?:(?:we|i|you)\s+(?:can|could|should|will|would|might|want to|need to)\s+|(?:we|i)'ll\s+|let'?s\s+|how about\s+|(?:the kitten|it|she|he)\s+(?:needs?|would like)\s+)\w+\s+\w+/i.test(text) || /^(?:give|take|bring|wrap|carry|find|get|call|ask|put|keep|make|cover|help|bring|look)\b\s+\w+(?:\s+\w+){1,}/i.test(text);
const isReason = text => /^(?:because|so(?: that)?)\s+\S+\s+\S+/.test(text) || /\b(?:it|she|he|the kitten|the cat|this|that|they)\s+(?:is|are|was|were|has|feels|needs?|seems?|can|could|will|would|might)\s+\w+/.test(text) || /\b(?:it's|she's|he's|they're)\s+\w+/.test(text);

export const initial = () => ({state: {phase: 'plan', tries: 0, idea: null, last: ['opening']}, cues: ['opening']});
function transition(prev, cues, changes = {}) {
  return {state: {...prev, last: cues, ...changes}, cues};
}
function advance(state, cue) {
  if (state.phase === 'plan') return transition(state, [...(cue ? [cue] : []), 'reason'], {phase: 'reason', tries: 0, last: ['reason']});
  return transition(state, [cue || 'finish'], {phase: 'done', tries: 0});
}
function coach(state, style, idea) {
  if (state.tries >= 2) return advance(state, state.phase === 'plan' ? 'move-on' : null);
  const cue = state.tries === 1 ? `example-${state.phase}`
    : idea ? `hint-${idea}` : `${style}-${state.phase}`;
  return transition(state, [cue], {tries: state.tries + 1});
}

export function respond(state, event) {
  if (state.phase === 'done') return {state, cues: []};
  if (event.type === 'stop') return transition(state, ['bye'], {phase: 'done'});
  if (event.type === 'replay') return {state, cues: state.last};
  if (event.type === 'coach') return coach(state, 'help');
  if (event.type === 'silence') return coach(state, 'silence');
  if (event.type === 'continue') return advance(state);
  if (event.type === 'picked-idea') {
    if (state.phase !== 'plan' || !['warm', 'safe', 'adult', 'food', 'drink', 'open'].includes(event.idea)) return {state, cues: []};
    return advance({...state, idea: event.idea === 'open' ? null : event.idea}, `effect-${event.idea}`);
  }
  if (event.type !== 'speech') return {state, cues: []};
  const text = normalize(event.transcript || '');
  if (!text) return coach(state, 'silence');
  if (/^(?:stop|quit|bye|goodbye|end the game)[.!?, ]*$/.test(text) || /^(?:请)?(?:結束|结束|不玩了|停止|再见|再見)[。！!\s]*$/.test(text)) {
    return respond(state, {type: 'stop'});
  }
  if (/再说一遍|重说|再說一遍|重來|^(?:again|repeat|say it again)[.!?, ]*$/.test(text)) return respond(state, {type: 'replay'});
  if (/[\u3400-\u9fff]/.test(text) || /^(?:help(?: me)?|i don.t know)[.!?, ]*$/.test(text)) return coach(state, 'help');
  if (state.phase === 'reason') {
    if (isReason(text)) return advance(state);
    const why = /\bcold\b/.test(text) ? 'cold' : /\b(wet|raining|rain)\b/.test(text) ? 'wet' : null;
    return coach(state, 'hint', why);
  }
  const idea = isNegative(text) ? null : ideaFor(text);
  if (!isNegative(text) && isPlan(text)) return advance({...state, idea}, `effect-${idea || 'open'}`);
  return coach(state, 'hint', idea);
}
