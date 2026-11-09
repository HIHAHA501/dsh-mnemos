#!/usr/bin/env node
/**
 * dsh-mnemos 装机脚本：把插件真正装进 DSH profile，而不是"看上去装上了"。
 *
 * 为什么必须声明依赖再跑 pnpm install（这是实测事故，不是理论风险）：
 *   只往 dsh.profile.bundles 追加条目、把文件拷进 node_modules，产出的状态会被宿主的
 *   pnpm install 当成"无关目录"修剪掉——实际发生过：node_modules/dsh-mnemos 整个消失，
 *   宿主报 cannot resolve profile bundle "dsh-mnemos"。所以正确模型是两件事一起做：
 *     ① 在 dsh.profile.bundles 里声明要在插件列表里（bundles 决定"加载谁"）；
 *     ② 在 dependencies 里声明 "dsh-mnemos": "file:<仓库绝对路径>"（dependencies 决定"包从哪来"），
 *        然后在该 profile 目录跑一次 pnpm install，让 node_modules 由包管理器生成。
 *
 * 三条铁律：改前先备份、改后必复核、失败就回滚。不重启、不终止任何进程，不用 sudo。
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN = "dsh-mnemos";
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** 宿主自带运行时：本机 PATH 里没有 node / pnpm 时用它。可用 DSH_RUNTIME_DIR 覆盖。 */
const RUNTIME_DIR =
  process.env.DSH_RUNTIME_DIR ||
  join(process.env.DSH_HOME || join(homedir(), ".dsh"), "dsh-runtimes", "dsh-primary-runtime", "dependencies");
const DEFAULT_NODE = join(RUNTIME_DIR, "node", "bin", "node");
const DEFAULT_PNPM = join(RUNTIME_DIR, "pnpm", "bin", "pnpm.mjs");
/** 只有 --no-pnpm 的降级路径才会复制文件；正常路径由 pnpm 从仓库生成。 */
const TOP_FILES = ["index.mjs", "client.js", "cordis.patch.yml", "package.json", "README.md"];
const SOURCE_DIRS = ["src"];
const HOST_ERROR = 'dsh: cannot resolve profile bundle "dsh-mnemos" from the dsh installation or ';

let TAG = "install";
let DRY = false;
const say = (message = "") => console.log("[" + PLUGIN + ":" + TAG + "] " + message);

/* ------------------------------------------------------------------ 参数 */

function parseArgs(argv) {
  const args = { mode: "install", profile: "desktop", dryRun: false, noPnpm: false, node: DEFAULT_NODE, pnpm: DEFAULT_PNPM };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") args.mode = "check";
    else if (arg === "--install") args.mode = "install";
    else if (arg === "--uninstall") args.mode = "uninstall";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--no-pnpm") args.noPnpm = true;
    else if (arg === "--help" || arg === "-h") args.mode = "help";
    else if (arg.startsWith("--profile=")) args.profile = arg.slice("--profile=".length).trim();
    else if (arg.startsWith("--node=")) args.node = arg.slice("--node=".length).trim();
    else if (arg.startsWith("--pnpm=")) args.pnpm = arg.slice("--pnpm=".length).trim();
    else if (arg === "--profile" || arg === "--node" || arg === "--pnpm") {
      i += 1;
      if (!argv[i]) throw new Error(arg + " 需要一个值");
      args[arg.slice(2)] = argv[i];
    } else throw new Error("不认识的参数：" + arg);
  }
  if (!args.profile) throw new Error("--profile 不能为空");
  return args;
}

function printHelp() {
  console.log("用法: node scripts/install.mjs [--check|--install|--uninstall] [--profile=<名字>] [--dry-run] [--no-pnpm]");
  console.log("  --check      只诊断四件事（bundles / dependencies / node_modules / import），不改任何文件");
  console.log("  --install    默认：备份 → 写 bundles + dependencies → 跑 pnpm install（幂等）");
  console.log("  --uninstall  反向：移除两处条目 → 跑 pnpm install → 清掉残留目录（备份保留）");
  console.log("  --profile=<名字>  目标 profile，默认 desktop；DSH_HOME 可覆盖 ~/.dsh");
  console.log("  --dry-run    只打印将要做的事，不写文件、不跑 pnpm");
  console.log("  --no-pnpm    逃生口：只改 manifest，不动 node_modules（宿主下次 install 会修剪掉，仅用于离线排障）");
  console.log("  --node=<路径> / --pnpm=<路径>  覆盖内置运行时路径");
}

/* ------------------------------------------------------------------ 工具 */

