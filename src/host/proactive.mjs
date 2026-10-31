/**
 * 主动召回的三态判定：直接引用 / 试探性提起 / 沉默。
 *
 * 判定只吃「一个分数 + 阈值」，所以规则能脱离检索层单独测；
 * 措辞也收在这里，否则同一句提醒会在注入层和工具层各演化一版。
 */

export const STATES = Object.freeze(["quote", "ask", "silence"]);

/** 提示最多占多少字：主动召回是搭头，不该抢走注入预算的大头。 */
export const HINT_CHAR_CAP = 160;

// 用户说过「想不起 / 忘了」这类话，就说明这段记忆本身不确定；
// 命中时不能把它当成确定的事实讲出来，只能降级成试探。
const RECALL_CONSTRAINT = /想不起|记不起|记不清|不记得|忘了|忘记/;

function num(value, fallback) {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clip(text, max) {
  const source = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
  return source.length <= max ? source : source.slice(0, max - 1) + "…";
}

/** 这段文本是否自带「我记不清」的约束。 */
export function hasRecallConstraint(text) {
  return RECALL_CONSTRAINT.test(String(text == null ? "" : text));
}

/**
 * 三态判定。
 * 噪声阈值是排斥边界（等于它就算噪音）；两档阈值是包含边界（等于它就进这一档）。
 * @param {{score?: number, config?: object, text?: string}} input 判定输入。
 * @returns {{state: string, score: number, reason: string}} 判定结果。
 */
export function decide(input = {}) {
  const proactive = (input.config && input.config.proactive) || {};
  const noiseFloor = num(proactive.noiseFloor, 0.18);
  const askThreshold = num(proactive.askThreshold, 0.45);
  const quoteThreshold = num(proactive.quoteThreshold, 0.62);
  const score = Number.isFinite(input.score) ? Number(input.score) : 0;

  if (!(score > noiseFloor)) return { state: "silence", score, reason: "noise" };

  // 阈值被配反时按「必须同时越过两档」判引用档：宁可少提，也不要把试探当事实。
  const quoteAt = Math.max(quoteThreshold, askThreshold);
  const askAt = Math.min(quoteThreshold, askThreshold);

  if (score >= quoteAt) {
    if (hasRecallConstraint(input.text)) return { state: "ask", score, reason: "recall-constraint" };
    return { state: "quote", score, reason: "quote-threshold" };
  }
  if (score >= askAt) return { state: "ask", score, reason: "ask-threshold" };
  return { state: "silence", score, reason: "below-ask" };
}

/**
 * 记忆已经列在注入块里时的提醒：只说「该不该提起」，不再抄一遍正文。
 * 同一段事实在一轮里出现两次，模型会当成两件事。
 * @param {{state: string}} decision 判定结果。
 * @returns {string|null} 提醒文本。
 */
export function renderReference(decision) {
  if (!decision) return null;
  if (decision.state === "quote") {
    return "[主动想起] 上面第一条现在就对得上，可以自然地提起它；对不上就当没看见，别硬提，也别补细节。";
  }
  if (decision.state === "ask") {
    return "[试探想起] 上面第一条你并不确定，先问一句是不是同一件事，别当成事实讲。";
  }
  return null;
}

/**
 * 把判定渲染成给模型看的一句提醒；沉默档返回 null（不注入空壳）。
 * 引用档是「你可以讲」，试探档是「先确认」，两句话的主语都是模型而不是记忆库。
 * @param {{state: string}} decision 判定结果。
 * @param {object} record 命中的记忆。
 * @returns {string|null} 提醒文本。
 */
export function renderHint(decision, record) {
  if (!decision || !record) return null;
  if (decision.state !== "quote" && decision.state !== "ask") return null;
  const text = clip(record.text, HINT_CHAR_CAP);
  if (!text) return null;
  if (decision.state === "quote") {
    return "[主动想起] 你记得这件事：" + text + "\n对得上现在的话题就自然提起；对不上就别硬提，也不要把细节补全。";
  }
  return "[试探想起] 你隐约记得：" + text + "\n先问一句是不是同一件事，别当成事实讲。";
}
