'use strict';
// The rendered output of the example content must not change by accident: every file in
// test/golden (dry-run HTML, quiz payloads and the human log) must stay byte-identical.
// Regenerate deliberately with `node scripts/update-golden.js` and review the diff.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeProject, listFiles } = require('./helpers');

const GOLDEN = path.join(__dirname, 'golden');

test('dry run of the example content matches the golden snapshots', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());

  const r = project.run(['--dry-run']);
  assert.strictEqual(r.status, 0, r.stderr);

  const expected = listFiles(path.join(GOLDEN, 'out'));
  assert.ok(expected.length > 0, 'golden snapshots are missing: run scripts/update-golden.js');
  assert.deepStrictEqual(project.list('out'), expected, 'set of output files differs');
  for (const rel of expected) {
    const want = fs.readFileSync(path.join(GOLDEN, 'out', rel), 'utf8');
    assert.ok(project.read(path.join('out', rel)) === want, `out/${rel} differs from the golden snapshot`);
  }

  assert.strictEqual(r.stdout, fs.readFileSync(path.join(GOLDEN, 'log.stdout.txt'), 'utf8'), 'human log (stdout) changed');
  assert.strictEqual(r.stderr, fs.readFileSync(path.join(GOLDEN, 'log.stderr.txt'), 'utf8'), 'human log (stderr) changed');
});
