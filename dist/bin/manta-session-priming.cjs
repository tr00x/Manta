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

// src/bin/manta-session-priming.ts
var manta_session_priming_exports = {};
__export(manta_session_priming_exports, {
  HOOK_EVENT_NAME: () => HOOK_EVENT_NAME,
  PRIMING: () => PRIMING,
  buildHookOutput: () => buildHookOutput,
  runSessionPriming: () => runSessionPriming,
  serializeHookOutput: () => serializeHookOutput
});
module.exports = __toCommonJS(manta_session_priming_exports);

// ../../node_modules/.pnpm/tsup@8.5.1_postcss@8.5.14_tsx@4.21.0_typescript@5.9.3_yaml@2.8.4/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/bin/manta-session-priming.ts
var import_node_url = require("url");
var fs = __toESM(require("fs"), 1);
var PRIMING = [
  "Manta is installed here (the self-cloning Claude Code pattern). Orchestration contract for THIS agent:",
  "- For a non-trivial task (>~10 min, multi-file, or parallelizable), consider casting clones instead of working solo \u2014 load the `manta-cast-decide` skill to decide whether to cast and which mode.",
  "- To drive a cast end-to-end, follow the `manta-orchestrate` skill: launch \u2192 observe with `/manta:status` (do NOT poll the bus) \u2192 for forking-realities read the merge-review FIRST, then merge the winner \u2192 `/manta:recover`.",
  "- Run casts serially-aware (one cast at a time unless you know they are isolated). `manta doctor` checks your setup; `/manta:help` lists the commands.",
  "These skills carry the detail \u2014 load the relevant one rather than guessing. This is guidance, not a hard gate."
].join("\n");
var HOOK_EVENT_NAME = "SessionStart";
function buildHookOutput(priming = PRIMING) {
  return {
    hookSpecificOutput: {
      hookEventName: HOOK_EVENT_NAME,
      additionalContext: priming
    }
  };
}
function serializeHookOutput(priming = PRIMING) {
  return JSON.stringify(buildHookOutput(priming));
}
function runSessionPriming(write = (s) => process.stdout.write(s)) {
  try {
    write(serializeHookOutput());
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
  runSessionPriming();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  HOOK_EVENT_NAME,
  PRIMING,
  buildHookOutput,
  runSessionPriming,
  serializeHookOutput
});
