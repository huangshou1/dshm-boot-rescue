#!/usr/bin/env node
// dshm-boot-rescue — zero-dependency static self-check.
//
// 用途：在没有 node CLI 的 DSHM 端侧之外（PC 上）快速检查交付物是否符合
// .recon/SPEC.md 的硬约束；不启动宿主、不访问网络、不读写真机 profile。
//
// 用法（在插件根目录或任意目录）：
//   node tools/check.mjs
//
// 退出码：0 = 所有硬检查通过；1 = 存在 FAIL。WARN 不会导致非零退出。

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const results = [];
let failures = 0;
let warnings = 0;

function pass(name) {
  results.push(["PASS", name]);
}

function warn(name, detail) {
  warnings += 1;
  results.push(["WARN", name + (detail ? " — " + detail : "")]);
}

function fail(name, detail) {
  failures += 1;
  results.push(["FAIL", name + (detail ? " — " + detail : "")]);
}

function report(name, issues) {
  if (issues.length === 0) {
    pass(name);
  } else {
    fail(name, issues.join("；"));
  }
}

function exists(relativePath) {
  return existsSync(join(ROOT, relativePath));
}

function read(relativePath) {
  try {
    return readFileSync(join(ROOT, relativePath), "utf8");
  } catch (_) {
    return null;
  }
}

function readJson(relativePath) {
  const text = read(relativePath);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch (_) {
    return undefined; // 区分「缺失」(null) 与「解析失败」(undefined)
  }
}

function section(label, fn) {
  try {
    fn();
  } catch (error) {
    fail(label, "检查脚本异常：" + String((error && error.message) || error));
  }
}

function hasAll(text, needles) {
  return needles.filter(function (needle) {
    return text.indexOf(needle) === -1;
  });
}

