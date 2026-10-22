// dshm-boot-rescue — host side unit / integration tests.
//
// 全部使用 mkdtemp 临时目录，绝不读写真机设备上的 profile。
// 运行：node --test test/rescue.test.mjs（Node 24）

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";

import {
  DISABLE_MARKER,
  FALLBACK_MARKER,
  FALLBACK_MESSAGE,
  ROUTE,
  ROWS_FILE_NAME,
  apply,
  assertMutationRequest,
  buildCatalog,
  checkPatchAppendable,
  findProfileDir,
  isLoopbackAddress,
  mutateTextFile,
  name,
  normalizeIds,
  parsePatchRows,
  parseUserRows,
  readHostReadyProfile,
  removeRescueRows,
  renderDisableRows,
  renderPatchDisableRows,
  resolveHomeDir,
  version
} from "../lib/index.js";

const ROW_MARKER = DISABLE_MARKER;
const PATCH_MARKER = FALLBACK_MARKER;
const FALLBACK_WARNING = FALLBACK_MESSAGE;

// ── 测试辅助 ────────────────────────────────────────────────────────────────

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "dshm-boot-rescue-"));
  t.after(async function () {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

async function withEnv(t, patch, run) {
  const saved = new Map();
  for (const key of Object.keys(patch)) {
    saved.set(key, process.env[key]);
    if (patch[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = patch[key];
    }
  }
  t.after(function () {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
  return run();
}

function rowBlock(id) {
  return ROW_MARKER + id + "\n- id: " + id + "\n  disabled: true";
}

function findEntry(entries, id) {
  return entries.filter(function (entry) { return entry.id === id; })[0];
}

function captureResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: "",
    writableEnded: false,
    writeHead: function (statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers || {};
    },
    end: function (body) {
      if (body === undefined || body === null) {
        this.body = "";
      } else if (Buffer.isBuffer(body)) {
        this.body = body.toString("utf8");
      } else {
        this.body = String(body);
      }
      this.writableEnded = true;
    }
  };
}

function httpRequest(method, url, options) {
  const opts = options || {};
  const headers = Object.assign({ host: "127.0.0.1:3120" }, opts.headers || {});
  if (method === "POST" && headers["content-type"] === undefined) {
    headers["content-type"] = "application/json";
  }
  return {
    method: method,
    url: url,
    socket: { remoteAddress: opts.remoteAddress === undefined ? "127.0.0.1" : opts.remoteAddress },
    headers: headers,
    async *[Symbol.asyncIterator]() {
      if (opts.body !== undefined) {
        const payload = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
        yield Buffer.from(payload, "utf8");
      }
    }
  };
}

async function callRoute(handler, request) {
  const response = captureResponse();
  await handler(request, response);
  return response;
}

function parseResponse(response) {
  return JSON.parse(response.body);
}

function createFakeContext(loaderEntries) {
  const server = {
    route: null,
    tap: null,
    register: function (route) {
      server.route = route;
      return function () {};
    },
    tapIndex: function (fn) {
      server.tap = fn;
      return function () {};
    }
  };
  const context = {
    get: function (serviceName) {
      if (serviceName === "webServer") return server;
      if (serviceName === "loader") {
        return {
          entries: function () { return loaderEntries || []; }
        };
      }
      return undefined;
    },
    effect: function (fn) { return fn(); },
    on: function () { return function () {}; },
    logger: { info: function () {} }
  };
  return { ctx: context, server: server };
}

async function createInstalledHome(t) {
  const root = await temporaryDirectory(t);
  const home = join(root, "home");
  const profile = join(home, "profiles", "ondevice");
  await mkdir(join(profile, "node_modules", "dsh-market"), { recursive: true });
  await mkdir(join(profile, "node_modules", "dsh-tool"), { recursive: true });
  await writeFile(join(home, "host-ready.json"), JSON.stringify({ profile: "ondevice" }), "utf8");
  await writeFile(join(profile, "package.json"), JSON.stringify({
    name: "ondevice",
    dsh: { profile: { bundles: [] } },
    dependencies: { "dsh-market": "1.0.0", "dsh-tool": "1.0.0" }
  }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), [
    "# core seed",
    "- insert:",
    "    - id: core-chat",
    "      name: '@deepseek-ai/dsh-core-chat'",
    "    - id: dsh-market",
    "      name: 'dshmarket'",
    "    - id: dshm-boot-rescue",
    "      name: 'dshm-boot-rescue'",
    ""
  ].join("\n"), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-market", "package.json"), JSON.stringify({
    name: "dsh-market",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-market", "cordis.patch.yml"),
    "- insert:\n    - id: dsh-market\n      name: dshmarket\n", "utf8");
  await writeFile(join(profile, "node_modules", "dsh-tool", "package.json"), JSON.stringify({
    name: "dsh-tool",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-tool", "cordis.patch.yml"),
    "- insert:\n    - id: dsh-tool\n      name: dsh-tool\n", "utf8");

  const rows = [
    "# 用户行",
    "- id: dsh-market",
    "  disabled: false",
    "- id: loose-row",
    "  disabled: false",
    "- id: dsh-tool",
    "  disabled: true",
    ""
  ].join("\n");
  await writeFile(join(profile, ".dshm-plugin-rows.yml"), rows, "utf8");
  return { root: root, home: home, profile: profile, rows: rows };
}

async function createFallbackHome(t, patchText) {
  const root = await temporaryDirectory(t);
  const home = join(root, "home");
  const profile = join(home, "profiles", "ondevice");
  await mkdir(join(profile, "node_modules", "dsh-market"), { recursive: true });
  await writeFile(join(home, "host-ready.json"), JSON.stringify({ profile: "ondevice" }), "utf8");
  await writeFile(join(profile, "package.json"), JSON.stringify({
    name: "ondevice",
    dsh: { profile: { bundles: [] } },
    dependencies: { "dsh-market": "1.0.0" }
  }), "utf8");
  await writeFile(join(profile, "cordis.patch.yml"), patchText, "utf8");
  // 降级模式下候选只能来自「已安装 bundle 的 insert 行」。
  await writeFile(join(profile, "node_modules", "dsh-market", "package.json"), JSON.stringify({
    name: "dsh-market",
    version: "1.0.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } }
  }), "utf8");
  await writeFile(join(profile, "node_modules", "dsh-market", "cordis.patch.yml"),
    "- insert:\n    - id: dsh-market\n      name: dshmarket\n", "utf8");
  // 结构非法的用户行文件 → 触发降级模式
  await writeFile(join(profile, ".dshm-plugin-rows.yml"), "settings:\n  enabled: true\n", "utf8");
  return { root: root, home: home, profile: profile };
}

// ── 导出与版本 ──────────────────────────────────────────────────────────────

test("exports the expected host identity and version", async function () {
  assert.equal(name, "dshm-boot-rescue");
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(version, manifest.version);
});

test("exports the route, file name and marker constants used across the project", function () {
  assert.equal(ROUTE, "/dshm-boot-rescue");
  assert.equal(ROWS_FILE_NAME, ".dshm-plugin-rows.yml");
  assert.equal(DISABLE_MARKER, "# [dshm-boot-rescue] disabled ");
  assert.equal(FALLBACK_MARKER, "# [dshm-boot-rescue] fallback-disabled ");
  assert.equal(FALLBACK_MESSAGE, "本次停用重启应用后失效，请进入系统后立即卸载肇事插件");
});

// ── parseUserRows ───────────────────────────────────────────────────────────

test("parseUserRows parses plain rows, comments, quoted ids and disabled values", function () {
  const parsed = parseUserRows([
    "# 端侧「插件」页维护的用户行",
    "",
    "- id: dsh-market",
    "  disabled: true",
    "- id: '@scope/plugin'",
    "  disabled: false",
    "- id: plain-row",
    ""
  ].join("\n"));

  assert.equal(parsed.ok, true);
  assert.equal(parsed.issue, "");
  assert.equal(parsed.format.bom, "");
  assert.equal(parsed.format.newline, "\n");
  assert.deepEqual(parsed.rows.map(function (row) {
    return { id: row.id, disabled: row.disabled };
  }), [
    { id: "dsh-market", disabled: true },
    { id: "@scope/plugin", disabled: false },
    { id: "plain-row", disabled: false }
  ]);
  assert.equal(parsed.rows[0].disabledLine, 3);
});

test("parseUserRows keeps BOM and CRLF metadata for round-tripping", function () {
  const parsed = parseUserRows("\uFEFF- id: crlf-row\r\n  disabled: true\r\n");
  assert.equal(parsed.ok, true);
  assert.equal(parsed.format.bom, "\uFEFF");
  assert.equal(parsed.format.newline, "\r\n");
  assert.equal(parsed.format.body, "- id: crlf-row\n  disabled: true\n");
  assert.equal(parsed.rows[0].id, "crlf-row");
  assert.equal(parsed.rows[0].disabled, true);
});

test("parseUserRows rejects structurally unsafe user row files", function () {
  const cases = [
    "settings:\n  enabled: true\n",
    "- id:\n  disabled: true\n",
    "- id: bad\u0001name\n  disabled: true\n",
    "- id: spaced id\n  disabled: false\n",
    "- id: fine\n  disabled: true\n  note: user-edit\n",
    "disabled: true\n"
  ];
  for (const source of cases) {
    const parsed = parseUserRows(source);
    assert.equal(parsed.ok, false, JSON.stringify(source));
    assert.equal(typeof parsed.issue, "string");
    assert.ok(parsed.issue.length > 0);
  }
});

// ── renderDisableRows ───────────────────────────────────────────────────────

test("renderDisableRows appends an exact marked block to an empty file", function () {
  const rendered = renderDisableRows("", ["dsh-market"]);
  assert.deepEqual(rendered.result, { added: ["dsh-market"], already: [] });
  assert.equal(rendered.text, rowBlock("dsh-market") + "\n");
});

test("renderDisableRows preserves existing bytes and appends after them", function () {
  const original = "# 用户行\n- id: user-row\n  disabled: false\n";
  const rendered = renderDisableRows(original, ["@scope/plugin"]);
  assert.deepEqual(rendered.result, { added: ["@scope/plugin"], already: [] });
  assert.equal(rendered.text, original
    + "# [dshm-boot-rescue] disabled @scope/plugin\n"
    + "- id: '@scope/plugin'\n"
    + "  disabled: true\n");
});

test("renderDisableRows adds a trailing newline before appending", function () {
  const rendered = renderDisableRows("- id: user-row\n  disabled: false", ["guarded"]);
  assert.equal(rendered.text, "- id: user-row\n  disabled: false\n" + rowBlock("guarded") + "\n");
});

test("renderDisableRows does not rewrite rows already disabled by the user", function () {
  const original = "- id: dsh-market\n  disabled: true\n";
  const rendered = renderDisableRows(original, ["dsh-market"]);
  assert.deepEqual(rendered.result, { added: [], already: ["dsh-market"] });
  assert.equal(rendered.text, original);
});

test("renderDisableRows is idempotent for its own marker block", function () {
  const once = renderDisableRows("", ["dsh-market"]);
  const twice = renderDisableRows(once.text, ["dsh-market"]);
  assert.deepEqual(twice.result, { added: [], already: ["dsh-market"] });
  assert.equal(twice.text, once.text);
});

test("renderDisableRows appends a rescue override when the user row is enabled", function () {
  const original = "- id: dsh-market\n  disabled: false\n";
  const rendered = renderDisableRows(original, ["dsh-market"]);
  assert.deepEqual(rendered.result, { added: ["dsh-market"], already: [] });
  assert.equal(rendered.text, original + rowBlock("dsh-market") + "\n");
});

test("renderDisableRows round-trips BOM and CRLF", function () {
  const original = "\uFEFF# 用户行\r\n- id: user-row\r\n  disabled: false\r\n";
  const rendered = renderDisableRows(original, ["guarded"]);
  assert.ok(rendered.text.startsWith("\uFEFF"));
  assert.equal(rendered.text.indexOf("\n") > -1, true);
  assert.equal(rendered.text.replace(/\r\n/g, "").indexOf("\n"), -1);
  assert.match(rendered.text, /# \[dshm-boot-rescue\] disabled guarded\r\n- id: guarded\r\n  disabled: true\r\n$/);
});

test("renderDisableRows refuses structurally invalid files with 422", function () {
  assert.throws(function () {
    renderDisableRows("settings:\n  enabled: true\n", ["dsh-market"]);
  }, function (error) {
    return error.statusCode === 422 && error.code === "rows-invalid" && /无法安全解析/.test(error.message);
  });
});

// ── removeRescueRows ────────────────────────────────────────────────────────

test("removeRescueRows deletes only the exact marked block and keeps other rows", function () {
  const source = [
    "- id: user-disabled",
    "  disabled: true",
    ROW_MARKER + "guarded",
    "- id: guarded",
    "  disabled: true",
    ""
  ].join("\n");
  const rendered = removeRescueRows(source, new Set(["guarded"]));
  assert.deepEqual(rendered.result, { restored: ["guarded"] });
  assert.equal(rendered.text, "- id: user-disabled\n  disabled: true\n");
});

test("removeRescueRows restores all markers when ids is null or empty", function () {
  const source = [
    rowBlock("one"),
    rowBlock("two"),
    "- id: keep",
    "  disabled: false",
    ""
  ].join("\n");
  for (const ids of [null, undefined, []]) {
    const rendered = removeRescueRows(source, ids);
    assert.deepEqual(rendered.result.restored, ["one", "two"]);
    assert.equal(rendered.text, "- id: keep\n  disabled: false\n");
  }
});

test("removeRescueRows respects an explicit id subset (array, Set or string)", function () {
  const source = rowBlock("one") + "\n" + rowBlock("two") + "\n";
  const rendered = removeRescueRows(source, ["two"]);
  assert.deepEqual(rendered.result, { restored: ["two"] });
  assert.match(rendered.text, /disabled one/);
  assert.doesNotMatch(rendered.text, /disabled two/);

  // SPEC 之外的兼容：调用方可能直接传 Set 或单个字符串。
  assert.deepEqual(removeRescueRows(source, new Set(["two"])).result, { restored: ["two"] });
  assert.deepEqual(removeRescueRows(source, "two").result, { restored: ["two"] });
});

test("removeRescueRows refuses user-edited blocks instead of guessing", function () {
  const edited = [
    ROW_MARKER + "guarded",
    "- id: guarded",
    "  disabled: true",
    "  note: user-edit",
    ""
  ].join("\n");
  const rendered = removeRescueRows(edited, null);
  assert.deepEqual(rendered.result, { restored: [] });
  assert.equal(rendered.text, edited);

  const mismatched = [
    ROW_MARKER + "guarded",
    "- id: another-id",
    "  disabled: true",
    ""
  ].join("\n");
  const mismatchResult = removeRescueRows(mismatched, null);
  assert.deepEqual(mismatchResult.result, { restored: [] });
  assert.equal(mismatchResult.text, mismatched);

  const wrongFlag = [
    ROW_MARKER + "guarded",
    "- id: guarded",
    "  disabled: false",
    ""
  ].join("\n");
  const flagResult = removeRescueRows(wrongFlag, null);
  assert.deepEqual(flagResult.result, { restored: [] });
  assert.equal(flagResult.text, wrongFlag);
});

test("removeRescueRows matches quoted ids and can use the fallback marker prefix", function () {
  const quoted = [
    ROW_MARKER + "@scope/guarded",
    "- id: '@scope/guarded'",
    "  disabled: true",
    ""
  ].join("\n");
  const quotedResult = removeRescueRows(quoted, null);
  assert.deepEqual(quotedResult.result, { restored: ["@scope/guarded"] });
  assert.equal(quotedResult.text, "");

  const fallback = [
    PATCH_MARKER + "dsh-market",
    "- id: dsh-market",
    "  disabled: true",
    ""
  ].join("\n");
  assert.deepEqual(removeRescueRows(fallback, null).result, { restored: [] });
  const fallbackResult = removeRescueRows(fallback, null, { markerPrefix: PATCH_MARKER });
  assert.deepEqual(fallbackResult.result, { restored: ["dsh-market"] });
  assert.equal(fallbackResult.text, "");
});

test("removeRescueRows never removes forged markers for builtin rows or itself", function () {
  const forgedBuiltin = [
    ROW_MARKER + "@deepseek-ai/core-chat",
    "- id: '@deepseek-ai/core-chat'",
    "  disabled: true",
    ""
  ].join("\n");
  assert.deepEqual(removeRescueRows(forgedBuiltin, null).result, { restored: [] });
  assert.equal(removeRescueRows(forgedBuiltin, null).text, forgedBuiltin);

  const forgedSelf = [ROW_MARKER + "dshm-boot-rescue", "- id: dshm-boot-rescue", "  disabled: true", ""].join("\n");
  assert.deepEqual(removeRescueRows(forgedSelf, null).result, { restored: [] });
  assert.equal(removeRescueRows(forgedSelf, null).text, forgedSelf);
});

test("removeRescueRows leaves files without its markers byte-for-byte unchanged", function () {
  const source = "# 用户行\n- id: dsh-market\n  disabled: false\n";
  const rendered = removeRescueRows(source, null);
  assert.deepEqual(rendered.result, { restored: [] });
  assert.equal(rendered.text, source);
});

// ── patch fallback helpers ──────────────────────────────────────────────────

test("parsePatchRows extracts row ids, names, disabled flags, indentation and insert origin", function () {
  const rows = parsePatchRows([
    "# core seed overrides",
    "- id: web-runtime",
    "  config:",
    "    printUrl: true",
    "- insert:",
    "    - id: dsh-market",
    "      name: dshmarket",
    "      disabled: true",
    ""
  ].join("\n"));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, "web-runtime");
  assert.equal(rows[0].name, "");
  assert.equal(rows[0].insert, false, "core override rows are not insert rows");
  assert.equal(rows[0].indent, 0);
  assert.equal(rows[1].id, "dsh-market");
  assert.equal(rows[1].name, "dshmarket");
  assert.equal(rows[1].disabled, true);
  assert.equal(rows[1].insert, true, "bundle insert rows are real, actionable entries");
  assert.equal(rows[1].indent, 4);
});

test("checkPatchAppendable accepts top-level arrays and rejects maps", function () {
  for (const source of ["", "# comment\n", "[]\n", "# c\n[]\n# d\n", "- insert:\n    - id: x\n"]) {
    assert.equal(checkPatchAppendable(source).ok, true, JSON.stringify(source));
  }
  for (const source of ["settings:\n  enabled: true\n", "key: value\n", "  indented: value\n"]) {
    const result = checkPatchAppendable(source);
    assert.equal(result.ok, false, JSON.stringify(source));
    assert.ok(result.reason.length > 0);
  }
});

test("renderPatchDisableRows appends the fallback marker block", function () {
  const rendered = renderPatchDisableRows("", ["dsh-market"]);
  assert.deepEqual(rendered.result, { added: ["dsh-market"], already: [] });
  assert.equal(rendered.text, PATCH_MARKER + "dsh-market\n- id: dsh-market\n  disabled: true\n");
});

test("renderPatchDisableRows keeps existing patch content except a lone [] sentinel", function () {
  const original = "- insert:\n    - id: core\n      name: core\n";
  const rendered = renderPatchDisableRows(original, ["dsh-market"]);
  assert.equal(rendered.text, original.trimEnd()
    + "\n" + PATCH_MARKER + "dsh-market\n- id: dsh-market\n  disabled: true\n");

  const emptyArray = renderPatchDisableRows("[]\n", ["dsh-market"]);
  assert.equal(emptyArray.text, PATCH_MARKER + "dsh-market\n- id: dsh-market\n  disabled: true\n");
});

test("renderPatchDisableRows skips rows already disabled or already marked", function () {
  const disabled = "- id: dsh-market\n  disabled: true\n";
  assert.deepEqual(renderPatchDisableRows(disabled, ["dsh-market"]).result, {
    added: [],
    already: ["dsh-market"]
  });

  const marked = PATCH_MARKER + "dsh-market\n- id: dsh-market\n  disabled: true\n";
  assert.deepEqual(renderPatchDisableRows(marked, ["dsh-market"]).result, {
    added: [],
    already: ["dsh-market"]
  });
});

test("renderPatchDisableRows refuses maps with 422", function () {
  assert.throws(function () {
    renderPatchDisableRows("settings:\n  enabled: true\n", ["dsh-market"]);
  }, function (error) {
    return error.statusCode === 422 && error.code === "patch-invalid";
  });
});

// ── mutateTextFile ──────────────────────────────────────────────────────────

test("mutateTextFile writes atomically, keeps a backup, and restores exactly", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  const original = "# 用户行\n- id: user-row\n  disabled: false\n";
  await writeFile(filename, original, "utf8");

  const added = await mutateTextFile(filename, function (text) {
    return renderDisableRows(text, ["guarded"]);
  });
  assert.deepEqual(added, { added: ["guarded"], already: [] });

  const disabled = await readFile(filename, "utf8");
  assert.equal(disabled, original + rowBlock("guarded") + "\n");
  assert.equal(await readFile(filename + ".dshm-boot-rescue.bak", "utf8"), original);
  assert.deepEqual(readdirSync(directory).filter(function (file) {
    return file.endsWith(".tmp");
  }), []);

  const restored = await mutateTextFile(filename, function (text) {
    return removeRescueRows(text, null);
  });
  assert.deepEqual(restored, { restored: ["guarded"] });
  assert.equal(await readFile(filename, "utf8"), original);
});

test("mutateTextFile creates a missing target without a useless backup", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  const result = await mutateTextFile(filename, function (text) {
    return renderDisableRows(text, ["first"]);
  });
  assert.deepEqual(result, { added: ["first"], already: [] });
  assert.equal(await readFile(filename, "utf8"), rowBlock("first") + "\n");
  assert.equal(existsSync(filename + ".dshm-boot-rescue.bak"), false);
});

test("mutateTextFile skips the write when the render is unchanged", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  await writeFile(filename, "- id: keep\n  disabled: false\n", "utf8");
  const before = await readFile(filename, "utf8");
  const unchanged = await mutateTextFile(filename, function (text) {
    return { text: text, result: { added: [], already: ["keep"] } };
  });
  assert.deepEqual(unchanged, { added: [], already: ["keep"] });
  assert.equal(await readFile(filename, "utf8"), before);
});

test("mutateTextFile serializes concurrent mutations without losing either change", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  await writeFile(filename, "- id: seed\n  disabled: false\n", "utf8");

  await Promise.all([
    mutateTextFile(filename, function (text) { return renderDisableRows(text, ["one"]); }),
    mutateTextFile(filename, function (text) { return renderDisableRows(text, ["two"]); })
  ]);

  const text = await readFile(filename, "utf8");
  assert.match(text, /# \[dshm-boot-rescue\] disabled one/);
  assert.match(text, /# \[dshm-boot-rescue\] disabled two/);
});

test("mutateTextFile rebases when an external writer changes the file", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  const external = "- id: external\n  disabled: false\n";
  await writeFile(filename, "- id: original\n  disabled: false\n", "utf8");
  let injected = false;

  const result = await mutateTextFile(filename, function (text) {
    if (!injected) {
      injected = true;
      writeFileSync(filename, external, "utf8");
    }
    return renderDisableRows(text, ["guarded"]);
  });

  assert.deepEqual(result, { added: ["guarded"], already: [] });
  const finalText = await readFile(filename, "utf8");
  assert.match(finalText, /- id: external/);
  assert.match(finalText, /# \[dshm-boot-rescue\] disabled guarded/);
  assert.doesNotMatch(finalText, /- id: original/);
});

test("mutateTextFile propagates render errors and leaves no temp file", async function (t) {
  const directory = await temporaryDirectory(t);
  const filename = join(directory, ".dshm-plugin-rows.yml");
  await writeFile(filename, "- id: keep\n  disabled: false\n", "utf8");

  await assert.rejects(
    mutateTextFile(filename, function () { throw new Error("render-failed"); }),
    /render-failed/
  );
  assert.equal(await readFile(filename, "utf8"), "- id: keep\n  disabled: false\n");
  assert.deepEqual(readdirSync(directory).filter(function (file) {
    return file.endsWith(".tmp");
  }), []);
});

// ── 数据目录 / profile 定位 ─────────────────────────────────────────────────

test("resolveHomeDir prefers DSH_HOME, falls back to DSHM_HOME, ignores invalid values", async function (t) {
  const directory = await temporaryDirectory(t);
  const second = join(directory, "second");
  await mkdir(second);

  assert.deepEqual(resolveHomeDir({ DSH_HOME: directory }), { dir: directory, source: "DSH_HOME" });
  assert.deepEqual(resolveHomeDir({ DSHM_HOME: directory }), { dir: directory, source: "DSHM_HOME" });
  assert.deepEqual(resolveHomeDir({ DSH_HOME: directory, DSHM_HOME: second }), {
    dir: directory,
    source: "DSH_HOME"
  });
  assert.deepEqual(resolveHomeDir({ DSH_HOME: "relative/path", DSHM_HOME: directory }), {
    dir: directory,
    source: "DSHM_HOME"
  });
  assert.deepEqual(resolveHomeDir({ DSH_HOME: join(directory, "missing") }), { dir: "", source: "" });
  assert.deepEqual(resolveHomeDir({}), { dir: "", source: "" });
});

test("readHostReadyProfile reads the active profile name defensively", async function (t) {
  const directory = await temporaryDirectory(t);
  assert.equal(readHostReadyProfile(directory), "");

  await writeFile(join(directory, "host-ready.json"), JSON.stringify({ profile: "ondevice" }), "utf8");
  assert.equal(readHostReadyProfile(directory), "ondevice");

  await writeFile(join(directory, "host-ready.json"), "{not json", "utf8");
  assert.equal(readHostReadyProfile(directory), "");

  await writeFile(join(directory, "host-ready.json"), JSON.stringify({ profile: "" }), "utf8");
  assert.equal(readHostReadyProfile(directory), "");
});

test("findProfileDir walks up to a declared dsh.profile and stays inside home", async function (t) {
  const root = await temporaryDirectory(t);
  const home = join(root, "home");
  const profile = join(home, "profiles", "ondevice");
  const nested = join(profile, "node_modules", "dshm-boot-rescue", "lib");
  await mkdir(nested, { recursive: true });
  await writeFile(join(profile, "package.json"), JSON.stringify({ dsh: { profile: {} } }), "utf8");

  assert.equal(findProfileDir(nested, home), profile);
  assert.equal(findProfileDir(profile, home), profile);
  assert.equal(findProfileDir(profile), profile);
  assert.equal(findProfileDir(join(home, "unrelated"), home), "");

  const otherHome = join(root, "other-home");
  await mkdir(otherHome, { recursive: true });
  assert.equal(findProfileDir(profile, otherHome), "");

  const plain = join(root, "plain");
  await mkdir(plain, { recursive: true });
  await writeFile(join(plain, "package.json"), JSON.stringify({ name: "not-a-profile" }), "utf8");
  assert.equal(findProfileDir(plain, root), "");
});

// ── 请求校验 ────────────────────────────────────────────────────────────────

test("isLoopbackAddress accepts loopback forms and rejects LAN addresses", function () {
  for (const address of [
    "127.0.0.1",
    "127.22.3.4",
    "::1",
    "0:0:0:0:0:0:0:1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::1%lo"
  ]) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ["192.168.1.20", "10.0.0.1", "::ffff:192.168.1.20", "localhost", "", null, undefined]) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test("assertMutationRequest accepts same-origin loopback JSON only", function () {
  function request(remoteAddress, headers) {
    return {
      socket: { remoteAddress: remoteAddress },
      headers: Object.assign({ "content-type": "application/json", host: "127.0.0.1:3120" }, headers)
    };
  }
  function expectMutationError(target, statusCode, code) {
    assert.throws(function () { assertMutationRequest(target); }, function (error) {
      return error.statusCode === statusCode && error.code === code;
    });
  }

  assert.doesNotThrow(function () { assertMutationRequest(request("127.0.0.1")); });
  assert.doesNotThrow(function () { assertMutationRequest(request("::1", { "sec-fetch-site": "same-origin" })); });
  assert.doesNotThrow(function () { assertMutationRequest(request("127.0.0.1", { "sec-fetch-site": "none" })); });
  assert.doesNotThrow(function () {
    assertMutationRequest(request("127.0.0.1", { origin: "http://127.0.0.1:3120" }));
  });
  // localhost / [::1] 也是回环 Host 字面量。
  assert.doesNotThrow(function () {
    assertMutationRequest(request("127.0.0.1", { host: "localhost:3120" }));
  });
  assert.doesNotThrow(function () {
    assertMutationRequest(request("::1", { host: "[::1]:3120" }));
  });

  expectMutationError(request("192.168.1.20"), 403, "remote-mutation-disabled");
  // 防 DNS rebinding：Host 头必须是回环字面量，哪怕 socket 是回环。
  expectMutationError(request("127.0.0.1", { host: "evil.example:3120" }), 403, "non-loopback-host");
  expectMutationError(request("127.0.0.1", { host: "" }), 403, "non-loopback-host");
  expectMutationError(request("127.0.0.1", { "content-type": "text/plain" }), 415, "content-type");
  expectMutationError(request("127.0.0.1", { "sec-fetch-site": "cross-site" }), 403, "cross-origin");
  expectMutationError(request("127.0.0.1", { origin: "http://evil.example" }), 403, "origin-mismatch");
  expectMutationError(request("127.0.0.1", { origin: "not a url" }), 403, "invalid-origin");
});

test("normalizeIds trims, deduplicates, bounds and rejects control characters", function () {
  assert.deepEqual(normalizeIds({ ids: [" one ", "one", "two"] }), ["one", "two"]);
  assert.deepEqual(normalizeIds({ id: "single" }), ["single"]);
  assert.deepEqual(normalizeIds({ ids: "scalar" }), ["scalar"]);
  assert.deepEqual(normalizeIds({ ids: [123, "123"] }), ["123"]);
  assert.deepEqual(normalizeIds({ ids: [] }, { allowEmpty: true }), []);

  for (const body of [{}, { ids: [] }, { ids: null }]) {
    assert.throws(function () { normalizeIds(body); }, function (error) {
      return error.statusCode === 400 && error.code === "empty-ids";
    });
  }

  const tooMany = Array.from({ length: 33 }, function (_, index) { return "id-" + index; });
  assert.throws(function () { normalizeIds({ ids: tooMany }); }, function (error) {
    return error.statusCode === 400 && error.code === "too-many-ids";
  });

  for (const value of ["", "   ", "bad\nname", "bad\tname", "bad\u0000name", "a".repeat(201), "two words"]) {
    assert.throws(function () { normalizeIds({ ids: [value] }); }, function (error) {
      return error.statusCode === 400 && error.code === "invalid-id";
    }, JSON.stringify(value));
  }
});

// ── buildCatalog ────────────────────────────────────────────────────────────

test("buildCatalog only lists user-row or installed candidates and merges their facts", function () {
  const entries = buildCatalog({
    patchEntries: [
      { id: "dsh-market", name: "dshmarket", insert: false },
      { id: "@deepseek-ai/core-chat", name: "@deepseek-ai/dsh-core-chat", insert: false },
      { id: "dshm-boot-rescue", name: "dshm-boot-rescue", insert: false },
      { id: "web-runtime", name: "", insert: false }
    ],
    installedEntries: [
      { id: "dsh-market", name: "dshmarket", packageName: "dsh-market", disabled: false, source: "installed" },
      { id: "dsh-tool", name: "dsh-tool", packageName: "dsh-tool", disabled: false, source: "installed-fallback" }
    ],
    userRows: [
      { id: "dsh-market", disabled: false },
      { id: "dsh-tool", disabled: true },
      { id: "loose-row", disabled: false },
      { id: "web-runtime", disabled: false }
    ],
    loaderEntries: [
      { id: "dsh-market", name: "dshmarket", disabled: false },
      { id: "not-a-candidate", name: "not-a-candidate", disabled: false }
    ],
    rescueRows: ["dsh-market"],
    writable: true
  });

  assert.deepEqual(entries.map(function (entry) { return entry.id; }).sort(), [
    "dsh-market",
    "dsh-tool",
    "loose-row",
    "web-runtime"
  ]);
  // patch-only rows (core seed overrides / builtin / self) never become candidates.
  assert.equal(findEntry(entries, "@deepseek-ai/core-chat"), undefined);
  assert.equal(findEntry(entries, "dshm-boot-rescue"), undefined);
  assert.equal(findEntry(entries, "not-a-candidate"), undefined);

  const market = findEntry(entries, "dsh-market");
  assert.ok(market);
  assert.equal(market.groupId, "dsh-market");
  assert.equal(market.packageName, "dsh-market");
  assert.equal(market.hasUserRow, true);
  assert.equal(market.installed, true);
  assert.equal(market.disabled, false);
  assert.equal(market.disabledByRescue, true);
  assert.equal(market.actionable, false, "rescue-disabled rows are no longer actionable");
  assert.equal(market.builtin, false);
  assert.ok(market.aliases.indexOf("dshmarket") !== -1);

  const tool = findEntry(entries, "dsh-tool");
  assert.ok(tool);
  assert.equal(tool.actionable, false, "unverified fallback packages stay unmapped");
  assert.equal(tool.disabled, true);
  assert.equal(tool.reason, "未映射到真实插件行，禁止直接写入");

  const loose = findEntry(entries, "loose-row");
  assert.ok(loose);
  assert.equal(loose.actionable, false);
  assert.equal(loose.protectedReason, "");
  assert.equal(loose.reason, "未映射到真实插件行，禁止直接写入");

  // Core override rows without a name never become known rows, even with a user row.
  const webRuntime = findEntry(entries, "web-runtime");
  assert.ok(webRuntime);
  assert.equal(webRuntime.actionable, false);
  assert.equal(webRuntime.builtin, false);
  assert.equal(webRuntime.reason, "未映射到真实插件行，禁止直接写入");
});

test("buildCatalog protects builtin names and itself, and hides patch-only builtins", function () {
  const hidden = buildCatalog({
    patchEntries: [{ id: "@deepseek-ai/core-chat", name: "@deepseek-ai/dsh-core-chat", insert: false }],
    writable: true
  });
  assert.equal(findEntry(hidden, "@deepseek-ai/core-chat"), undefined);

  const visible = buildCatalog({
    patchEntries: [{ id: "@deepseek-ai/core-chat", name: "@deepseek-ai/dsh-core-chat", insert: false }],
    userRows: [{ id: "@deepseek-ai/core-chat", disabled: false }],
    writable: true
  });
  const builtin = findEntry(visible, "@deepseek-ai/core-chat");
  assert.ok(builtin);
  assert.equal(builtin.builtin, true);
  assert.equal(builtin.protected, true);
  assert.equal(builtin.protectedReason, "builtin");
  assert.equal(builtin.actionable, false);
  assert.equal(builtin.reason, "内置 @deepseek-ai 行受保护，救援插件不会修改");

  // A core override id only gets builtin protection through the loader's name mapping.
  const coreMapped = buildCatalog({
    patchEntries: [{ id: "core-chat", name: "", insert: false }],
    userRows: [{ id: "core-chat", disabled: false }],
    loaderEntries: [{ id: "core-chat", name: "@deepseek-ai/dsh-core-chat", disabled: false }],
    writable: true
  });
  const core = findEntry(coreMapped, "core-chat");
  assert.ok(core);
  assert.equal(core.builtin, true);
  assert.equal(core.protectedReason, "builtin");
  assert.equal(core.actionable, false);

  const coreUnmapped = buildCatalog({
    patchEntries: [{ id: "core-chat", name: "", insert: false }],
    userRows: [{ id: "core-chat", disabled: false }],
    writable: true
  });
  const unmappedCore = findEntry(coreUnmapped, "core-chat");
  assert.ok(unmappedCore);
  assert.equal(unmappedCore.builtin, false);
  assert.equal(unmappedCore.actionable, false);
  assert.equal(unmappedCore.reason, "未映射到真实插件行，禁止直接写入");

  const withSelf = buildCatalog({
    patchEntries: [{ id: "dshm-boot-rescue", name: "dshm-boot-rescue", insert: false }],
    userRows: [{ id: "dshm-boot-rescue", disabled: false }],
    writable: true
  });
  const self = findEntry(withSelf, "dshm-boot-rescue");
  assert.ok(self);
  assert.equal(self.protected, true);
  assert.equal(self.protectedReason, "self");
  assert.equal(self.actionable, false);
  assert.equal(self.reason, "救援插件自身，禁止停用");
});

test("buildCatalog marks unverified fallback packages as unmapped and read-only catalogs non-actionable", function () {
  const entries = buildCatalog({
    installedEntries: [
      { id: "dsh-fallback", name: "dsh-fallback", packageName: "dsh-fallback", disabled: false, source: "installed-fallback" }
    ],
    writable: true
  });
  const fallback = findEntry(entries, "dsh-fallback");
  assert.ok(fallback);
  assert.equal(fallback.installed, true);
  assert.equal(fallback.actionable, false);
  assert.equal(fallback.reason, "未映射到真实插件行，禁止直接写入");

  const readOnly = buildCatalog({
    patchEntries: [{ id: "dsh-market", name: "dshmarket", insert: false }],
    userRows: [{ id: "dsh-market", disabled: false }],
    writable: false
  });
  const market = findEntry(readOnly, "dsh-market");
  assert.ok(market);
  assert.equal(market.actionable, false);
  assert.equal(market.protectedReason, "");
});

// ── apply：HTTP 端到端 ──────────────────────────────────────────────────────

test("apply serves state/health/preview and performs disable + restore end-to-end", async function (t) {
  const fixture = await createInstalledHome(t);
  const rowsPath = join(fixture.profile, ".dshm-plugin-rows.yml");

  await withEnv(t, { DSH_HOME: fixture.home, DSHM_HOME: undefined, DSHM_PROFILE: undefined }, async function () {
    const fake = createFakeContext([{ id: "dsh-market", name: "dshmarket", disabled: false }]);
    apply(fake.ctx);
    assert.equal(typeof fake.server.route, "function");
    assert.equal(typeof fake.server.tap, "function");

    let response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    assert.equal(response.statusCode, 200);
    const state = parseResponse(response);
    assert.equal(state.ok, true);
    assert.equal(state.version, version);
    assert.equal(state.mode, "rows");
    assert.equal(state.writable, true);
    assert.equal(state.warning, "");
    assert.equal(state.rowsPath, rowsPath);
    assert.equal(state.profileDir, fixture.profile);
    assert.equal(state.homeDir, fixture.home);
    assert.deepEqual(state.rescueRows, []);

    assert.equal(state.entries.length, 3);
    const market = findEntry(state.entries, "dsh-market");
    assert.equal(market.actionable, true);
    assert.equal(market.installed, true);
    assert.equal(market.hasUserRow, true);
    assert.equal(market.disabled, false);
    assert.equal(market.disabledByRescue, false);
    assert.equal(findEntry(state.entries, "dsh-tool").disabled, true);
    assert.equal(findEntry(state.entries, "loose-row").actionable, false);
    assert.equal(findEntry(state.entries, "core-chat"), undefined, "builtin seed row stays hidden");

    assert.deepEqual(state.counts, { entries: 3, actionable: 1, rescue: 0 });
    assert.equal(state.diagnostics.homeDir, "DSH_HOME");
    assert.equal(state.diagnostics.profileDir, "host-ready");
    assert.equal(state.diagnostics.webServer, "ok");
    assert.equal(state.diagnostics.route, "ok");
    assert.equal(state.diagnostics.tapIndex, "ok");
    assert.equal(state.diagnostics.loader, "ok");
    assert.equal(state.diagnostics.rowsFile, "found");
    assert.equal(state.diagnostics.logFile, join(fixture.home, "dshm-boot-rescue.log"));

    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/health"));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseResponse(response), {
      ok: true,
      version: version,
      webServer: "ok",
      loader: "ok",
      route: "ok",
      tapIndex: "ok",
      injections: 0,
      mode: "ready"
    });

    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/preview"));
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /text\/html/);
    assert.match(response.headers["content-security-policy"], /default-src 'none'/);
    assert.match(response.body, /data-dshm-boot-rescue-preview="1"/);
    assert.match(response.body, /Failed to load plugins/);
    assert.match(response.body, /\/dshm-boot-rescue\/client\.js/);

    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/client.js"));
    assert.equal(response.statusCode, 200);
    assert.match(response.headers["content-type"], /javascript/);
    assert.ok(response.body.length > 1000, "rescue client script should be non-trivial");

    // 停用 → 写入持久用户行
    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dsh-market"] }
    }));
    assert.equal(response.statusCode, 200);
    const disabled = parseResponse(response);
    assert.equal(disabled.ok, true);
    assert.equal(disabled.mode, "rows");
    assert.deepEqual(disabled.disabled, ["dsh-market"]);
    assert.deepEqual(disabled.already, []);
    assert.deepEqual(disabled.rescueRows, ["dsh-market"]);
    assert.equal(disabled.warning, "");

    const expectedDisabled = fixture.rows + rowBlock("dsh-market") + "\n";
    assert.equal(await readFile(rowsPath, "utf8"), expectedDisabled);
    assert.equal(await readFile(rowsPath + ".dshm-boot-rescue.bak", "utf8"), fixture.rows);

    // 再停用一次 → 该行已由救援停用 / 配置已禁用，不再 actionable，整单拒绝
    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dsh-market"] }
    }));
    assert.equal(response.statusCode, 409);
    assert.equal(parseResponse(response).code, "not-actionable");
    assert.equal(await readFile(rowsPath, "utf8"), expectedDisabled);

    // 停用后 state 反映 rescueRows / 已不可勾选
    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    const rescuedState = parseResponse(response);
    assert.deepEqual(rescuedState.rescueRows, ["dsh-market"]);
    const rescuedMarket = findEntry(rescuedState.entries, "dsh-market");
    assert.equal(rescuedMarket.disabled, true);
    assert.equal(rescuedMarket.disabledByRescue, true);
    assert.equal(rescuedMarket.actionable, false);
    assert.deepEqual(rescuedState.counts, { entries: 3, actionable: 0, rescue: 1 });

    // 安全校验：不能停用自己 / 未映射 / 未知 / 非回环 / 非 JSON
    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dshm-boot-rescue"] }
    }));
    assert.equal(response.statusCode, 409);
    assert.deepEqual(parseResponse(response), {
      ok: false,
      error: "dshm-boot-rescue cannot disable itself",
      code: "self-protected"
    });

    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["loose-row"] }
    }));
    assert.equal(response.statusCode, 409);
    assert.equal(parseResponse(response).code, "not-actionable");

    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["no-such-row"] }
    }));
    assert.equal(response.statusCode, 404);
    assert.equal(parseResponse(response).code, "unknown-id");

    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dsh-market"] },
      remoteAddress: "192.168.1.20"
    }));
    assert.equal(response.statusCode, 403);
    assert.equal(parseResponse(response).code, "remote-mutation-disabled");

    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dsh-market"] },
      headers: { "content-type": "text/plain" }
    }));
    assert.equal(response.statusCode, 415);
    assert.equal(parseResponse(response).code, "content-type");

    // 非回环 GET 只能读，writable=false
    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state", {
      remoteAddress: "192.168.1.20"
    }));
    assert.equal(response.statusCode, 200);
    const remoteState = parseResponse(response);
    assert.equal(remoteState.writable, false);
    assert.equal(remoteState.readOnlyReasonCode, "remote-mutation-disabled");
    // 非回环只读：所有条目都不能再勾选
    assert.ok(remoteState.entries.length > 0);
    for (const entry of remoteState.entries) {
      assert.equal(entry.actionable, false, entry.id);
    }
    assert.equal(remoteState.counts.actionable, 0);

    // tapIndex：字符串注入 client.js，非字符串原样返回，重复注入保持幂等
    assert.equal(fake.server.tap(null), null);
    const nonString = { html: "<html></html>" };
    assert.equal(fake.server.tap(nonString), nonString);
    const injected = fake.server.tap("<html><head></head><body></body></html>");
    assert.match(injected, /\/dshm-boot-rescue\/client\.js/);
    assert.equal(fake.server.tap(injected), injected);

    // 恢复 → 只删本插件标记块，其余字节原样
    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/restore", {
      body: {}
    }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseResponse(response), { ok: true, mode: "rows", restored: ["dsh-market"] });
    assert.equal(await readFile(rowsPath, "utf8"), fixture.rows);
  });
});

