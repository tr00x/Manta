#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/bin/manta-statusline.ts
var manta_statusline_exports = {};
__export(manta_statusline_exports, {
  computeStatusline: () => computeStatusline,
  formatDuration: () => formatDuration,
  formatStatusline: () => formatStatusline,
  isLive: () => isLive,
  readClones: () => readClones,
  resolveRepoRoot: () => resolveRepoRoot,
  runStatusline: () => runStatusline
});
module.exports = __toCommonJS(manta_statusline_exports);

// ../../node_modules/.pnpm/tsup@8.5.1_postcss@8.5.14_tsx@4.21.0_typescript@5.9.3_yaml@2.8.4/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/bin/manta-statusline.ts
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var import_node_url = require("url");
var MARK = "\u29C9";
var STATE_ARROW = "\u25B6";
var SEP = " \xB7 ";
function formatStatusline(input) {
  const live = input.clones.filter((c) => isLive(c.state));
  if (live.length === 0) {
    return "";
  }
  const segments = [];
  segments.push(live.map((c) => `${c.clone_id}${STATE_ARROW}${c.state}`).join(" "));
  const oldest = oldestRegisteredAt(live);
  if (oldest != null) {
    const elapsedMs = Math.max(0, input.nowMs - oldest);
    segments.push(formatDuration(elapsedMs));
  }
  return `${MARK} ${segments.join(SEP)}`;
}
function isLive(state) {
  return state !== "DEAD";
}
function oldestRegisteredAt(clones) {
  let min = null;
  for (const c of clones) {
    if (typeof c.registered_at === "number" && Number.isFinite(c.registered_at)) {
      if (min == null || c.registered_at < min) {
        min = c.registered_at;
      }
    }
  }
  return min;
}
function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1e3);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m`;
  }
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${hours}h${minutes}m`;
}
function resolveRepoRoot(startDir) {
  let dir = path.resolve(startDir);
  for (; ; ) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}
function readJson(file) {
  const raw = fs.readFileSync(file, "utf8");
  return JSON.parse(raw);
}
function readClones(repoRoot) {
  try {
    const data = readJson(path.join(repoRoot, ".manta", "state", "registry.json"));
    const clones = data.clones;
    if (clones == null || typeof clones !== "object") {
      return [];
    }
    const out = [];
    for (const value of Object.values(clones)) {
      if (value == null || typeof value !== "object") {
        continue;
      }
      const rec = value;
      if (typeof rec.clone_id === "string" && typeof rec.state === "string") {
        out.push({
          clone_id: rec.clone_id,
          state: rec.state,
          ...typeof rec.registered_at === "number" ? { registered_at: rec.registered_at } : {}
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}
function computeStatusline(startDir, nowMs) {
  try {
    const repoRoot = resolveRepoRoot(startDir);
    if (repoRoot == null) {
      return "";
    }
    return formatStatusline({
      clones: readClones(repoRoot),
      nowMs
    });
  } catch {
    return "";
  }
}
function runStatusline() {
  let line = "";
  try {
    line = computeStatusline(process.cwd(), Date.now());
  } catch {
    line = "";
  }
  process.stdout.write(line);
}
var invokedDirectly = (() => {
  try {
    return process.argv[1] != null && importMetaUrl === (0, import_node_url.pathToFileURL)(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  runStatusline();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  computeStatusline,
  formatDuration,
  formatStatusline,
  isLive,
  readClones,
  resolveRepoRoot,
  runStatusline
});
