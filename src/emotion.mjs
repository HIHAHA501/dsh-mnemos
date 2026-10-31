/**
 * 情绪估计：纯规则、零依赖。
 * 不用模型是有意的——这段代码每轮都要跑，一次网络调用换来的精度不值得那份延迟和不确定性。
 */

/** [线索词, valence, arousal 增量]；valence>0 是正向，arousal 是相对中性基线 0.3 的偏移。 */
const LEXICON = [
  ["崩溃", -0.85, 0.5],
  ["难过", -0.7, 0.1],
  ["生气", -0.7, 0.5],
  ["兴奋", 0.7, 0.6],
  ["开心", 0.7, 0.35],
  ["高兴", 0.65, 0.3],
  ["委屈", -0.6, 0.2],
  ["焦虑", -0.55, 0.45],
  ["孤独", -0.6, -0.05],
  ["害怕", -0.6, 0.4],
  ["恐惧", -0.6, 0.4],
  ["失落", -0.5, -0.05],
  ["沮丧", -0.6, 0.0],
  ["无助", -0.6, 0.15],
  ["疲惫", -0.4, 0.05],
  ["郁闷", -0.5, 0.05],
  ["紧张", -0.3, 0.35],
  ["烦躁", -0.55, 0.35],
  ["烦", -0.5, 0.25],
  ["累", -0.35, 0.08],
  ["幸福", 0.8, 0.3],
  ["喜欢", 0.5, 0.25],
  ["感谢", 0.5, 0.15],
  ["满足", 0.5, 0.05],
  ["放松", 0.45, -0.15],
  ["期待", 0.45, 0.3],
  ["安心", 0.4, -0.1],
  ["呜呜", -0.45, 0.25],
  ["哈哈", 0.45, 0.3],
];

const ASCII_LEXICON = [
  ["exhausted", -0.45, 0.05],
  ["tired", -0.35, 0.08],
  ["depressed", -0.7, 0.0],
  ["frustrated", -0.55, 0.4],
  ["overwhelmed", -0.55, 0.45],
  ["anxious", -0.55, 0.45],
  ["lonely", -0.55, -0.05],
  ["sad", -0.6, 0.05],
  ["angry", -0.7, 0.5],
  ["happy", 0.65, 0.35],
  ["glad", 0.6, 0.3],
  ["excited", 0.7, 0.6],
  ["grateful", 0.5, 0.15],
  ["thankful", 0.5, 0.15],
];

const STRONG_INTENSIFIERS = ["特别", "超级", "非常", "十分", "好", "很", "太", "超", "巨"];
const WEAK_INTENSIFIERS = ["有点", "有些", "稍微", "略微", "不太"];

function clamp(value, min, max) {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

function intensityBefore(text, index) {
  const window = text.slice(Math.max(0, index - 3), index);
  for (const word of WEAK_INTENSIFIERS) if (window.endsWith(word)) return 0.55;
  for (const word of STRONG_INTENSIFIERS) if (window.endsWith(word)) return 1.5;
  return 1;
}

function collectMatches(text) {
  const found = [];
  for (const [cue, valence, arousal] of LEXICON) {
    let from = 0;
    for (;;) {
      const index = text.indexOf(cue, from);
      if (index < 0) break;
      found.push({ cue, index, length: cue.length, valence, arousal });
      from = index + cue.length;
    }
  }
  const lower = text.toLowerCase();
  for (const [cue, valence, arousal] of ASCII_LEXICON) {
    const pattern = new RegExp("\\b" + cue + "\\b", "g");
    let match;
    while ((match = pattern.exec(lower)) !== null) {
      found.push({ cue, index: match.index, length: cue.length, valence, arousal });
    }
  }
  // 同一位置长短重叠时留长的（「烦躁」不该同时算成「烦」），否则一句话被重复计权
  found.sort((a, b) => a.index - b.index || b.length - a.length || (a.cue < b.cue ? -1 : 1));
  const kept = [];
  for (const match of found) {
    const overlaps = kept.some(
      (other) => match.index < other.index + other.length && other.index < match.index + match.length
    );
    if (overlaps) continue;
    kept.push(match);
  }
  return kept.sort((a, b) => a.index - b.index);
}

export function estimateEmotion(text) {
  const source = typeof text === "string" ? text : "";
  const matches = source ? collectMatches(source) : [];
  if (!matches.length) return { valence: 0, arousal: 0.3, cues: [] };

  // 程度副词放大的是「有多强」，所以按强度缩放后取平均；
  // 用加权平均的话权重会被自己约掉，「特别烦」和「烦」会算出同一个值。
  let valenceSum = 0;
  let arousalSum = 0;
  const cues = [];
  for (const match of matches) {
    const weight = intensityBefore(source, match.index);
    valenceSum += match.valence * weight;
    arousalSum += match.arousal * weight;
    if (!cues.includes(match.cue)) cues.push(match.cue);
  }

  const count = matches.length;
  let arousal = 0.3 + arousalSum / count;
  if (/[!！]/.test(source)) arousal += 0.08;

  return {
    valence: clamp(valenceSum / count, -1, 1),
    arousal: clamp(arousal, 0, 1),
    cues,
  };
}