test("apply enters read-only mode when no usable data directory exists", async function (t) {
  const directory = await temporaryDirectory(t);
  await withEnv(t, {
    DSH_HOME: join(directory, "missing-home"),
    DSHM_HOME: join(directory, "missing-fallback"),
    DSHM_PROFILE: undefined
  }, async function () {
    const fake = createFakeContext([]);
    apply(fake.ctx);
    const response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    assert.equal(response.statusCode, 200);
    const state = parseResponse(response);
    assert.equal(state.ok, true);
    assert.equal(state.mode, "readonly");
    assert.equal(state.writable, false);
    assert.equal(state.readOnlyReasonCode, "home-unresolved");
    assert.match(state.readOnlyReason, /DSH_HOME/);
    assert.equal(state.homeDir, "");
    assert.deepEqual(state.entries, []);
    assert.deepEqual(state.rescueRows, []);
  });
});

test("apply uses patch fallback when the user row file is structurally invalid", async function (t) {
  const patchText = "- insert:\n    - id: dsh-market\n      name: 'dshmarket'\n";
  const fixture = await createFallbackHome(t, patchText);
  const patchPath = join(fixture.profile, "cordis.patch.yml");

  await withEnv(t, { DSH_HOME: fixture.home, DSHM_HOME: undefined, DSHM_PROFILE: undefined }, async function () {
    const fake = createFakeContext([]);
    apply(fake.ctx);

    let response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    assert.equal(response.statusCode, 200);
    let state = parseResponse(response);
    assert.equal(state.mode, "patch-fallback");
    assert.equal(state.writable, true);
    assert.equal(state.warning, FALLBACK_WARNING);
    assert.equal(findEntry(state.entries, "dsh-market").actionable, true);

    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/disable", {
      body: { ids: ["dsh-market"] }
    }));
    assert.equal(response.statusCode, 200);
    const disabled = parseResponse(response);
    assert.equal(disabled.mode, "patch-fallback");
    assert.deepEqual(disabled.disabled, ["dsh-market"]);
    assert.equal(disabled.warning, FALLBACK_WARNING);

    const expectedPatch = patchText
      + PATCH_MARKER + "dsh-market\n- id: dsh-market\n  disabled: true\n";
    assert.equal(await readFile(patchPath, "utf8"), expectedPatch);
    assert.equal(await readFile(patchPath + ".dshm-boot-rescue.bak", "utf8"), patchText);

    response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    state = parseResponse(response);
    assert.deepEqual(state.rescueRows, ["dsh-market"]);
    assert.equal(findEntry(state.entries, "dsh-market").disabledByRescue, true);
    assert.equal(findEntry(state.entries, "dsh-market").actionable, false);

    // 降级模式恢复同样只删自己的标记块
    response = await callRoute(fake.server.route, httpRequest("POST", "/dshm-boot-rescue/restore", {
      body: {}
    }));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(parseResponse(response), {
      ok: true,
      mode: "patch-fallback",
      restored: ["dsh-market"]
    });
    assert.equal(await readFile(patchPath, "utf8"), patchText);
  });
});

