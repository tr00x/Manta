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

// src/bin/manta-skill-mark.ts
var manta_skill_mark_exports = {};
__export(manta_skill_mark_exports, {
  isMantaSkillLoad: () => isMantaSkillLoad,
  runSkillMark: () => runSkillMark,
  sentinelPath: () => sentinelPath
});
module.exports = __toCommonJS(manta_skill_mark_exports);

// ../../node_modules/.pnpm/tsup@8.5.1_postcss@8.5.14_tsx@4.21.0_typescript@5.9.3_yaml@2.8.4/node_modules/tsup/assets/cjs_shims.js
var getImportMetaUrl = () => typeof document === "undefined" ? new URL(`file:${__filename}`).href : document.currentScript && document.currentScript.tagName.toUpperCase() === "SCRIPT" ? document.currentScript.src : new URL("main.js", document.baseURI).href;
var importMetaUrl = /* @__PURE__ */ getImportMetaUrl();

// src/bin/manta-skill-mark.ts
var import_node_url = require("url");
var fs = __toESM(require("fs"), 1);
var os = __toESM(require("os"), 1);
var path = __toESM(require("path"), 1);
function isMantaSkillLoad(p) {
  if ((p.tool_name ?? "") !== "Skill") return false;
  const skill = p.tool_input?.skill ?? "";
  return /(^|:)manta-[a-z-]+$/i.test(skill) || /^manta-/i.test(skill);
}
function sentinelPath(sessionId, tmp = os.tmpdir()) {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_") || "nosession";
  return path.join(tmp, `manta-skill-loaded-${safe}`);
}
function runSkillMark(readStdin = () => fs.readFileSync(0, "utf8"), writeSentinel = (p) => fs.writeFileSync(p, "loaded\n")) {
  try {
    const payload = JSON.parse(readStdin());
    if (!isMantaSkillLoad(payload)) return;
    writeSentinel(sentinelPath(payload.session_id ?? ""));
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
  runSkillMark();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isMantaSkillLoad,
  runSkillMark,
  sentinelPath
});