const sha256Text = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** 备份名带 ISO 时间戳；冒号换成 - 只为文件名在 shells/Finder 里都能直接用。 */
function backupPathFor(filePath) {
  const iso = new Date().toISOString().replace(/[:.]/g, "-");
  const base = basename(filePath) + ".mnemos-backup-" + iso;
  let candidate = join(dirname(filePath), base);
  let n = 2;
  while (existsSync(candidate)) {
    candidate = join(dirname(filePath), base + "-" + n);
    n += 1;
  }
  return candidate;
}

/** wx：文件已存在就抛错，绝不覆盖旧备份。 */
function writeExclusive(path, text) {
  writeFileSync(path, text, { encoding: "utf8", flag: "wx" });
  if (readFileSync(path, "utf8") !== text) throw new Error("备份写入后回读不一致：" + path);
}

function detectIndent(text) {
  const match = text.match(/\n([ \t]+)"/);
  return match ? match[1] : "  ";
}

function serialize(value, originalText) {
  const indent = detectIndent(originalText);
  const crlf = originalText.includes("\r\n");
  let text = JSON.stringify(value, null, indent);
  if (crlf) text = text.replace(/\n/g, "\r\n");
  if (/\r?\n$/.test(originalText)) text += crlf ? "\r\n" : "\n";
  return text;
}

const bundlesOf = (data) => {
  const list = data && data.dsh && data.dsh.profile && data.dsh.profile.bundles;
  return Array.isArray(list) ? list : null;
};

const depsOf = (data) => (data && data.dependencies && typeof data.dependencies === "object" ? data.dependencies : null);

/** 除 bundles 与 dependencies[PLUGIN] 之外的字段必须逐字不动。 */
function stripPluginFields(data) {
  const copy = JSON.parse(JSON.stringify(data));
  if (copy && copy.dsh && copy.dsh.profile) delete copy.dsh.profile.bundles;
  if (copy && copy.dependencies) delete copy.dependencies[PLUGIN];
  return JSON.stringify(copy);
}

function verifyManifest(filePath, expected, expectedBundles, expectedDep) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    return { ok: false, reason: "JSON.parse 失败：" + error.message };
  }
  const bundles = bundlesOf(parsed);
  if (!bundles) return { ok: false, reason: "dsh.profile.bundles 不是数组" };
  const hits = bundles.filter((item) => item === PLUGIN).length;
  if (hits !== expectedBundles) return { ok: false, reason: "bundles 里 " + PLUGIN + " 出现 " + hits + " 次（应为 " + expectedBundles + "）" };
  const deps = depsOf(parsed) || {};
  const dep = deps[PLUGIN];
  if (expectedDep === null) {
    if (dep !== undefined) return { ok: false, reason: "dependencies 里仍残留 " + PLUGIN };
  } else if (dep !== expectedDep) {
    return { ok: false, reason: "dependencies[" + PLUGIN + "] = " + String(dep) + "（应为 " + expectedDep + "）" };
  }
  if (stripPluginFields(parsed) !== stripPluginFields(expected)) return { ok: false, reason: "bundles/dependencies 之外的字段发生了变化" };
  return { ok: true, parsed };
}

/* ------------------------------------------------------------- pnpm / 探测 */

function runPnpm(profileDir, pnpmPath, nodePath) {
  if (!existsSync(pnpmPath)) return { ok: false, code: -1, output: "找不到 pnpm：" + pnpmPath };
  if (!existsSync(nodePath)) return { ok: false, code: -1, output: "找不到 node：" + nodePath };
  const result = spawnSync(nodePath, [pnpmPath, "install", "--reporter=append-only"], {
    cwd: profileDir,
    encoding: "utf8",
    env: { ...process.env, CI: "", npm_config_confirm_modules_purge: "false" },
    timeout: 300000,
  });
  const output = ((result.stdout || "") + (result.stderr || "")).trim();
  return { ok: result.status === 0, code: result.status === null ? -1 : result.status, output };
}

const PROBE_SCRIPT =
  'const m = await import("' + PLUGIN + '");' +
  "console.log(JSON.stringify({ name: m.name, apply: typeof m.apply, panel: m.PANEL_PATH || null }));";

function probeImport(profileDir, nodePath) {
  const result = spawnSync(nodePath, ["--input-type=module", "-e", PROBE_SCRIPT], { cwd: profileDir, encoding: "utf8", timeout: 60000 });
  if (result.status !== 0) {
    const message = ((result.stderr || "") + (result.stdout || "")).trim().split("\n").filter(Boolean)[0] || "退出码 " + result.status;
    return { ok: false, error: message };
  }
  try {
    return { ok: true, value: JSON.parse((result.stdout || "").trim().split("\n").pop()) };
  } catch (error) {
    return { ok: false, error: "探测输出无法解析：" + String(result.stdout || "").slice(0, 120) };
  }
}

