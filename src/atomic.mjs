/**
 * 跨平台的安全替换：先写临时文件，再 rename 到目标。
 *
 * POSIX 上 rename 覆盖已存在文件是原子的、几乎不会失败。Windows 上不是：
 * 目标文件被杀毒/索引服务或我们自己短暂打开时，rename 会抛 EPERM/EBUSY/EACCES，
 * 而且往往下一次就成功了。CI 的 windows-latest 就是这么红的
 * （EPERM: operation not permitted, rename ...records.jsonl）。
 * 所以这里对这几个可重试错误做短暂退避，其它错误立刻抛出，不吞。
 */

import { renameSync } from "node:fs";

const RETRYABLE = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
/** 累计约 160ms：够跨过 Windows 上那一下文件句柄竞争，又不至于让写盘卡住。 */
const BACKOFF_MS = [0, 5, 15, 40, 100];

/** 同步睡眠：这些调用点都是同步 API，不能用 await。 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  const cell = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(cell, 0, 0, ms);
}

/**
 * 把 tmp 原子地替换成 target，对 Windows 的瞬时占用重试。
 * @param {string} tmp 已写好的临时文件。
 * @param {string} target 目标路径。
 * @param {{rename?: Function, sleep?: Function}} options 注入点，仅供测试。
 * @returns {void} 成功即返回。
 */
export function replaceFile(tmp, target, options = {}) {
  const rename = typeof options.rename === "function" ? options.rename : renameSync;
  const sleep = typeof options.sleep === "function" ? options.sleep : sleepSync;
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
  throw lastError;
}
