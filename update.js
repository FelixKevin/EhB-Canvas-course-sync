#!/usr/bin/env node
'use strict';
// Updates the tool files of this project from the upstream canvas-course-sync repository.
//
//   node update.js                 update from "courseSync.updateSource" in package.json
//   node update.js --dry-run       show what would change, write nothing
//   node update.js --from <git url | local folder>   other source
//   node update.js --ref <branch | tag>               other branch or tag (git sources only)
//   node update.js --force         also when tool files have uncommitted changes
//   node update.js --no-install    skip "npm ci" after package-lock.json changed
//
// Never written: content/, review/, .env, canvas-map.json, out/, theme-upload/.
// course.config.json and pdf.config.json only get keys they are missing; existing values stay.
// Files that exist only in this project (an extra logo in assets/) are kept, never deleted.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ROOT = __dirname;

// Replaced from upstream (files, or every file inside these folders).
const MANAGED = [
  'sync.js', 'convert-pdf.js', 'build-theme.js', 'update.js', 'template.html',
  'package.json', 'package-lock.json', 'README.md', '.gitignore',
  'lib', 'css', 'theme', 'assets',
];
// Only missing keys are added.
const MERGED = ['course.config.json', 'pdf.config.json'];
// Never written, whatever happens.
const PROTECTED = ['content', 'review', '.env', 'canvas-map.json', 'out', 'theme-upload', 'node_modules', '.git'];
const SKIP_FILES = new Set(['.DS_Store', 'Thumbs.db']);

// ---- arguments ----------------------------------------------------------------
const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = flag('--dry-run');
const FORCE = flag('--force');
const INSTALL = !flag('--no-install');
const REF = opt('--ref');

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const fail = (msg) => { console.error(`✗ ${msg}`); process.exit(1); };

// Every write goes through here: only managed or merged paths, never a protected one.
function assertWritable(relPath) {
  const top = relPath.split('/')[0];
  if (PROTECTED.includes(top)) throw new Error(`refusing to write protected path ${relPath}`);
  if (!MANAGED.includes(top) && !MERGED.includes(relPath)) throw new Error(`refusing to write unmanaged path ${relPath}`);
}

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_FILES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile()) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

// Adds keys of src that target lacks (recursing into plain objects). Returns the added key paths.
function addMissing(target, src, prefix = '') {
  const added = [];
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
  for (const [k, v] of Object.entries(src)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (!(k in target)) { target[k] = v; added.push(key); }
    else if (isObj(target[k]) && isObj(v)) added.push(...addMissing(target[k], v, key));
  }
  return added;
}

// ---- 1. source ------------------------------------------------------------------
let pkg = {};
try { pkg = readJson(path.join(ROOT, 'package.json')); } catch { /* first run without package.json */ }
const from = opt('--from') || (pkg.courseSync && pkg.courseSync.updateSource);
if (!from) fail('no source: pass --from <git url | folder> or set "courseSync.updateSource" in package.json');

let SRC, tmp = null, version = '';
const local = !/^(https?:|git@|ssh:)/.test(from) && fs.existsSync(from);
let isRepo = false;
try { isRepo = git(['rev-parse', '--is-inside-work-tree'], ROOT) === 'true'; } catch { /* not a git repo */ }

// In the upstream repository itself an "update" would overwrite unpushed work with the older GitHub copy.
const norm = (u) => String(u).trim().replace(/\.git$/, '').replace(/\/$/, '').toLowerCase();
if (isRepo && !local) {
  let remotes = '';
  try { remotes = git(['remote', '-v'], ROOT); } catch { /* no remotes */ }
  if (remotes.split('\n').some((l) => norm(l.split(/\s+/)[1] || '') === norm(from))) {
    fail('this project is the upstream repository itself (its git remote is the update source): use git pull instead');
  }
}
if (local) {
  SRC = path.resolve(from);
  if (REF) console.warn('! --ref is ignored for a local folder: its current files are used');
} else {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'course-sync-update-'));
  SRC = path.join(tmp, 'src');
  console.log(`Downloading ${from}${REF ? ` (${REF})` : ''} ...`);
  try {
    git(['clone', '--quiet', '--depth', '1', ...(REF ? ['--branch', REF] : []), from, SRC]);
  } catch (e) {
    fail(`git clone failed: ${(e.stderr || e.message).toString().trim()}`);
  }
}
const cleanup = () => { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); };
process.on('exit', cleanup);

if (fs.realpathSync(SRC) === fs.realpathSync(ROOT)) fail('the source is this project itself: nothing to update');
if (!fs.existsSync(path.join(SRC, 'sync.js')) || !fs.existsSync(path.join(SRC, 'lib', 'render.js'))) {
  fail(`${from} does not look like canvas-course-sync (no sync.js or lib/render.js)`);
}
try { version = git(['rev-parse', '--short', 'HEAD'], SRC); } catch { version = ''; }

// ---- 2. uncommitted changes to tool files would be overwritten ----------------------
if (isRepo && !DRY && !FORCE) {
  const dirty = git(['status', '--porcelain', '--', ...MANAGED, ...MERGED], ROOT);
  if (dirty) {
    fail('these tool files have uncommitted changes and could be overwritten:\n'
      + dirty.split('\n').map((l) => `    ${l}`).join('\n')
      + '\n  Commit or discard them first, or run with --force.');
  }
}

