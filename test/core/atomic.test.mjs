import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { replaceFile } from "../../src/atomic.mjs";

function errnoError(code) {
  const error = new Error(code + ": simulated");
  error.code = code;
  return error;
}

test("atomic: Windows 第一次 EPERM，重试后成功", () => {
  let calls = 0;
  const slept = [];
  replaceFile("/t/a.tmp", "/t/a.json", {
    rename: () => {
      calls += 1;
      if (calls === 1) throw errnoError("EPERM");
    },
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(calls, 2, "应该重试一次就成功");
  assert.deepEqual(slept, [0], "第一次失败后按第一个退避值等待");
});

test("atomic: 不可重试的错误立刻抛出，不重试也不退化", () => {
  let calls = 0;
  assert.throws(
    () =>
      replaceFile("/t/b.tmp", "/t/b.json", {
        rename: () => {
          calls += 1;
          throw errnoError("ENOENT");
        },
        sleep: () => {},
      }),
    /ENOENT/
  );
  assert.equal(calls, 1, "ENOENT 不该重试");
});

test("atomic: rename 一直 EPERM 时退化为原地覆盖，数据不丢", () => {
  let calls = 0;
  let written = null;
  const removed = [];
  replaceFile("/t/c.tmp", "/t/c.json", {
    rename: () => {
      calls += 1;
      throw errnoError("EBUSY");
    },
    sleep: () => {},
    read: () => "payload",
    write: (target, data) => {
      written = [target, data];
    },
    remove: (p, opts) => removed.push([p, opts && opts.force]),
  });
  assert.ok(calls >= 6, "应把退避表跑完，实际 " + calls);
  assert.deepEqual(written, ["/t/c.json", "payload"], "退化路径要原地覆盖目标");
  assert.deepEqual(removed, [["/t/c.tmp", true]], "临时文件要清掉");
});

test("atomic: 默认实现真的把临时文件换过去", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "mnemos-atomic-"));
  t.after(function () {
    rmSync(dir, { recursive: true, force: true });
  });
  const target = join(dir, "x.json");
  const tmp = join(dir, "x.json.tmp");
  writeFileSync(target, "old");
  writeFileSync(tmp, "new");
  replaceFile(tmp, target);
  assert.equal(readFileSync(target, "utf8"), "new");
});