function dirSummary(path) {
  if (!existsSync(path)) return { exists: false };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return { exists: true, symlink: true, files: 0, bytes: 0 };
  let files = 0;
  let bytes = 0;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else {
        files += 1;
        bytes += statSync(abs).size;
      }
    }
  };
  walk(path);
  return { exists: true, symlink: false, files, bytes };
}

/* --------------------------------------------------------------- 删除 */

function assertPluginDir(target, profileDir) {
  const abs = resolve(target);
  const nodeModules = resolve(join(profileDir, "node_modules"));
  if (basename(abs) !== PLUGIN) throw new Error("拒绝删除：目录名不是 " + PLUGIN + "：" + abs);
  if (resolve(dirname(abs)) !== nodeModules) throw new Error("拒绝删除：不在 " + nodeModules + " 下：" + abs);
  if (!abs.startsWith(profileDir + sep)) throw new Error("拒绝删除：越出 profile 目录：" + abs);
  return abs;
}

function removeTree(target, profileDir, dry, tag) {
  const root = assertPluginDir(target, profileDir);
  const stat = { files: 0, dirs: 0 };
  if (!existsSync(root)) return stat;
  const top = lstatSync(root);
  if (top.isSymbolicLink()) {
    say(tag + " 删除符号链接（只删链接本身，不动仓库）：" + root);
    if (!dry) unlinkSync(root);
    stat.files += 1;
    return stat;
  }
  if (!top.isDirectory()) throw new Error("预期是目录，实际不是：" + root);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      const probe = resolve(abs);
      if (probe !== root && !probe.startsWith(root + sep)) throw new Error("拒绝删除：路径越界：" + probe);
      const entryStat = lstatSync(abs);
      if (entryStat.isSymbolicLink()) {
        say(tag + " 删除链接 " + relative(root, abs));
        if (!dry) unlinkSync(abs);
        stat.files += 1;
      } else if (entryStat.isDirectory()) walk(abs);
      else {
        say(tag + " 删除文件 " + relative(root, abs));
        if (!dry) unlinkSync(abs);
        stat.files += 1;
      }
    }
    say(tag + " 删除目录 " + (relative(root, dir) || "."));
    if (!dry) rmdirSync(dir);
    stat.dirs += 1;
  };
  walk(root);
  return stat;
}

/* ------------------------------------------------------- --no-pnpm 复制 */

function collectFiles() {
  const files = [];
  for (const name of TOP_FILES) {
    const abs = join(REPO_ROOT, name);
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error("源文件缺失：" + abs);
    files.push(name);
  }
  const walk = (rel) => {
    const entries = readdirSync(join(REPO_ROOT, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const child = rel + "/" + entry.name;
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) files.push(child);
      else throw new Error("源目录里有不认识的条目：" + child);
    }
  };
  for (const dir of SOURCE_DIRS) walk(dir);
  return files;
}

/** 解析符号链接；解析不了就返回 null（比如断链），让调用方按"不存在"处理。 */
function safeRealpath(path) {
  try {
    return existsSync(path) ? realpathSync(path) : null;
  } catch {
    return null;
  }
}

/**
 * 仓库运行时文件集 vs 已装副本的逐文件 sha256 差异。
 *
 * 比较发生在 destDir **解析后的真实路径**上。这条是踩过坑的：
 * pnpm 既可能把 node_modules/<pkg> 铺成实体目录，也可能铺成一条指向 .pnpm store 副本的符号链接
 * ——后者依然是一份**副本**，改仓库它不会跟。所以「是不是符号链接」永远不能当作一致性的证据，
 * 唯一证据是逐文件内容。"目录在"也一样不能当证据。
 */
function diffContent(destDir) {
  const files = collectFiles();
  const linked = existsSync(destDir) && lstatSync(destDir).isSymbolicLink();
  const resolvedRoot = safeRealpath(destDir);
  const same = [];
  const changed = [];
  const missing = [];
  for (const rel of files) {
    const dst = resolvedRoot ? join(resolvedRoot, rel) : null;
    if (!dst || !existsSync(dst)) {
      missing.push(rel);
      continue;
    }
    if (sha256File(join(REPO_ROOT, rel)) === sha256File(dst)) same.push(rel);
    else changed.push(rel);
  }
  let extras = [];
  if (resolvedRoot) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const abs = join(dir, entry.name);
        if (entry.isDirectory()) walk(abs);
        else extras.push(relative(resolvedRoot, abs));
      }
    };
    walk(resolvedRoot);
    const known = new Set(files);
    extras = extras.filter((rel) => !known.has(rel)).sort();
  }
  return { total: files.length, linked, resolvedRoot, same, changed, missing, extras };
}