test("apply stays read-only when the fallback patch cannot be appended", async function (t) {
  const fixture = await createFallbackHome(t, "settings:\n  enabled: true\n");
  await withEnv(t, { DSH_HOME: fixture.home, DSHM_HOME: undefined, DSHM_PROFILE: undefined }, async function () {
    const fake = createFakeContext([]);
    apply(fake.ctx);
    const response = await callRoute(fake.server.route, httpRequest("GET", "/dshm-boot-rescue/state"));
    assert.equal(response.statusCode, 200);
    const state = parseResponse(response);
    assert.equal(state.mode, "readonly");
    assert.equal(state.writable, false);
    assert.equal(state.readOnlyReasonCode, "patch-unappendable");
    assert.match(state.readOnlyReason, /cordis\.patch\.yml/);
  });
});

// ── 救援脚本 lib/rescue-client.js：静态契约 + 浏览器行为 ────────────────────

const CLIENT_PATH = new URL("../lib/rescue-client.js", import.meta.url);

function fakeNode(tagName) {
  const node = {
    tagName: tagName,
    className: "",
    id: "",
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    style: {},
    children: [],
    _nodes: {},
    appendChild: function (child) { this.children.push(child); return child; },
    removeChild: function (child) {
      const index = this.children.indexOf(child);
      if (index !== -1) this.children.splice(index, 1);
      return child;
    },
    addEventListener: function () {},
    removeEventListener: function () {},
    setAttribute: function () {},
    getAttribute: function () { return null; },
    hasAttribute: function () { return false; },
    querySelector: function (selector) {
      if (!Object.prototype.hasOwnProperty.call(this._nodes, selector)) {
        this._nodes[selector] = fakeNode("div");
      }
      return this._nodes[selector];
    },
    querySelectorAll: function () { return []; },
    remove: function () {}
  };
  return node;
}

