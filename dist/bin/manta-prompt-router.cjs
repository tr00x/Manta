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

// src/bin/manta-prompt-router.ts
var manta_prompt_router_exports = {};
__export(manta_prompt_router_exports, {
  HOOK_EVENT_NAME: () => HOOK_EVENT_NAME,
  buildAdditionalContext: () => buildAdditionalContext,
  buildHookOutput: () => buildHookOutput,
  isMantaIntent: () => isMantaIntent,
  readOrchestrateSkill: () => readOrchestrateSkill,
  runPromptRouter: () => runPromptRouter,
  stripFrontmatter: () => stripFrontmatter
});
module.exports = __toCommonJS(manta_prompt_router_exports);

// ../../node_modules/.pnpm/tsup@8.5.1_postcss@8.5.14_tsx@4.21.0_typescript@5.9.3_yaml@2.8.4/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/bin/manta-prompt-router.ts
var import_node_url = require("url");
var fs = __toESM(require("fs"), 1);
var path = __toESM(require("path"), 1);
var HOOK_EVENT_NAME = "UserPromptSubmit";
function isMantaIntent(prompt) {
  if (typeof prompt !== "string" || prompt.length === 0) return false;
  return /\bmanta\b/i.test(prompt) || /\/manta:/i.test(prompt) || /\bmanta_[a-z]/i.test(prompt) || /\b(recon-swarm|forking-realities|bug-hunt|refactor-wave|pair-programming|test-storm|documentation-chase)\b/i.test(
    prompt
  );
}
function stripFrontmatter(md) {
  const m = /^---\n[\s\S]*?\n---\n?/.exec(md);
  return m ? md.slice(m[0].length).trimStart() : md;
}
function readOrchestrateSkill(scriptDir) {
  try {
    const p = path.resolve(scriptDir, "..", "..", "skills", "manta-orchestrate", "SKILL.md");
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}
function buildAdditionalContext(skillBody) {
  return [
    "This prompt involves Manta. The orchestration console (`manta-orchestrate` skill) is injected below so it is in context now \u2014 use its mode router and command recipes; load `manta-cast-decide` before a non-trivial cast. (Auto-injected by the Manta UserPromptSubmit hook.)",
    "",
    "--- manta-orchestrate ---",
    skillBody.trim()
  ].join("\n");
}
function buildHookOutput(additionalContext) {
  return { hookSpecificOutput: { hookEventName: HOOK_EVENT_NAME, additionalContext } };
}
function runPromptRouter(scriptDir, readStdin = () => fs.readFileSync(0, "utf8"), write = (s) => process.stdout.write(s)) {
  try {
    const raw = readStdin();
    const prompt = JSON.parse(raw).prompt ?? "";
    if (!isMantaIntent(prompt)) return;
    const skill = readOrchestrateSkill(scriptDir);
    if (skill === null) return;
    write(JSON.stringify(buildHookOutput(buildAdditionalContext(stripFrontmatter(skill)))));
  } catch {
  }
}
var invokedDirectly = (() => {
  try {
    return process.argv[1] != null && importMetaUrl === (0, import_node_url.pathToFileURL)(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  runPromptRouter(path.dirname(fileURLToPath_argv()));
}
function fileURLToPath_argv() {
  return process.argv[1] ?? process.cwd();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOOK_EVENT_NAME,
  buildAdditionalContext,
  buildHookOutput,
  isMantaIntent,
  readOrchestrateSkill,
  runPromptRouter,
  stripFrontmatter
});
