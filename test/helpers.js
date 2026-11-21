'use strict';
// Test helpers: run the tool on a throw-away copy of this project.
//
// sync.js and convert-pdf.js use their own folder as the project root, so a copy of the tool files
// plus content in a temp dir behaves exactly like a course project (and like the platform's worker).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TOOL = path.resolve(__dirname, '..');

// What a course project contains (see README "Updating a course project"), minus secrets and state.
const PROJECT_ENTRIES = [
  'sync.js', 'convert-pdf.js', 'template.html', 'package.json',
  'course.config.json', 'pdf.config.json', 'lib', 'css', 'assets', 'content', 'review',
];

/**
 * Copy the tool into a fresh temp dir.
 * o.files: { 'content/x.md': 'text' | null } added, replaced or (null) removed after copying.
 * o.config: function (config) -> config, applied to course.config.json.
 * o.withContent: false starts from an empty content/ (default true: the example content).
 * o.env: extra environment for every run.
 */
function makeProject(o = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'course-sync-test-'));
  for (const entry of PROJECT_ENTRIES) {
    if (o.withContent === false && (entry === 'content' || entry === 'review')) continue;
    fs.cpSync(path.join(TOOL, entry), path.join(dir, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(dir, 'content'), { recursive: true });
  fs.symlinkSync(path.join(TOOL, 'node_modules'), path.join(dir, 'node_modules'), 'dir');

  for (const [rel, text] of Object.entries(o.files || {})) {
    const abs = path.join(dir, rel);
    if (text === null) { fs.rmSync(abs, { recursive: true, force: true }); continue; }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  if (o.config) {
    const file = path.join(dir, 'course.config.json');
    const config = o.config(JSON.parse(fs.readFileSync(file, 'utf8')));
    fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
  }

  // Never let a developer's environment (CANVAS_TOKEN) or .env leak into a test run.
  const baseEnv = { ...process.env, CANVAS_TOKEN: '', ...(o.env || {}) };
  if (!baseEnv.CANVAS_TOKEN) delete baseEnv.CANVAS_TOKEN;

  return {
    dir,
    /** Run a script of the project: { status, stdout, stderr }. */
    run(args = [], script = 'sync.js', env = {}) {
      const r = spawnSync(process.execPath, [script, ...args], {
        cwd: dir, encoding: 'utf8', env: { ...baseEnv, ...env }, timeout: 120000,
      });
      if (r.error) throw r.error;
      return { status: r.status, stdout: r.stdout, stderr: r.stderr };
    },
    read(rel) { return fs.readFileSync(path.join(dir, rel), 'utf8'); },
    exists(rel) { return fs.existsSync(path.join(dir, rel)); },
    write(rel, text) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); },
    /** Files under rel, relative to it, sorted, forward slashes. */
    list(rel) { return listFiles(path.join(dir, rel)); },
    cleanup() { fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

function listFiles(root) {
  if (!fs.existsSync(root)) return [];
  const out = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name);
      if (e.isDirectory()) walk(abs);
      else out.push(path.relative(root, abs).split(path.sep).join('/'));
    }
  };
  walk(root);
  return out.sort();
}

/** Parse --json stdout into events; throws on a line that is not JSON. */
function parseEvents(stdout) {
  return stdout.split('\n').filter((l) => l.trim()).map((l) => {
    try { return JSON.parse(l); } catch { throw new Error(`not a JSON line: ${l}`); }
  });
}

module.exports = { TOOL, makeProject, listFiles, parseEvents };
