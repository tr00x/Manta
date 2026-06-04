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

// src/bin/manta-skill-gate.ts
var manta_skill_gate_exports = {};
__export(manta_skill_gate_exports, {
  HOOK_EVENT_NAME: () => HOOK_EVENT_NAME,
  REQUIRED_SKILLS: () => REQUIRED_SKILLS,
  buildDeny: () => buildDeny,
  decide: () => decide,
  isCastAction: () => isCastAction,
  readOrchestrateSkill: () => readOrchestrateSkill,
  runSkillGate: () => runSkillGate,
  sentinelPath: () => sentinelPath
});
module.exports = __toCommonJS(manta_skill_gate_exports);

// ../../node_modules/.pnpm/tsup@8.5.1_postcss@8.5.14_tsx@4.21.0_typescript@5.9.3_yaml@2.8.4/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/bin/manta-skill-gate.ts
var import_node_url = require("url");
var fs = __toESM(require("fs"), 1);
var os = __toESM(require("os"), 1);
var path = __toESM(require("path"), 1);
var HOOK_EVENT_NAME = "PreToolUse";
var REQUIRED_SKILLS = ["manta-orchestrate", "manta-cast-decide"];
function isCastAction(p) {
  const t = p.tool_name ?? "";
  if (/manta_cast$/i.test(t) || t === "mcp__manta-bus__manta_cast") return true;
  if (t === "Bash") {
    const cmd = p.tool_input?.command ?? "";
    return /\bmanta(?:\.cjs)?\s+cast\b/i.test(cmd);
  }
  return false;
}
function sentinelPath(sessionId, tmp = os.tmpdir()) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "nosession";
  return path.join(tmp, `manta-skill-loaded-${safe}`);
}
function readOrchestrateSkill(scriptDir) {
  try {
    return fs.readFileSync(
      path.resolve(scriptDir, "..", "..", "skills", "manta-orchestrate", "SKILL.md"),
      "utf8"
    );
  } catch {
    return null;
  }
}
function buildDeny(skillBody) {
  const reason = "Manta requires its orchestration skill before a cast. Load the `manta-cast-decide` skill (decide whether/which mode to cast) and `manta-orchestrate` skill (the cast playbook) via the Skill tool, THEN re-run the cast. This gate clears for the rest of the session once a manta-* skill is loaded.";
  const out = {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
  if (skillBody) out.hookSpecificOutput.additionalContext = `--- manta-orchestrate ---
${skillBody.trim()}`;
  return out;
}
function decide(payload, scriptDir, sentinelExists) {
  if (!isCastAction(payload)) return null;
  const session = payload.session_id ?? "";
  if (sentinelExists(session)) return null;
  return buildDeny(readOrchestrateSkill(scriptDir));
}
function runSkillGate(scriptDir, readStdin = () => fs.readFileSync(0, "utf8"), write = (s) => process.stdout.write(s), sentinelExists = (s) => {
  try {
    return fs.existsSync(sentinelPath(s));
  } catch {
    return false;
  }
}) {
  try {
    const payload = JSON.parse(readStdin());
    const out = decide(payload, scriptDir, sentinelExists);
    if (out !== null) write(JSON.stringify(out));
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
  runSkillGate(path.dirname(process.argv[1] ?? process.cwd()));
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOOK_EVENT_NAME,
  REQUIRED_SKILLS,
  buildDeny,
  decide,
  isCastAction,
  readOrchestrateSkill,
  runSkillGate,
  sentinelPath
});