function createRescueSandbox(options) {
  const opts = options || {};
  const body = fakeNode("body");
  body.hasAttribute = function (name) {
    return !!opts.preview && name === "data-dshm-boot-rescue-preview";
  };
  const root = fakeNode("root");
  root.textContent = opts.text || "";
  root.querySelector = function () { return opts.healthy ? fakeNode("tree") : null; };
  const document = {
    readyState: "complete",
    body: body,
    head: fakeNode("head"),
    documentElement: fakeNode("html"),
    getElementById: function (id) { return id === "root" ? root : null; },
    createElement: function (tagName) { return fakeNode(tagName); },
    addEventListener: function () {},
    querySelector: function () { return null; }
  };
  const fetchCalls = [];
  class FakeMutationObserver {
    constructor(callback) { this.callback = callback; }
    observe() {}
    disconnect() {}
  }
  const window = {
    setTimeout: function () { return 1; },
    clearTimeout: function () {},
    matchMedia: function () { return { matches: false }; }
  };
  const sandbox = {
    window: window,
    document: document,
    MutationObserver: FakeMutationObserver,
    fetch: function (url, init) {
      fetchCalls.push({ url: url, init: init });
      if (opts.fetchReject) return Promise.reject(new Error(opts.fetchError || "network down"));
      return Promise.resolve({
        ok: true,
        status: 200,
        json: function () { return Promise.resolve(opts.state || {}); }
      });
    },
    navigator: {},
    location: { reload: function () {} }
  };
  return { sandbox: sandbox, body: body, document: document, fetchCalls: fetchCalls };
}