function contentSummary(diff) {
  if (!diff) return "目录不存在，无法比对";
  if (diff.changed.length === 0 && diff.missing.length === 0) return "一致 " + diff.same.length + " / 不同 0 / 缺失 0";
  return "一致 " + diff.same.length + " / 不同 " + diff.changed.length + " / 缺失 " + diff.missing.length + " ← 副本落后于仓库";
}

/**
 * 副本里多出来的文件：只报告、不删除。
 * 删包目录里的东西风险大于收益，但"有冗余却报好"和"静默装旧代码"是同一类问题，必须看见。
 * 多余文件不影响宿主加载，所以它不参与健康判定。
 */
function reportExtras(diff) {
  if (!diff || diff.extras.length === 0) return 0;
  const total = diff.extras.length;
  say("副本内多余文件：" + total + " 个（不删除，仅提示）");
  for (const rel of diff.extras.slice(0, 10)) say("  · " + rel);
  if (total > 10) say("  · 其余 " + (total - 10) + " 个省略");
  return total;
}

/**
 * 把有差异/缺失的文件同步进已装副本。
 *
 * 为什么是 unlink 后 copyFile，而不是直接覆盖：
 * pnpm 把 file: 依赖按内容寻址铺成硬链接（真 profile 里就是实体目录 + 硬链接），
 * 直接 write/copy 到已存在的目标上会写穿到共享 store，连带污染其它引用同一 store 的 profile；
 * 而如果副本是符号链接，直接写更糟——那是在写仓库本身。unlink 先断掉链接、再 copyFile 落新 inode，
 * 两种形态都安全。符号链接形态下内容天然等于仓库，所以直接判定一致、不写任何东西。
 */
function syncContent(destDir) {
  const diff = diffContent(destDir);
  if (!diff.resolvedRoot) throw new Error("已装副本不存在或无法解析真实路径：" + destDir);
  say("目标物理路径：" + diff.resolvedRoot + (diff.linked ? "（destDir 是符号链接，宿主加载的就是这里）" : "（实体目录）"));
  const todo = [...diff.changed, ...diff.missing];
  if (todo.length === 0) {
    // 这句话只在逐文件比对完之后才允许打印
    say("内容一致（已逐文件 sha256 实测）：" + diff.total + "/" + diff.total + " 相同，不写任何文件");
    return { updated: 0, added: 0, resolvedRoot: diff.resolvedRoot };
  }
  say("内容同步（unlink → copyFile，绝不原地覆盖；写入解析后的真实路径）：");
  for (const rel of todo) {
    const dst = join(diff.resolvedRoot, rel);
    const existed = existsSync(dst);
    mkdirSync(dirname(dst), { recursive: true });
    if (existed) unlinkSync(dst);
    copyFileSync(join(REPO_ROOT, rel), dst);
    const got = sha256File(dst);
    if (got !== sha256File(join(REPO_ROOT, rel))) throw new Error("同步后 sha256 仍不一致：" + rel);
    say("  · " + (existed ? "更新 " : "新增 ") + rel + " → " + dst + "（" + got.slice(0, 12) + "…）");
  }
  say("已同步 " + todo.length + " 个文件（更新 " + diff.changed.length + " / 新增 " + diff.missing.length + "），真实路径上逐文件回验 sha256 通过");
  return { updated: diff.changed.length, added: diff.missing.length, resolvedRoot: diff.resolvedRoot };
}

/* ------------------------------------------------------------------ 模式 */

function describeState(ctx) {
  const { pkgPath, destDir, nodePath } = ctx;
  const data = JSON.parse(readFileSync(pkgPath, "utf8"));
  const bundles = bundlesOf(data) || [];
  const deps = depsOf(data) || {};
  const dir = dirSummary(destDir);
  const lockPath = join(dirname(pkgPath), "pnpm-lock.yaml");
  const lockHits = existsSync(lockPath) ? (readFileSync(lockPath, "utf8").match(new RegExp(PLUGIN, "g")) || []).length : -1;
  return {
    data,
    bundles,
    deps,
    hasBundle: bundles.includes(PLUGIN),
    depValue: typeof deps[PLUGIN] === "string" ? deps[PLUGIN] : null,
    expectedDep: "file:" + REPO_ROOT,
    dir,
    lockHits,
    probe: dir.exists ? probeImport(dirname(pkgPath), nodePath) : { ok: false, error: "node_modules 里没有 " + PLUGIN },
  };
}

