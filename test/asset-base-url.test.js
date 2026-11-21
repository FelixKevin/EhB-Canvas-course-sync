'use strict';
// --dry-run --asset-base-url <url>: local images, download links and block logos point at
// <url>/<project-relative path>; everything else in the HTML stays as in the plain dry run.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { makeProject } = require('./helpers');
const { assetUrl } = require('../lib/images');

const GOLDEN = path.join(__dirname, 'golden', 'out');
const BASE = 'https://studio.test/preview/42/assets?expires=99&signature=abc';

test('assetUrl keeps the query of the base after the inserted path', () => {
  assert.strictEqual(assetUrl(BASE, 'content/images/lan-wan.png'),
    'https://studio.test/preview/42/assets/content/images/lan-wan.png?expires=99&signature=abc');
  assert.strictEqual(assetUrl('https://x.test/a/', 'content/files/module 1/x y.zip'), 'https://x.test/a/content/files/module%201/x%20y.zip');
  assert.strictEqual(assetUrl('/relative#frag', 'assets/icons/quiz.svg'), '/relative/assets/icons/quiz.svg#frag');
});

test('images, downloads and logos use the base URL; the rest is unchanged', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const r = project.run(['--dry-run', '--asset-base-url', BASE]);
  assert.strictEqual(r.status, 0, r.stderr);

  const at = (key) => assetUrl(BASE, key).replace(/&/g, '&amp;');
  const m1 = project.read('out/module-1.html');
  assert.ok(m1.includes(`src="${at('content/images/lan-wan.png')}"`), 'Markdown image');
  assert.ok(m1.includes(`src="${at('assets/icons/code.svg')}"`), 'block logo');
  assert.ok(m1.includes(`src="${at('assets/icons/quiz.svg')}"`), 'quiz bar logo');
  const ex = project.read('out/module-1-oefeningen.html');
  assert.ok(ex.includes(`href="${at('content/files/module-1/pingtabel.csv')}"`), 'download link');

  // Replacing the new URLs by the old relative ones gives the golden output back, byte for byte.
  for (const html of fs.readdirSync(GOLDEN).filter((f) => f.endsWith('.html'))) {
    const got = project.read(`out/${html}`).replace(/"https:\/\/studio\.test\/preview\/42\/assets\/([^"?]+)\?expires=99&amp;signature=abc"/g, '"../$1"');
    assert.ok(got === fs.readFileSync(path.join(GOLDEN, html), 'utf8'), `out/${html} differs beyond the asset URLs`);
  }
});

test('without --asset-base-url a dry run keeps the local paths', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  assert.strictEqual(project.run(['--dry-run', '--only', 'module-2.md']).status, 0);
  assert.ok(project.read('out/module-2.html').includes('src="../content/images/lan-wan.png"'));
});
