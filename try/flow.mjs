export const entries = Object.freeze({first:'先说一句', plan:'你来定计划'});

const actions = {
  draw: [/\b(draw|drawing|paint|painting)\b|画画|畫畫|画一[幅张]|畫一[幅張]|绘画|塗色|涂色/u,'draw'],
  soccer: [/\b(soccer|football|kick(?: the)? ball)\b|踢(?:足)?球|打球|足球/u,'soccer'],
  cards: [/\b(cards|card game)\b|(?:玩|打)牌|扑克牌|撲克牌/u,'cards'],
  read: [/\b(read|books?)\b|看书|看書|读书|讀書/u,'read'],
  inside: [/\b(inside|indoors|go home|stay in|go in)\b|屋里|屋裡|室内|室內|进屋|進屋|家里|家裡|在家|回家/u,'door'],
  wait: [/\b(wait|stops raining)\b|等(?:一等|一下|会儿|會兒|雨|一会|一會)|雨停|等$/u,'rain'],
};
const choices = { first:['draw','soccer','cards','read'], plan:['inside','wait'],
  inside:['cards','draw','read'], wait:['cards','read','draw'] };
const clean = text => (text || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").trim();
const segment = /[,，。;；.!！？?]|\bbut\b|但是|不过|不過/u;
const anyLetter = /\p{L}/u;
const negative = /\b(no|not|don't|do not|can't|cannot|never|won't|instead of)\b|别|別|不(?:要|想|去|玩|能|会|會|用|喜欢|喜歡)|不是/u;
const replay = /再(?:说|說|听|聽|讲|講)(?:一)?遍|重(?:听|聽|播)|没听(?:清|见)|沒聽(?:清|見)|^(?:请|請)?在[听聽]一遍[\s.!！。?？]*$|^(?:can you )?(?:replay|repeat|say (?:it |that )?again|again)\b/u;
const stop = /^(?:结束试玩|結束試玩|停止|再[见見]|stop(?: the game)?|quit|goodbye|bye|结束|結束)[\s.!！。?？,，]*$/u;
const pass = /^(?:先不选了|先不選了|先这样|先這樣|到这里|到這裡|skip|pass)[\s.!！。?？]*$/u;
const noIdea = /没(?:有)?(?:想好|点子|主意|想法)|沒(?:有)?(?:想好|點子|主意|想法)|想不到|不知道|\bno idea\b|\bdon't know\b/u;
const noEnglish = /英语|英語|英文|怎么说|怎麼說|不会说|不會說|\bin english\b|\bhow (?:do you|to) say\b/u;

const result = (state, cues) => ({state,cues});
const finish = (state, cues) => result({...state,phase:'done',last:[]},cues);
const question = phase => `${phase}-ask`;
const again = (state, cues, misses) => result({...state,last:cues,misses},cues);
export function startTrial(mode) {
  if (!Object.hasOwn(entries,mode)) throw new RangeError('Unknown entry');
  const last = [`${mode}-intro`,question(mode)];
  return result({mode,phase:mode,last,misses:0},last);
}
export const repeat = state => result(state,state.last);

export function hear(state, transcript) {
  if (state.phase === 'done') return repeat(state);
  const text = clean(transcript);
  const phase = state.phase;
  const extra = phase === 'inside' || phase === 'wait';
  if (stop.test(text)) return finish(state,['bye']);
  if (replay.test(text)) return repeat(state);
  if (extra && pass.test(text)) return finish(state,['pass']);

  const positives = text.split(segment).filter(clause => !negative.test(clause));
  const matches = Object.keys(actions).filter(id => positives.some(clause => actions[id][0].test(clause)));
  // An indoor plan may mention the activity, but two competing choices are not a decision.
  const allowed = matches.filter(id => choices[phase].includes(id));
  if (allowed.length === 1 && (matches.length === 1 || phase === 'plan')) {
    const [id] = allowed;
    const act = [`say-${id}`,`fx-${actions[id][1]}`];
    if (phase !== 'plan') return finish(state,act);
    const last = [question(id)];
    return result({...state,phase:id,last,misses:0},[...act,...last]);
  }

  const misses = state.misses + 1;
  if (misses >= 3) return finish(state,extra ? ['pass'] : ['pause']);
  if (noEnglish.test(text) || /^(?:我)?不[会會][.!！。?？]*$/u.test(text)) return again(state,['use-chinese'],misses);
  if (!anyLetter.test(text) || noIdea.test(text) || pass.test(text)) return again(state,[`${phase}-ideas`],misses);
  return again(state,['clarify',question(phase)],misses);
}