async function flushClientWork() {
  await new Promise(function (resolve) { setTimeout(resolve, 0); });
}

function sampleClientState() {
  return {
    ok: true,
    version: "1.0.0",
    generatedAt: "2026-10-21T00:00:00.000Z",
    mode: "rows",
    writable: true,
    readOnlyReason: "",
    readOnlyReasonCode: "",
    warning: "",
    rowsPath: "/tmp/profile/.dshm-plugin-rows.yml",
    profileDir: "/tmp/profile",
    homeDir: "/tmp/home",
    entries: [{
      id: "dsh-market",
      groupId: "dsh-market",
      name: "dshmarket",
      packageName: "dsh-market",
      aliases: ["dsh-market", "dshmarket"],
      builtin: false,
      protected: false,
      protectedReason: "",
      installed: true,
      hasUserRow: true,
      disabled: false,
      disabledByRescue: false,
      actionable: true,
      reason: ""
    }, {
      id: "dshm-boot-rescue",
      groupId: "dshm-boot-rescue",
      name: "dshm-boot-rescue",
      packageName: "dshm-boot-rescue",
      aliases: ["dshm-boot-rescue"],
      builtin: false,
      protected: true,
      protectedReason: "self",
      installed: true,
      hasUserRow: false,
      disabled: false,
      disabledByRescue: false,
      actionable: false,
      reason: "救援插件自身，禁止停用"
    }],
    rescueRows: [],
    counts: { entries: 2, actionable: 1, rescue: 0 },
    diagnostics: {}
  };
}