// 去掉 JS 注释后再做「禁止模式」扫描：平台约束注释里会合法出现
// child_process / WebAssembly / inject 等字样，不能因此误报。
function stripJsComments(text) {
  return String(text || "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

// ── 0. 交付物齐全 ──────────────────────────────────────────────────────────
section("交付物齐全", function () {
  const required = [
    "package.json",
    "cordis.patch.yml",
    "lib/index.js",
    "lib/rescue-client.js",
    "README.md",
    "test/rescue.test.mjs",
    "tools/check.mjs"
  ];
  const missing = required.filter(function (file) {
    return !exists(file);
  });
  report("交付物齐全（7 个文件）", missing.map(function (file) {
    return "缺少 " + file;
  }));
});

// ── 1. package.json 约束 ───────────────────────────────────────────────────
section("package.json", function () {
  const pkg = readJson("package.json");
  if (pkg === null) {
    fail("package.json 约束", "文件不存在");
    return;
  }
  if (pkg === undefined) {
    fail("package.json 约束", "不是合法 JSON");
    return;
  }

  const issues = [];
  if (pkg.name !== "dshm-boot-rescue") issues.push("name 必须是 dshm-boot-rescue");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(String(pkg.version || ""))) {
    issues.push("version 必须是合法 semver（当前 " + JSON.stringify(pkg.version) + "）");
  }
  if (pkg.type !== "module") issues.push("type 必须是 module");
  if (pkg.main !== "lib/index.js") issues.push("main 必须是 lib/index.js");
  if (pkg.license !== "MIT") issues.push("license 必须是 MIT");
  if (pkg.client !== undefined) issues.push("不得声明 client 半身（本插件只有宿主半身）");

  // SPEC 1：dependencies 为空；其余依赖/引擎字段不得声明。
  const forbiddenFields = [
    "devDependencies",
    "optionalDependencies",
    "bundledDependencies",
    "peerDependencies",
    "engines"
  ];
  if (pkg.dependencies !== undefined) {
    const dependencyNames = Object.keys(pkg.dependencies || {});
    if (dependencyNames.length > 0) {
      issues.push("dependencies 必须为空（当前声明 " + dependencyNames.length + " 个）");
    }
  }
  for (const field of forbiddenFields) {
    if (pkg[field] !== undefined) issues.push("不得声明 " + field);
  }

  const files = Array.isArray(pkg.files) ? pkg.files : [];
  for (const file of ["lib/index.js", "lib/rescue-client.js", "cordis.patch.yml", "README.md"]) {
    if (files.indexOf(file) === -1) issues.push("files 缺少 " + file);
  }

  const patch = pkg.dsh && pkg.dsh.bundle && pkg.dsh.bundle.patch;
  if (typeof patch !== "string" || patch.replace(/^\.\//, "") !== "cordis.patch.yml") {
    issues.push("dsh.bundle.patch 必须指向 ./cordis.patch.yml");
  }

  if (pkg.exports && pkg.exports["./client"]) {
    const target = typeof pkg.exports["./client"] === "string"
      ? pkg.exports["./client"]
      : pkg.exports["./client"].default;
    if (target !== "./lib/rescue-client.js") {
      issues.push("exports[./client] 只能指向救援脚本 lib/rescue-client.js");
    }
  }

  report("package.json 约束（零依赖 / 无 engines / 无 client 半身）", issues);
});

// ── 2. cordis.patch.yml 行 id ───────────────────────────────────────────────
section("cordis.patch.yml", function () {
  const text = read("cordis.patch.yml");
  if (text === null) {
    fail("cordis.patch.yml 行 id", "文件不存在");
    return;
  }
  const issues = [];
  if (!/^\s*-\s*insert:\s*$/m.test(text)) issues.push("缺少 - insert: 块");
  if (!/^\s*-\s*id:\s*['"]?dshm-boot-rescue['"]?\s*$/m.test(text)) {
    issues.push("insert 行 id 必须是 dshm-boot-rescue（与包名一致）");
  }
  if (!/^\s*name:\s*['"]?dshm-boot-rescue['"]?\s*$/m.test(text)) {
    issues.push("insert 行 name 必须是 dshm-boot-rescue");
  }
  const idLines = text.match(/^\s*-\s*id:.*$/gm) || [];
  if (idLines.length !== 1) {
    issues.push("只能有一个 - id: 行（当前 " + idLines.length + " 个）");
  }
  report("cordis.patch.yml 行 id 与包名一致", issues);
});

// ── 3. 宿主 lib/index.js ────────────────────────────────────────────────────
section("lib/index.js", function () {
  const text = read("lib/index.js");
  if (text === null) {
    fail("lib/index.js 静态约束", "文件不存在");
    return;
  }
  const issues = [];

  const forbidden = [
    [/\bchild_process\b/, "禁止 child_process"],
    [/\bworker_threads\b/, "禁止 worker_threads"],
    [/\bWebAssembly\b/, "禁止 WebAssembly"],
    [/\bnew\s+Worker\b/, "禁止 Worker"],
    [/\b(?:spawn|spawnSync)\s*\(/, "禁止 spawn"],
    [/(?<!\.)\b(?:exec|execSync|execFile|execFileSync)\s*\(/, "禁止 exec（RegExp.exec 除外）"],
    [/\bfork\s*\(/, "禁止 fork"],
    [/export\s+(?:const|let|var)\s+inject\b/, "禁止 export inject（会进入 pending）"],
    [/export\s*\{[^}]*\binject\b/, "禁止把 inject 作为导出"],
    [/\/data\/storage/, "不得硬编码真机路径 /data/storage"],
    [/\bhomedir\s*\(/, "数据目录只允许 DSH_HOME / DSHM_HOME，不要回退 homedir()"]
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(stripJsComments(text))) issues.push(label);
  }

  const requiredPatterns = [
    [/ctx\.get\(\s*["']webServer["']\s*\)/, "必须通过 ctx.get(\"webServer\") 获取服务"],
    [/ctx\.get\(\s*["']loader["']\s*\)/, "loader 必须通过 ctx.get(\"loader\") 获取"],
    [/export\s+(?:async\s+)?function\s+apply\s*\(/, "必须导出 apply()"],
    [/\/dshm-boot-rescue/, "必须注册 /dshm-boot-rescue 前缀"],
    [/dshm-boot-rescue\.log/, "必须写诊断日志 dshm-boot-rescue.log"],
    [/\btapIndex\b/, "必须调用 tapIndex 注入救援脚本"],
    [/\/health\b/, "缺少 /health 路由"],
    [/\/preview\b/, "缺少 /preview 路由"],
    [/\/state\b/, "缺少 /state 路由"],
    [/\/disable\b/, "缺少 /disable 路由"],
    [/\/restore\b/, "缺少 /restore 路由"],
    [/\/client\.js\b/, "缺少 /client.js 路由"]
  ];
  for (const [pattern, label] of requiredPatterns) {
    if (!pattern.test(text)) issues.push(label);
  }

  report("lib/index.js 静态约束（纯宿主 / 路由 / 诊断 / 无 inject）", issues);
});

// ── 4. 救援脚本 lib/rescue-client.js ────────────────────────────────────────
section("lib/rescue-client.js", function () {
  const text = read("lib/rescue-client.js");
  if (text === null) {
    fail("救援脚本静态约束", "文件不存在");
    return;
  }
  const issues = [];

  // 明确禁止的模式（SPEC 第 6 节）。
  const forbidden = [
    [/^\s*import\s/m, "禁止 ES module import"],
    [/\bimport\s*\(/, "禁止动态 import()"],
    [/\brequire\s*\(/, "禁止 require()"],
    [/^\s*export\s/m, "禁止 export（必须是 IIFE）"],
    [/\bnew\s+Worker\b|\bWorker\s*\(/, "禁止 Worker"],
    [/\bWebAssembly\b/, "禁止 WASM"],
    [/\bsetInterval\s*\(/, "禁止 setInterval 轮询"],
    [/\blocation\s*\.\s*reload\s*\(/, "禁止 location.reload"],
    [/刷新页面/, "禁止出现「刷新页面」文案"],
    [/\bimportScripts\s*\(/, "禁止 importScripts"],
    [/<script[^>]+src\s*=/i, "禁止外部 script 资源"],
    [/(?:src|href)\s*=\s*["']https?:/i, "禁止外部资源 URL"],
    [/fetch\s*\(\s*["']https?:/i, "禁止请求外部 URL"],
    [/\beval\s*\(/, "禁止 eval"],
    [/\bnew\s+Function\s*\(/, "禁止 new Function"],
    [/[\w\)\]]\?\./, "禁止可选链 ?."],
    [/\?\?/, "禁止空值合并 ??"]
  ];
  for (const [pattern, label] of forbidden) {
    if (pattern.test(text)) issues.push(label);
  }

  // 必备文案 / 结构（SPEC 第 6 节，客户端契约）。
  const required = [
    ["Failed to load plugins", "必须检测失败标题"],
    ["HEALTHY_UI_SELECTOR", "必须有健康 UI 选择器"],
    ["MutationObserver", "必须用 MutationObserver 侦测"],
    ["__DSHM_BOOT_RESCUE__", "必须有幂等哨兵"],
    ["启动恢复中心", "缺少面板标题「启动恢复中心」"],
    ["停用后请划掉后台重新打开应用", "缺少常驻重启指引"],
    ["本次停用重启应用后失效，请进入系统后立即卸载肇事插件", "缺少降级模式固定 warning"],
    ["停用所选并等待重启", "缺少主按钮文案"],
    ["救援服务暂时不可用", "缺少服务不可用回退面板"],
    ["只读自检", "缺少只读自检状态"],
    ["疑似故障", "缺少「疑似故障」标签"],
    ["恢复救援停用项", "缺少批量恢复按钮"],
    ["复制诊断", "缺少「复制诊断」"],
    ["client-modules", "必须识别 bundle script 失败文案"],
    ["import failed", "必须识别 <name>: import failed 文案"],
    ["pending (waiting for service", "必须识别 pending 文案"],
    ["web boot:", "必须识别 web boot 整体失败文案"],
    ["dshm-boot-rescue/state", "必须 fetch /dshm-boot-rescue/state"],
    ["data-dshm-boot-rescue-preview", "必须识别自检模式 body 属性"],
    ["dbr-", "样式类必须统一 dbr- 前缀"]
  ];
  const missing = hasAll(text, required);
  for (const item of missing) issues.push("缺少 " + item);
  if (!/["']use strict["']/.test(text)) issues.push("缺少 use strict 严格模式声明");

  if (!/position\s*:\s*fixed/.test(text)) issues.push("覆盖层必须 position:fixed");
  if (!/credentials\s*:\s*["']same-origin["']/.test(text)) {
    issues.push("fetch state 必须 credentials:same-origin");
  }
  if (/console\.(?:log|warn|error)\([^)]*token/i.test(text)) {
    issues.push("不得在控制台打印敏感信息");
  }
  if (/document\s*\.\s*cookie|localStorage|sessionStorage/.test(text)) {
    issues.push("不得读取 cookie/localStorage/sessionStorage");
  }

  // ES5 风格仅作警告，避免误伤可运行的实现。
  const styleWarnings = [];
  if (/=>/.test(text)) styleWarnings.push("出现箭头函数（建议 var/function）");
  if (/\bconst\s+[A-Za-z_$]/.test(text)) styleWarnings.push("出现 const（建议 var）");
  if (/\blet\s+[A-Za-z_$]/.test(text)) styleWarnings.push("出现 let（建议 var）");
  if (/`/.test(text)) styleWarnings.push("出现模板字符串（建议字符串拼接）");
  if (styleWarnings.length) warn("救援脚本 ES5 风格建议", styleWarnings.join("；"));

  report("救援脚本静态约束（无 import/require/Worker/WASM/轮询/reload/刷新页面）", issues);
});

// ── 5. README.md 必备说明 ──────────────────────────────────────────────────
section("README.md", function () {
  const text = read("README.md");
  if (text === null) {
    fail("README.md 必备说明", "文件不存在");
    return;
  }
  const required = [
    ["dshm-boot-rescue", "插件名"],
    ["设置 → 插件", "DSHM 设置→插件安装入口"],
    ["github:<owner>/dshm-boot-rescue", "GitHub 安装 spec"],
    ["pnpm add github:", "pnpm 安装命令"],
    ["划掉后台重新打开应用", "划掉后台重开说明"],
    ["启动恢复中心", "恢复中心名称"],
    ["只删", "恢复只删自己标记行的语义"],
    ["本次停用重启应用后失效，请进入系统后立即卸载肇事插件", "降级模式 warning"],
    [".dshm-plugin-rows.yml", "持久用户行文件"],
    ["cordis.patch.yml", "patch 文件"],
    ["rowsPath", "只读指引中的 rowsPath"],
    ["安全边界", "安全边界章节"],
    ["已知限制", "已知限制章节"],
    ["$DSH_HOME/dshm-boot-rescue.log", "诊断日志路径"],
    ["$DSH_HOME/.dshm-boot-failed", "Host 级启动失败自愈标记"],
    ["quarantine-<ts>", "启动失败隔离文件说明"],
    ["carry", "降级模式 carry 行为说明"],
    ["5 类", "诊断日志至少 5 项"],
    ["/dshm-boot-rescue/preview", "自检页 URL"],
    ["/health", "健康检查 URL"],
    ["node --check lib/index.js", "语法检查命令"],
    ["node --test test/rescue.test.mjs", "测试命令"],
    ["node tools/check.mjs", "静态自检命令"],
    ["Node.js 24", "Node 24 要求"],
    ["只读自检", "自检只读说明"],
    ["恢复功能", "恢复功能语义"]
  ];
  const issues = hasAll(text, required).map(function (item) {
    return "缺少「" + item + "」";
  });
  if (text.indexOf("刷新页面") !== -1) {
    warn("README.md 出现「刷新页面」字样", "客户端禁用该文案，文档也建议统一为「划掉后台重开」");
  }
  report("README.md 必备说明", issues);
});

// ── 6. test/rescue.test.mjs ─────────────────────────────────────────────────
section("test/rescue.test.mjs", function () {
  const text = read("test/rescue.test.mjs");
  if (text === null) {
    fail("测试静态约束", "文件不存在");
    return;
  }
  const issues = [];

  const required = [
    ["node:test", "必须使用 node:test"],
    ["node:assert/strict", "必须使用 node:assert/strict"],
    ["mkdtemp", "必须用临时目录"],
    ["tmpdir", "必须用 os.tmpdir()"],
    ["../lib/index.js", "必须从 ../lib/index.js 导入被测函数"]
  ];
  for (const item of hasAll(text, required)) issues.push("缺少 " + item);

  const forbiddenPaths = [/\/data\/storage/, /profiles\/ondevice/, /\/storage\/Users\//];
  for (const pattern of forbiddenPaths) {
    if (pattern.test(text)) issues.push("禁止在测试里引用真机路径 " + pattern);
  }

  // 交叉检查：测试导入的导出名必须存在于 lib/index.js。
  const lib = read("lib/index.js");
  if (lib !== null) {
    const importMatch = /import\s*\{([^}]*)\}\s*from\s*["']\.\.\/lib\/index\.js["']/.exec(text);
    if (!importMatch) {
      issues.push("找不到从 ../lib/index.js 的命名导入");
    } else {
      const imported = importMatch[1].split(",").map(function (part) {
        return part.trim().split(/\s+as\s+/)[0].trim();
      }).filter(Boolean);
      const exported = new Set();
      const patterns = [
        /export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
        /export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
        /export\s+class\s+([A-Za-z_$][\w$]*)/g
      ];
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(lib)) !== null) exported.add(match[1]);
      }
      const namedBlocks = lib.match(/export\s*\{([^}]*)\}/g) || [];
      for (const block of namedBlocks) {
        const inner = block.replace(/^export\s*\{/, "").replace(/\}$/, "");
        for (const part of inner.split(",")) {
          const name = part.trim().split(/\s+as\s+/)[0].trim();
          if (name) exported.add(name);
        }
      }
      for (const name of imported) {
        if (!exported.has(name)) issues.push("测试导入了 lib/index.js 未导出的 " + name);
      }
    }
  }

  report("测试静态约束（node:test / 临时目录 / 导出名一致）", issues);
});

// ── 输出 ───────────────────────────────────────────────────────────────────
const width = results.reduce(function (max, row) {
  return Math.max(max, row[0].length);
}, 0);
for (const row of results) {
  process.stdout.write("[" + row[0].padEnd(width) + "] " + row[1] + "\n");
}

const passed = results.filter(function (row) { return row[0] === "PASS"; }).length;
process.stdout.write(
  "\n" + passed + " passed, " + warnings + " warning(s), " + failures + " failed\n"
);

if (failures > 0) {
  process.stdout.write("静态自检未通过；请修复上面的 FAIL 项。\n");
  process.exitCode = 1;
} else {
  process.stdout.write("静态自检通过。\n");
}