function runCheck(ctx) {
  const { profileDir, pkgPath, destDir } = ctx;
  if (!existsSync(pkgPath)) {
    say("错误：找不到 " + pkgPath);
    return 2;
  }
  const state = describeState(ctx);
  say("profile: " + profileDir);
  say("[1/5] dsh.profile.bundles 含 \"" + PLUGIN + "\"：" +
    (state.hasBundle ? "是（#" + (state.bundles.indexOf(PLUGIN) + 1) + "/" + state.bundles.length + "）" : "否 ← bundles 决定「加载谁」，缺了宿主就不会加载它"));
  say("[2/5] dependencies[\"" + PLUGIN + "\"]：" +
    (state.depValue === null ? "缺失 ← 包管理器不认识它，下次 pnpm install 会把它当无关目录修剪掉"
      : state.depValue === state.expectedDep ? "是（" + state.depValue + "）"
        : "值不符：实际 " + state.depValue + "，期望 " + state.expectedDep));
  const realDir = state.dir.exists ? safeRealpath(destDir) : null;
  say("[3/5] node_modules/" + PLUGIN + "：" +
    (state.dir.exists
      ? "存在（" + (state.dir.symlink ? "符号链接 → " + realDir + "，宿主加载的是链接指向的那份" : "实体目录：" + state.dir.files + " 个文件 / " + state.dir.bytes + " 字节") + "）"
      : "不存在 ← 缺了宿主解析不到包"));
  say("[4/5] 从 profile import(\"" + PLUGIN + "\")：" +
    (state.probe.ok ? "成功 name=" + state.probe.value.name + " apply=" + state.probe.value.apply + " panel=" + state.probe.value.panel : "失败：" + state.probe.error));
  const content = state.dir.exists ? diffContent(destDir) : null;
  say("[5/5] 内容一致性（仓库运行时文件 " + (content ? content.total : collectFiles().length) + " 个 vs 已装副本）：" + contentSummary(content));
  if (content && content.changed.length > 0) say("  不同的文件（" + content.changed.length + "）：" + content.changed.join(", "));
  if (content && content.missing.length > 0) say("  缺失的文件（" + content.missing.length + "）：" + content.missing.join(", "));
  reportExtras(content);
  say("pnpm-lock.yaml 命中 \"" + PLUGIN + "\"：" + (state.lockHits < 0 ? "没有 lockfile" : state.lockHits + " 处"));

  const contentOk = Boolean(content) && content.changed.length === 0 && content.missing.length === 0;
  const healthy = state.hasBundle && state.depValue === state.expectedDep && state.dir.exists && state.probe.ok && contentOk;
  if (healthy) {
    say("结论：健康——五项全过（含 " + content.total + " 个文件内容一致），宿主能解析到该 profile bundle");
    say("本命令是只读诊断：未改动任何文件，也没跑 pnpm");
    return 0;
  }
  say("结论：不健康。宿主会报：");
  say("  " + HOST_ERROR + profileDir);
  const fixes = [];
  if (!state.hasBundle || state.depValue !== state.expectedDep) fixes.push("写 manifest（bundles + dependencies）");
  if (!state.dir.exists || !state.probe.ok) fixes.push("跑 pnpm install 生成 node_modules");
  if (!contentOk) fixes.push("逐文件同步内容（unlink → copyFile）");
  say("  修复：" + fixes.join(" → ") + "；直接执行：node scripts/install.mjs --install");
  say("本命令是只读诊断：未改动任何文件，也没跑 pnpm");
  return 1;
}

