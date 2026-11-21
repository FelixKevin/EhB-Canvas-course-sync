#!/usr/bin/env node
'use strict';
// Regenerates test/golden from `node sync.js --dry-run` on the example content.
// Only run this for a deliberate change to the rendered output, and review the git diff.

const fs = require('fs');
const path = require('path');
const { makeProject } = require('../test/helpers');

const GOLDEN = path.join(__dirname, '..', 'test', 'golden');

const project = makeProject();
try {
  const r = project.run(['--dry-run']);
  if (r.status !== 0) throw new Error(`dry run failed (${r.status}):\n${r.stderr}`);
  fs.rmSync(GOLDEN, { recursive: true, force: true });
  for (const rel of project.list('out')) {
    const dest = path.join(GOLDEN, 'out', rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(project.dir, 'out', rel), dest);
  }
  fs.writeFileSync(path.join(GOLDEN, 'log.stdout.txt'), r.stdout);
  fs.writeFileSync(path.join(GOLDEN, 'log.stderr.txt'), r.stderr);
  console.log(`Wrote ${project.list('out').length} file(s) and the log to test/golden`);
} finally {
  project.cleanup();
}