// ---- 3. compare ------------------------------------------------------------------
const changes = { added: [], updated: [], same: 0, projectOnly: [] };
const plan = []; // [srcFile, destFile]
for (const entry of MANAGED) {
  const s = path.join(SRC, entry);
  const d = path.join(ROOT, entry);
  if (!fs.existsSync(s)) continue; // not (or no longer) upstream: leave the project's copy alone
  const files = fs.statSync(s).isDirectory() ? walk(s).map((f) => `${entry}/${f}`) : [entry];
  for (const f of files) {
    const sf = path.join(SRC, f), df = path.join(ROOT, f);
    if (!fs.existsSync(df)) { changes.added.push(f); plan.push([sf, df]); }
    else if (sha(sf) !== sha(df)) { changes.updated.push(f); plan.push([sf, df]); }
    else changes.same++;
  }
  if (fs.existsSync(d) && fs.statSync(d).isDirectory() && fs.statSync(s).isDirectory()) {
    const upstream = new Set(walk(s));
    for (const f of walk(d)) if (!upstream.has(f)) changes.projectOnly.push(`${entry}/${f}`);
  }
}

const configs = [];
for (const f of MERGED) {
  const sf = path.join(SRC, f), df = path.join(ROOT, f);
  if (!fs.existsSync(sf)) continue;
  if (!fs.existsSync(df)) { configs.push({ f, missing: true }); continue; }
  let mine;
  try { mine = readJson(df); } catch (e) { fail(`${f} is not valid JSON: ${e.message}`); }
  const added = addMissing(mine, readJson(sf));
  if (added.length) configs.push({ f, added, json: mine });
}

// ---- 4. apply --------------------------------------------------------------------
for (const [sf, df] of plan) {
  assertWritable(rel(df));
  if (DRY) continue;
  fs.mkdirSync(path.dirname(df), { recursive: true });
  fs.copyFileSync(sf, df);
}
for (const c of configs) {
  if (c.missing) continue;
  assertWritable(c.f);
  if (!DRY) fs.writeFileSync(path.join(ROOT, c.f), JSON.stringify(c.json, null, 2) + '\n');
}
if (!DRY && version) fs.writeFileSync(path.join(ROOT, '.course-sync-version'), `${version} ${from}\n`);

// ---- 5. report -------------------------------------------------------------------
const list = (title, items) => { if (items.length) console.log(`\n${title}\n${items.map((i) => `  ${i}`).join('\n')}`); };
console.log(`\n${DRY ? 'Dry run: would update' : 'Updated'} from ${from}${version ? ` @ ${version}` : ''}`);
list(DRY ? 'Would be added:' : 'Added:', changes.added);
list(DRY ? 'Would be replaced:' : 'Replaced:', changes.updated);
for (const c of configs) {
  if (c.missing) console.log(`\n! ${c.f} is missing: copy it from the upstream repository and fill it in for this course`);
  else list(`${c.f}: ${DRY ? 'would add' : 'added'} missing keys (your values are kept):`, c.added);
}
list('Only in this project, kept:', changes.projectOnly);
console.log(`\n${changes.same} file(s) already up to date. content/ and review/ were not touched.`);

const touched = [...changes.added, ...changes.updated];
if (!touched.length && !configs.some((c) => !c.missing)) { console.log('Nothing to do.'); process.exit(0); }

// package.json alone (scripts, updateSource) needs no install; dependencies or the lock file do.
const deps = (p) => { try { const j = readJson(p); return JSON.stringify([j.dependencies, j.devDependencies]); } catch { return ''; } };
const lockChanged = touched.includes('package-lock.json')
  || (touched.includes('package.json') && deps(path.join(SRC, 'package.json')) !== JSON.stringify([pkg.dependencies, pkg.devDependencies]));
if (!DRY && INSTALL && (lockChanged || !fs.existsSync(path.join(ROOT, 'node_modules')))) {
  console.log('\nInstalling dependencies (npm ci) ...');
  try {
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--no-audit', '--no-fund'],
      { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
  } catch { console.warn('! npm ci failed: run it yourself before syncing'); }
} else if (lockChanged) {
  console.log('\nDependencies changed: run "npm ci" before syncing.');
}

const hints = [];
if (touched.some((f) => /^(css|lib|template\.html|sync\.js)/.test(f)) || configs.length) {
  hints.push('Run "node sync.js --dry-run" and check out/: page HTML may have changed, so the next sync can republish every page.');
}
if (touched.some((f) => f.startsWith('theme/'))) hints.push('theme/ changed: run "npm run theme" and upload theme-upload/ again in the Theme Editor.');
if (touched.includes('README.md')) hints.push('README.md changed: see what is new there.');
if (hints.length) console.log(`\nNext:\n${hints.map((h) => `  - ${h}`).join('\n')}`);
if (isRepo && !DRY) {
  // Only the paths this script may write, so uncommitted course text is never part of the undo.
  const restore = [...MANAGED, ...MERGED].filter((p) => fs.existsSync(path.join(ROOT, p)));
  console.log('\nReview with "git diff", then commit.'
    + `\nTo undo: git restore -- ${restore.join(' ')}`
    + (changes.added.length ? '\n         and delete the added files listed above.' : ''));
}