function runInstall(ctx, args) {
  const { profileDir, pkgPath, destDir, nodePath, pnpmPath } = ctx;
  if (!existsSync(pkgPath)) {
    say("错误：找不到 " + pkgPath);
    return 2;
  }
  const before = readFileSync(pkgPath, "utf8");
  const data = JSON.parse(before);
  const bundles = bundlesOf(data);
  if (!bundles) {
    say("错误：没有 dsh.profile.bundles 数组，拒绝写入（脚本不替你发明结构）");
    return 2;
  }
  const expectedDep = "file:" + REPO_ROOT;
  if (!data.dependencies || typeof data.dependencies !== "object") data.dependencies = {};

  const bundleAdded = !bundles.includes(PLUGIN);
  const depAdded = data.dependencies[PLUGIN] !== expectedDep;
  const dirBefore = dirSummary(destDir);
  const lockPath = join(dirname(pkgPath), "pnpm-lock.yaml");
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;

  say("profile: " + profileDir);
  say("改动清单：");
  say("  · dsh.profile.bundles：" + (bundleAdded ? "追加 \"" + PLUGIN + "\"（当前 " + bundles.length + " 条）" : "已有，不动"));
  say("  · dependencies[\"" + PLUGIN + "\"]：" +
    (depAdded ? (data.dependencies[PLUGIN] === undefined ? "新增 " : "更新（旧值 " + data.dependencies[PLUGIN] + "）") + "\"" + expectedDep + "\"" : "已是期望值，不动"));
  const resolvedBefore = dirBefore.exists ? safeRealpath(destDir) : null;
  say("  · node_modules/" + PLUGIN + "：" + (dirBefore.exists ? "已存在（物理路径 " + resolvedBefore + "）" : "不存在，由 pnpm install 生成"));

  // pnpm 对 file: 依赖的解析结果不变时不会重铺文件，所以"装没装"必须由内容说了算
  const contentBefore = dirBefore.exists ? diffContent(destDir) : null;
  const needSync = Boolean(contentBefore) && (contentBefore.changed.length > 0 || contentBefore.missing.length > 0);
  say("  · 内容一致性：" + (contentBefore
    ? (needSync
      ? contentSummary(contentBefore) + "（共 " + contentBefore.total + " 个）"
      : "一致 " + contentBefore.same.length + "/" + contentBefore.total + " 个文件（sha256）")
    : "目录不存在，装完再比对"));
  reportExtras(contentBefore);

  const manifestChanged = bundleAdded || depAdded;
  const needPnpm = !args.noPnpm && (manifestChanged || !dirBefore.exists);

  if (!manifestChanged && dirBefore.exists && !needSync) {
    say("无需变更：manifest 已正确、node_modules 在位、" + contentBefore.total + " 个运行时文件内容与仓库逐字一致——幂等，不备份、不写文件、不跑 pnpm");
    const state = describeState(ctx);
    say("当前状态：import " + (state.probe.ok ? "name=" + state.probe.value.name + " apply=" + state.probe.value.apply : "失败：" + state.probe.error));
    say("完成。宿主要由人重启后才会按 bundles 加载插件——本脚本不重启、不终止任何进程。");
    return 0;
  }

  if (needSync) {
    say("差异清单（将同步进已装副本）：");
    for (const rel of contentBefore.changed) say("  · 更新 " + rel);
    for (const rel of contentBefore.missing) say("  · 新增 " + rel);
  }

  if (DRY) {
    if (manifestChanged) say("  （dry-run：将备份 " + pkgPath + " → " + basename(backupPathFor(pkgPath)) + "，再写入）");
    if (needPnpm) say("  （dry-run：将在 " + profileDir + " 执行 " + args.node + " " + args.pnpm + " install）");
    if (args.noPnpm) say("  （--no-pnpm：不会跑包管理器，也不会自动复制文件）");
    say("dry-run：未改动任何文件，未跑 pnpm");
    return 0;
  }

  let backupPkg = null;
  let backupLock = null;
  if (manifestChanged) {
    backupPkg = backupPathFor(pkgPath);
    writeExclusive(backupPkg, before);
    say("备份: " + pkgPath + " → " + backupPkg + "（" + before.length + " 字节，回读一致）");
    if (lockBefore !== null) {
      backupLock = backupPathFor(lockPath);
      writeExclusive(backupLock, lockBefore);
      say("备份: " + lockPath + " → " + backupLock + "（" + lockBefore.length + " 字节）");
    }
  }

  const rollback = (why) => {
    say("错误：" + why);
    if (backupPkg) {
      say("回滚：用备份还原 " + pkgPath);
      copyFileSync(backupPkg, pkgPath);
      say("已还原（sha256=" + sha256File(pkgPath).slice(0, 16) + "…）");
    }
    if (backupLock) {
      say("回滚：用备份还原 " + lockPath);
      copyFileSync(backupLock, lockPath);
    }
    if (!dirBefore.exists) {
      removeTree(destDir, profileDir, false, "[rollback]");
      say("回滚：已删除本次装出来的 node_modules/" + PLUGIN);
    }
    return 1;
  };

  if (manifestChanged) {
    if (bundleAdded) bundles.push(PLUGIN);
    data.dependencies[PLUGIN] = expectedDep;
    writeFileSync(pkgPath, serialize(data, before), "utf8");
    const verified = verifyManifest(pkgPath, data, 1, expectedDep);
    if (!verified.ok) return rollback("写后复核失败（" + verified.reason + "）");
    say("已写入并复核：JSON.parse 正常、" + PLUGIN + " 在 bundles 恰好 1 次、dependencies 已声明、其余字段未变");
  } else {
    say("manifest 无需改动（已正确）");
  }

  if (args.noPnpm) {
    say("⚠️  --no-pnpm：没有跑包管理器。宿主下一次 profile install 会把它当无关目录修剪掉，");
    say("⚠️  届时会出现 cannot resolve profile bundle。请在能联网/能跑 pnpm 的环境重跑 --install。");
  } else if (needPnpm) {
    say("执行 pnpm install：" + args.node + " " + args.pnpm + " install（cwd=" + profileDir + "）");
    const pnpm = runPnpm(profileDir, pnpmPath, nodePath);
    for (const line of pnpm.output.split("\n").slice(-30)) if (line.trim()) say("  pnpm| " + line);
    if (!pnpm.ok) return rollback("pnpm install 失败（退出码 " + pnpm.code + "）");
    say("pnpm install 成功（退出码 0）");
  } else {
    say("manifest 未变，跳过 pnpm install（只做内容同步）");
  }

  // 收口：pnpm 认为"解析结果没变"就不会重铺文件，内容一致性必须由这里保证
  try {
    syncContent(destDir);
  } catch (error) {
    return rollback("内容同步失败（" + error.message + "）");
  }

  const after = describeState(ctx);
  const contentAfter = after.dir.exists ? diffContent(destDir) : null;
  const problems = [];
  if (!after.hasBundle) problems.push("bundles 里没有条目");
  if (after.depValue !== expectedDep) problems.push("dependencies 未声明");
  if (!after.dir.exists) problems.push("node_modules/" + PLUGIN + " 不存在");
  if (!after.probe.ok) problems.push("import 失败：" + after.probe.error);
  if (!contentAfter || contentAfter.changed.length > 0 || contentAfter.missing.length > 0) {
    problems.push("内容仍不一致：" + (contentAfter ? contentAfter.changed.length + " 不同 / " + contentAfter.missing.length + " 缺失" : "目录不存在"));
  }
  if (problems.length) return rollback("装完复核不通过：" + problems.join("；"));

  say("装完复核：bundles ✓ dependencies ✓ node_modules/" + PLUGIN + " ✓ 内容 " + contentAfter.same.length + "/" + contentAfter.total + " 一致 ✓ import name=" + after.probe.value.name + " apply=" + after.probe.value.apply + " ✓");
  say("pnpm-lock.yaml 命中 \"" + PLUGIN + "\"：" + after.lockHits + " 处");
  say("备份: " + (backupPkg || "无（manifest 未改动）"));
  say("完成。宿主要由人重启后才会按 bundles 加载插件——本脚本不重启、不终止任何进程。");
  return 0;
}