test("rescue client is a self-contained IIFE with mandated copy and no forbidden APIs", async function () {
  const text = await readFile(CLIENT_PATH, "utf8");
  assert.ok(text.length > 1000);
  assert.match(text, /\(function\s*\(\)\s*\{/);
  assert.match(text, /["']use strict["']/);

  assert.doesNotMatch(text, /^\s*import\s/m);
  assert.doesNotMatch(text, /\bimport\s*\(/);
  assert.doesNotMatch(text, /\brequire\s*\(/);
  assert.doesNotMatch(text, /^\s*export\s/m);
  assert.doesNotMatch(text, /\bnew\s+Worker\b/);
  assert.doesNotMatch(text, /\bWebAssembly\b/);
  assert.doesNotMatch(text, /\bsetInterval\s*\(/);
  assert.doesNotMatch(text, /\blocation\s*\.\s*reload\s*\(/);
  assert.doesNotMatch(text, /刷新页面/);
  assert.doesNotMatch(text, /\beval\s*\(/);
  assert.doesNotMatch(text, /new\s+Function\s*\(/);

  const needles = [
    "Failed to load plugins",
    "启动恢复中心",
    "停用后请划掉后台重新打开应用",
    "本次停用重启应用后失效，请进入系统后立即卸载肇事插件",
    "停用所选并等待重启",
    "救援服务暂时不可用",
    "只读自检",
    "疑似故障",
    "已停用",
    "全部",
    "恢复救援停用项",
    "复制诊断",
    "选择当前可用项",
    "清除选择",
    "HEALTHY_UI_SELECTOR",
    "data-dshm-boot-rescue-preview",
    "__DSHM_BOOT_RESCUE__",
    "/dshm-boot-rescue/state",
    "/dshm-boot-rescue/disable",
    "/dshm-boot-rescue/restore",
    "import failed",
    "dbr-"
  ];
  for (const needle of needles) {
    assert.ok(text.indexOf(needle) !== -1, "缺少 " + needle);
  }

  assert.match(text, /failed to import loader entry/i);
  assert.match(text, /failed to apply loader entry/i);
  assert.match(text, /failed to resolve loader entry/i);
  assert.match(text, /failed to initialize loader entry/i);
  assert.match(text, /client-modules/);
  assert.match(text, /pending \\\(waiting for service/);
  assert.match(text, /web boot:/);
  assert.match(text, /import failed\b/);
  assert.match(text, /IMPORT_FAILED_PATTERN/);
  assert.match(text, /new MutationObserver/);
  assert.match(text, /credentials\s*:\s*["']same-origin["']/);
  assert.match(text, /position\s*:\s*fixed/);
  assert.match(text, /width:min\(760px/);
});

test("rescue client never mounts on a healthy UI that merely quotes failure text", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    healthy: true,
    text: "聊天记录：Failed to load plugins failed to import loader entry example"
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();

  assert.equal(run.fetchCalls.length, 0);
  assert.equal(run.body.children.length, 0);
});

test("rescue client mounts the panel on the real failure page and auto-selects suspects", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    text: "HARNESS\nFailed to load plugins\nfailed to import loader entry dshmarket (dsh-market)\nweb boot: 1 entry did not activate",
    state: sampleClientState()
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();

  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.fetchCalls[0].url, "/dshm-boot-rescue/state");
  assert.deepEqual(run.fetchCalls[0].init, { credentials: "same-origin" });
  assert.equal(run.body.children.length, 1);

  const overlay = run.body.children[0];
  assert.match(overlay.className, /dbr-overlay/);
  assert.match(overlay.innerHTML, /启动恢复中心/);
  assert.match(overlay.innerHTML, /停用后请划掉后台重新打开应用/);
  assert.match(overlay.innerHTML, /插件启停只在进程启动时拼装/);

  const status = overlay._nodes['[data-role="status"]'];
  assert.equal(status.textContent, "已选择 1 个插件；只会写入带救援标记的临时停用行。");
  const list = overlay._nodes['[data-role="list"]'];
  assert.match(list.innerHTML, /data-id="dsh-market"/);
  assert.match(list.innerHTML, /疑似故障/);
  assert.match(list.innerHTML, /checked/);
  const summary = overlay._nodes['[data-role="summary"]'];
  assert.match(summary.textContent, /显示 1 项/);
  assert.match(summary.textContent, /可操作 1 项/);
});

test("rescue client recognizes the core '<name>: import failed' hint", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    text: "HARNESS\nFailed to load plugins\ndshmarket: import failed: cannot load module",
    state: sampleClientState()
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();

  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.body.children.length, 1);
  const overlay = run.body.children[0];
  const list = overlay._nodes['[data-role="list"]'];
  assert.match(list.innerHTML, /data-id="dsh-market"/);
  assert.match(list.innerHTML, /疑似故障/);
  const status = overlay._nodes['[data-role="status"]'];
  assert.equal(status.textContent, "已选择 1 个插件；只会写入带救援标记的临时停用行。");
});

test("rescue client shows the read-only self-check notice on the preview page", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    preview: true,
    text: "Failed to load plugins\nfailed to import loader entry dshmarket (dsh-market)",
    state: sampleClientState()
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();

  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.body.children.length, 1);
  const overlay = run.body.children[0];
  const status = overlay._nodes['[data-role="status"]'];
  assert.equal(status.textContent, "只读自检：不会修改任何配置");
  assert.match(overlay.innerHTML, /只读自检/);
});

test("rescue client falls back to a diagnostic panel when the rescue service is down", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    text: "Failed to load plugins\nfailed to import loader entry broken-plugin",
    fetchReject: true
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();

  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.body.children.length, 1);
  assert.match(run.body.children[0].innerHTML, /救援服务暂时不可用/);
  assert.match(run.body.children[0].innerHTML, /\/dshm-boot-rescue\/health/);
  assert.match(run.body.children[0].innerHTML, /停用后请划掉后台重新打开应用/);
});

test("rescue client is idempotent when the script is evaluated twice", async function () {
  const clientText = await readFile(CLIENT_PATH, "utf8");
  const run = createRescueSandbox({
    clientText: clientText,
    text: "Failed to load plugins\nfailed to import loader entry dshmarket (dsh-market)",
    state: sampleClientState()
  });
  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();
  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.body.children.length, 1);

  vm.runInNewContext(clientText, run.sandbox, { filename: "rescue-client.js" });
  await flushClientWork();
  assert.equal(run.fetchCalls.length, 1);
  assert.equal(run.body.children.length, 1);
});
