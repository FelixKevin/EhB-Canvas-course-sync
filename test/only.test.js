'use strict';
// --dry-run --only <file>: renders and writes only that page, byte-identical to the full dry run
// (the overview on it still lists every page).

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeProject, listFiles, parseEvents } = require('./helpers');

const GOLDEN = path.join(__dirname, 'golden', 'out');
const pages = listFiles(GOLDEN).filter((f) => f.endsWith('.html'));

test('every example page alone equals its page in the full dry run', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  for (const html of pages) {
    fs.rmSync(path.join(project.dir, 'out'), { recursive: true, force: true });
    const md = html.replace(/\.html$/, '.md');
    const r = project.run(['--dry-run', '--only', md]);
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(project.list('out'), [html], `only out/${html} is written`);
    assert.ok(project.read(`out/${html}`) === fs.readFileSync(path.join(GOLDEN, html), 'utf8'), `out/${html} differs`);
    assert.match(r.stdout, new RegExp(`^Dry run: out/${html.replace('.', '\\.')} written \\(only ${md.replace('.', '\\.')}; the overview lists all 5 pages\\)\\.$`, 'm'));
  }
});

test('--only accepts the project path and reports it in the result', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const r = project.run(['--dry-run', '--only', 'content/module-2.md', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const result = parseEvents(r.stdout).pop();
  assert.strictEqual(result.only, 'content/module-2.md');
  assert.deepStrictEqual(result.written, ['out/module-2.html']);
  assert.deepStrictEqual(project.list('out'), ['module-2.html']);
});