function runUninstall(ctx, args) {
  const { profileDir, pkgPath, destDir, nodePath, pnpmPath } = ctx;
  if (!existsSync(pkgPath)) {
    say("错误：找不到 " + pkgPath);
    return 2;
  }
  const before = readFileSync(pkgPath, "utf8");
  const data = JSON.parse(before);
  const bundles = bundlesOf(data);
  if (!bundles) {
    say("错误：没有 dsh.profile.bundles 数组，拒绝写入");
    return 2;
  }
  const deps = depsOf(data) || {};
  const hasBundle = bundles.includes(PLUGIN);
  const hasDep = Object.prototype.hasOwnProperty.call(deps, PLUGIN);
  const dir = dirSummary(destDir);
  const lockPath = join(dirname(pkgPath), "pnpm-lock.yaml");

  say("profile: " + profileDir);
  say("将要移除的条目: " + (hasBundle ? "bundles[" + bundles.indexOf(PLUGIN) + "] = \"" + PLUGIN + "\"" : "bundles 无条目") +
    " / " + (hasDep ? "dependencies[\"" + PLUGIN + "\"] = \"" + deps[PLUGIN] + "\"" : "dependencies 无声明"));
  say("将要删除的目录: " + destDir + "（" + (dir.exists ? (dir.symlink ? "符号链接" : dir.files + " 个文件 / " + dir.bytes + " 字节") : "不存在") + "）");
  const backups = readdirSync(dirname(pkgPath)).filter((name) => name.startsWith(basename(pkgPath) + ".mnemos-backup-")).sort();
  say("已有备份（保留，不删）: " + (backups.length ? backups.join(", ") : "无"));

  if (!hasBundle && !hasDep && !dir.exists) {
    say("没有可卸载的东西：manifest 干净、目录不存在——幂等，不改任何文件");
    return 0;
  }

  if (DRY) {
    if (hasBundle || hasDep) say("  （dry-run：将备份 " + pkgPath + " 后移除上述两条）");
    if (!args.noPnpm && existsSync(join(profileDir, "node_modules"))) say("  （dry-run：将在 " + profileDir + " 执行 pnpm install 让 lockfile 与 node_modules 同步）");
    say("  （dry-run：将逐条删除 " + destDir + "，路径逐一校验在 " + resolve(join(profileDir, "node_modules")) + " 下）");
    say("dry-run：未改动任何文件，未跑 pnpm");
    return 0;
  }

  let backupPkg = null;
  let backupLock = null;
  const lockBefore = existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null;
  if (hasBundle || hasDep) {
    backupPkg = backupPathFor(pkgPath);
    writeExclusive(backupPkg, before);
    say("备份: " + pkgPath + " → " + backupPkg);
    if (lockBefore !== null) {
      backupLock = backupPathFor(lockPath);
      writeExclusive(backupLock, lockBefore);
      say("备份: " + lockPath + " → " + backupLock);
    }
    const restored = JSON.parse(before);
    data.dsh.profile.bundles = bundles.filter((item) => item !== PLUGIN);
    if (data.dependencies && typeof data.dependencies === "object") delete data.dependencies[PLUGIN];
    // 如果安装前的清单里根本没有 dependencies，卸载后也不要留一个空对象
    if (data.dependencies && Object.keys(data.dependencies).length === 0 && !depsOf(restored)) delete data.dependencies;
    writeFileSync(pkgPath, serialize(data, before), "utf8");
    const verified = verifyManifest(pkgPath, data, 0, null);
    if (!verified.ok) {
      say("错误：写后复核失败（" + verified.reason + "），立刻用备份回滚");
      copyFileSync(backupPkg, pkgPath);
      if (backupLock) copyFileSync(backupLock, lockPath);
      return 1;
    }
    say("已移除两处条目并复核：JSON.parse 正常、" + PLUGIN + " 已不在 bundles、dependencies 已无该键、其余字段未变");
  }

  if (!args.noPnpm && existsSync(join(profileDir, "node_modules"))) {
    say("执行 pnpm install 让 lockfile / node_modules 与 manifest 同步");
    const pnpm = runPnpm(profileDir, pnpmPath, nodePath);
    for (const line of pnpm.output.split("\n").slice(-20)) if (line.trim()) say("  pnpm| " + line);
    if (!pnpm.ok) {
      say("错误：pnpm install 失败（退出码 " + pnpm.code + "），回滚 manifest");
      if (backupPkg) copyFileSync(backupPkg, pkgPath);
      if (backupLock) copyFileSync(backupLock, lockPath);
      return 1;
    }
    say("pnpm install 成功（退出码 0）");
  } else if (args.noPnpm) {
    say("--no-pnpm：跳过包管理器同步（node_modules 里的残留目录下面单独删）");
  }

  const removed = removeTree(destDir, profileDir, false, "[uninstall]");
  say("已删除 " + removed.files + " 个文件 / " + removed.dirs + " 个目录：" + destDir);

  const after = describeState(ctx);
  say("卸载后复核：bundles 无条目 ✓ dependencies 无声明 ✓ 目录已删 ✓ import 现在应当失败（预期）");
  say("  import 探测：" + (after.probe.ok ? "仍然成功！" : "失败（符合预期）：" + after.probe.error));
  say("备份保留: " + (backupPkg || "无新增") + (backups.length ? "；历史备份 " + backups.join(", ") : ""));
  say("完成。宿主要由人重启后才会看到插件消失——本脚本不重启、不终止任何进程。");
  return 0;
}

