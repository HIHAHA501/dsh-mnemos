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
  replaceFile("/tmp/a.tmp", "/tmp/a.json", {
    rename: () => {
      calls += 1;
      if (calls === 1) throw errnoError("EPERM");
    },
    sleep: (ms) => slept.push(ms),
  });
  assert.equal(calls, 2, "应该重试一次就成功");
  assert.deepEqual(slept, [0], "第一次失败后按第一个退避值等待");
});

test("atomic: 不可重试的错误立刻抛出，不重试", () => {
  let calls = 0;
  assert.throws(
    () =>
      replaceFile("/tmp/b.tmp", "/tmp/b.json", {
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

test("atomic: 一直 EPERM 就抛出最后一次错误，不无限重试", () => {
  let calls = 0;
  assert.throws(
    () =>
      replaceFile("/tmp/c.tmp", "/tmp/c.json", {
        rename: () => {
          calls += 1;
          throw errnoError("EBUSY");
        },
        sleep: () => {},
      }),
    /EBUSY/
  );
  assert.ok(calls > 1 && calls <= 5, "重试次数应有上限，实际 " + calls);
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
