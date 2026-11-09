/**
 * 跨平台的安全替换：先写临时文件，再 rename 到目标。
 *
 * POSIX 上 rename 覆盖已存在文件是原子的、几乎不会失败。Windows 上不是：
 * 目标被杀毒/索引服务（GitHub 的 windows runner 上很典型）或自己短暂打开时，
 * rename 会抛 EPERM/EBUSY/EACCES。CI 实测过：光靠重试不够——5 次全失败。
 * 所以这里的策略是两级：
 *   1) 先按退避重试 rename（累计约 600ms，覆盖绝大多数瞬时占用）
 *   2) 仍然失败就退化成「读临时文件 → 原地覆盖目标 → 删临时文件」
 *      这一步不再原子，但数据一定落地；宁可失去原子性，也不能把记忆写丢。
 * 非可重试错误（ENOENT 之类）立刻抛，不吞。
 */

import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const BACKOFF_MS = [0, 10, 25, 60, 150, 350];

/** 同步睡眠：这些调用点都是同步 API，不能用 await。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * 把 tmp 原子地替换成 target；Windows 上退化为原地覆盖。
 * @param {string} tmp 已写好的临时文件。
 * @param {string} target 目标路径。
 * @param {object} options 注入点（rename/copy/read/remove/sleep），仅供测试。
 * @returns {void} 成功即返回。
 */
export function replaceFile(tmp, target, options = {}) {
  const rename = typeof options.rename === "function" ? options.rename : renameSync;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
  const read = typeof options.read === "function" ? options.read : readFileSync;
  const write = typeof options.write === "function" ? options.write : writeFileSync;
  const remove = typeof options.remove === "function" ? options.remove : rmSync;

  let lastError = null;
  for (let attempt = 0; attempt < BACKOFF_MS.length; attempt += 1) {
    try {
      rename(tmp, target);
      return;
    } catch (error) {
      lastError = error;
      if (!RETRYABLE.has(error && error.code)) throw error;
      sleep(BACKOFF_MS[attempt]);
    }
  }
  // 退避用尽：放弃原子性，保住数据
  try {
    write(target, read(tmp));
    remove(tmp, { force: true });
    return;
  } catch {
    throw lastError;
  }
}
