import {initial, respond} from '../game.mjs';

const chineseIdeas = [
  ['warm', /毯|毛巾|暖|擦乾|擦干/], ['safe', /回家|屋|避雨|雨傘|雨伞|室內|室内/],
  ['adult', /爸爸|媽媽|妈妈|大人|老師|老师|獸醫|兽医/],
  ['food', /吃|貓糧|猫粮|食物/], ['drink', /喝水|給它水|给它水/],
];
const conversation = (t, silence = 0) => ({...t, state:{...t.state, silence}});
export const voiceStart = () => conversation(initial());
export function voiceReply(state, transcript) {
  if (state.phase === 'done') return {state, cues:[]};
  const text = (transcript || '').trim();
  if (!/[\p{L}]/u.test(text)) {
    const silence = state.silence + 1;
    if (silence >= 4) return conversation({state:{...state, phase:'done'}, cues:['voice-pause']}, silence);
    if (silence === 3) return conversation({state, cues:['voice-wait']}, silence);
    return conversation(respond({...state, tries:Math.min(state.tries,1)}, {type:'silence'}), silence);
  }
  // A repeated prompt never pretends to act on an incomplete or unheard reply.
  const input = {...state, tries:Math.min(state.tries,1)};
  const out = respond(input, {type:'speech', transcript:text});
  if (state.phase === 'plan' && out.cues.includes('help-plan') && !/不会|不會|怎么說|怎麼說|怎么说|不懂/.test(text)) {
    const idea = chineseIdeas.find(([, pattern]) => pattern.test(text))?.[0];
    if (idea) {
      const cue = `zh-${idea}`;
      return conversation({state:{...out.state,last:[cue]},cues:[cue]});
    }
  }
  return conversation(out);
}

// Each microphone frame contains 20 ms of mono 16 kHz samples.
export class Gate {
  constructor() { this.reset(); }
  reset() {
    this.lead = []; this.parts = []; this.frames = 0; this.hot = 0;
    this.talking = false; this.quiet = 0;
  }
  push(frame) {
    this.frames++;
    let power = 0;
    for (const sample of frame) power += sample * sample;
    const active = power / frame.length > .011 ** 2;
    if (!this.talking) {
      this.lead.push(frame);
      if (this.lead.length > 12) this.lead.shift();
      this.hot = active ? this.hot + 1 : 0;
      if (this.hot >= 3) { this.talking = true; this.parts = this.lead; this.lead = []; }
      if (!this.talking && this.frames >= 525) { this.reset(); return {kind:'silence'}; }
      return;
    }
    this.parts.push(frame);
    this.quiet = active ? 0 : this.quiet + 1;
    if (this.quiet < 50 && this.parts.length < 400) return;
    const parts = this.parts.slice(0, this.parts.length - Math.max(0, this.quiet - 8));
    const audio = new Float32Array(parts.reduce((n, part) => n + part.length, 0));
    let at = 0;
    for (const part of parts) { audio.set(part,at); at += part.length; }
    this.reset();
    return {kind:'speech', audio};
  }
}
