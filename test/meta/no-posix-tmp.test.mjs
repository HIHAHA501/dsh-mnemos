/**
 * 一条守卫用例：测试里不许出现 POSIX 临时目录的字面量。
 *
 * 为什么值得单独守：`"/tmp/x"` 在 macOS / Linux 上是临时目录，在 Windows 上会被解释成
 * 当前盘根的 `C:\tmp\x`——不是 `%TEMP%`。这不是「跑不跑得通」的问题：那一行今天只是
 * 一个不落盘的配置值，明天有人拿它去 `mkdir` 就会写到用户的盘根，而 CI 依然全绿。
 * 想用临时目录，一律 `join(tmpdir(), ...)`（见各测试文件顶部的 DATA_DIR / ENV_DATA_DIR）。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const TEST_ROOT = fileURLToPath(new URL("..", import.meta.url));
// 拆成三段拼出来：这个文件自己也不能出现那个字面量，否则守卫会扫到自己
const POSIX_TMP = ["", "tmp", ""].join("/");

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith(".test.mjs")) out.push(full);
  }
  return out;
}

function isComment(line) {
  const text = line.trimStart();
  return text.startsWith("//") || text.startsWith("/*") || text.startsWith("*");
}

test("测试里不许硬编码 POSIX 临时目录（Windows 上会落到当前盘根）", () => {
  const offenders = [];
  for (const file of testFiles(TEST_ROOT)) {
    const lines = readFileSync(file, "utf8").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (isComment(lines[index])) continue;
      if (!lines[index].includes(POSIX_TMP)) continue;
      offenders.push(relative(TEST_ROOT, file) + ":" + (index + 1));
    }
  }
  assert.deepEqual(offenders, [], "改用 join(tmpdir(), ...)：\n" + offenders.join("\n"));
});
