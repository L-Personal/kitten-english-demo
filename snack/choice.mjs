// A reply is either one supported choice, a replay request, or unrecognized.
export function choice(value) {
  const text = (value || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'");
  if (/再.{0,2}[聽听說说]|[聽听]一遍|\brepeat\b|\bsay (?:that|it) again\b/u.test(text)) return 'repeat';
  if (/\b(?:no|not|never|don'?t|can'?t|wouldn'?t)\b|不(?:要|是|想|[會会]|喜[歡欢]|吃|懂|知道)|[沒没](?:有|[學学])/u.test(text)) return null;
  const apple = /\bapples?\b|[蘋苹]果/u.test(text);
  const orange = /\boranges?\b|橙/u.test(text);
  return apple === orange ? null : apple ? 'apple' : 'orange';
}
