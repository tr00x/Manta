import { describe, it, expect } from 'vitest';
import { scanBundleJs } from '../../src/share/static-scanner.js';

/**
 * Task 3.1 — static malicious-pattern scanner (research §2 mitigation d).
 *
 * Phase 7b modes are `basedOn` built-ins and ship NO JS, so this scanner
 * usually finds nothing. These tests exercise every rule against synthetic JS
 * fixtures so the scanner is honest about what it catches. v1 is a regex pass
 * (defeated by obfuscation — documented as accepted, §0).
 */

function jsFile(content: string, relPath = 'skills/x/dispatch.js') {
  return [{ relPath, content }];
}

describe('scanBundleJs — block rules', () => {
  it('child_process.execSync with a non-literal first arg → block', () => {
    const r = scanBundleJs(jsFile('import cp from "child_process";\ncp.execSync(userInput);\n'));
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]!.rule).toBe('child-process-exec');
    expect(r.blocked[0]!.severity).toBe('block');
    expect(r.blocked[0]!.line).toBe(2);
  });

  it('child_process.exec with a literal arg → block (undeclared requiresChildProcess)', () => {
    const r = scanBundleJs(jsFile('exec("ls -la");\n'));
    expect(r.blocked).toHaveLength(1);
    expect(r.blocked[0]!.rule).toBe('child-process-exec');
  });

  it('reading ~/.aws/credentials → block', () => {
    const r = scanBundleJs(jsFile('const k = fs.readFileSync("~/.aws/credentials");\n'));
    expect(r.blocked.some((f) => f.rule === 'read-sensitive-home')).toBe(true);
    expect(r.blocked.find((f) => f.rule === 'read-sensitive-home')!.severity).toBe('block');
  });

  it('reading ~/.ssh / ~/.npmrc / ~/.netrc → block', () => {
    for (const target of ['~/.ssh/id_rsa', '~/.npmrc', '~/.netrc']) {
      const r = scanBundleJs(jsFile(`open("${target}");\n`));
      expect(r.blocked.some((f) => f.rule === 'read-sensitive-home')).toBe(true);
    }
  });

  it('writing to .git/ / .env / .envrc → block', () => {
    const r = scanBundleJs(jsFile('fs.writeFileSync(".env", "API_KEY=leak");\n'));
    expect(r.blocked.some((f) => f.rule === 'write-sensitive-file')).toBe(true);
  });
});

describe('scanBundleJs — warn rules', () => {
  it('eval( → warn', () => {
    const r = scanBundleJs(jsFile('const v = eval(x);\n'));
    expect(r.blocked).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.rule).toBe('eval');
    expect(r.warnings[0]!.severity).toBe('warn');
  });

  it('new Function( → warn', () => {
    const r = scanBundleJs(jsFile('const f = new Function("return 1");\n'));
    expect(r.warnings.some((w) => w.rule === 'new-function')).toBe(true);
  });

  it('child_process.spawn with a non-literal first arg → warn', () => {
    const r = scanBundleJs(jsFile('spawn(cmd, args);\n'));
    expect(r.warnings.some((w) => w.rule === 'child-process-spawn')).toBe(true);
    expect(r.blocked).toHaveLength(0);
  });

  it('child_process.spawn with a literal first arg → no finding', () => {
    const r = scanBundleJs(jsFile('spawn("git", ["status"]);\n'));
    expect(r.warnings.some((w) => w.rule === 'child-process-spawn')).toBe(false);
  });

  it('require( with a non-literal arg → warn', () => {
    const r = scanBundleJs(jsFile('const m = require(name);\n'));
    expect(r.warnings.some((w) => w.rule === 'dynamic-require')).toBe(true);
  });

  it('require( with a literal arg → no finding', () => {
    const r = scanBundleJs(jsFile('const m = require("node:fs");\n'));
    expect(r.warnings.some((w) => w.rule === 'dynamic-require')).toBe(false);
  });

  it('fetch( → warn (undeclared network)', () => {
    const r = scanBundleJs(jsFile('await fetch("https://evil.example/x");\n'));
    expect(r.warnings.some((w) => w.rule === 'network')).toBe(true);
  });

  it('http.request( → warn', () => {
    const r = scanBundleJs(jsFile('http.request(opts);\n'));
    expect(r.warnings.some((w) => w.rule === 'network')).toBe(true);
  });

  it('process.env.SECRET-style read → warn', () => {
    for (const v of ['process.env.OPENAI_API_KEY', 'process.env.MY_TOKEN', 'process.env.DB_PASSWORD', 'process.env.AWS_SECRET']) {
      const r = scanBundleJs(jsFile(`const x = ${v};\n`));
      expect(r.warnings.some((w) => w.rule === 'env-secret-read')).toBe(true);
    }
  });

  it('process.env.NODE_ENV (non-secret) → no env-secret finding', () => {
    const r = scanBundleJs(jsFile('const e = process.env.NODE_ENV;\n'));
    expect(r.warnings.some((w) => w.rule === 'env-secret-read')).toBe(false);
  });
});

describe('scanBundleJs — clean / empty / non-JS', () => {
  it('a clean JS file → no findings', () => {
    const r = scanBundleJs(jsFile('export function add(a, b) {\n  return a + b;\n}\n'));
    expect(r).toEqual({ blocked: [], warnings: [] });
  });

  it('an empty file list (Phase 7b typical) → no findings', () => {
    expect(scanBundleJs([])).toEqual({ blocked: [], warnings: [] });
  });

  it('non-.js files are skipped', () => {
    const r = scanBundleJs([{ relPath: 'README.md', content: 'eval(x); execSync(y);' }]);
    expect(r).toEqual({ blocked: [], warnings: [] });
  });

  it('.mjs and .cjs files are scanned', () => {
    const r = scanBundleJs([{ relPath: 'a.mjs', content: 'eval(x);' }, { relPath: 'b.cjs', content: 'eval(y);' }]);
    expect(r.warnings).toHaveLength(2);
  });
});

describe('scanBundleJs — snippet hygiene', () => {
  it('snippet is the matched line, truncated, never the full file', () => {
    const longTail = 'x'.repeat(500);
    const r = scanBundleJs(jsFile(`eval(payload); // ${longTail}\n`));
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]!.snippet.length).toBeLessThanOrEqual(160);
    expect(r.warnings[0]!.snippet).not.toContain(longTail);
  });

  it('reports the correct file relPath and line number across multiple files', () => {
    const r = scanBundleJs([
      { relPath: 'a.js', content: 'ok();\neval(x);\n' },
      { relPath: 'b.js', content: 'execSync(cmd);\n' },
    ]);
    const evalFinding = r.warnings.find((w) => w.rule === 'eval')!;
    expect(evalFinding.file).toBe('a.js');
    expect(evalFinding.line).toBe(2);
    const execFinding = r.blocked.find((b) => b.rule === 'child-process-exec')!;
    expect(execFinding.file).toBe('b.js');
    expect(execFinding.line).toBe(1);
  });
});