/* ------------------------------------------------------------------ 入口 */

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error("[dsh-mnemos] " + error.message);
    return 64;
  }
  if (args.mode === "help") {
    printHelp();
    return 0;
  }
  TAG = args.mode;
  DRY = args.dryRun;

  const home = process.env.DSH_HOME && process.env.DSH_HOME.trim() ? process.env.DSH_HOME.trim() : join(homedir(), ".dsh");
  const profileDir = join(home, "profiles", args.profile);
  const pkgPath = join(profileDir, "package.json");
  const destDir = join(profileDir, "node_modules", PLUGIN);

  say("模式=" + args.mode + (DRY ? "（dry-run）" : "") + (args.noPnpm ? "（--no-pnpm）" : "") + " profile=" + args.profile);
  say("DSH_HOME: " + home);
  say("profile 目录: " + profileDir);
  if (!existsSync(profileDir)) {
    say("错误：profile 目录不存在（先让 DSH 生成它）：" + profileDir);
    return 2;
  }
  if (!isAbsolute(args.node) || !isAbsolute(args.pnpm)) {
    say("错误：--node / --pnpm 必须是绝对路径");
    return 2;
  }
  say("node: " + args.node + (existsSync(args.node) ? "" : "（不存在！）"));
  say("pnpm: " + args.pnpm + (existsSync(args.pnpm) ? "" : "（不存在！）"));

  const ctx = { profileDir, pkgPath, destDir, nodePath: args.node, pnpmPath: args.pnpm };
  try {
    if (args.mode === "check") return runCheck(ctx);
    if (args.mode === "install") return runInstall(ctx, args);
    return runUninstall(ctx, args);
  } catch (error) {
    say("错误：操作中断（" + error.message + "）");
    if (existsSync(pkgPath)) say("当前备份: " + (readdirSync(dirname(pkgPath)).filter((n) => n.startsWith("package.json.mnemos-backup-")).sort().join(", ") || "无"));
    return 70;
  }
}

main().then((code) => {
  process.exitCode = code;
});
