'use strict';
// --json: one JSON object per line on stdout, warnings with stable codes and line numbers,
// a final "result" on success and an "error" (exit code 1) on failure.

const test = require('node:test');
const assert = require('node:assert');
const { makeProject, parseEvents } = require('./helpers');

// Line numbers matter: they are asserted below.
const PROBLEMS = [
  '---', //                                   1
  'module: 1', //                             2
  'published: true', //                       3
  '---', //                                   4
  '', //                                      5
  '# Module 1', //                            6
  '', //                                      7
  '## 1.1 Start', //                          8
  '', //                                      9
  'Tekst die nog [CONTROLEREN] moet.', //    10
  '', //                                     11
  '![](images/bestaat-niet.png)', //         12
  '', //                                     13
  'Zie [elders](./bestaat-niet.md#1_1).', // 14
  '', //                                     15
  '### Test jezelf 1.1 – Kapot', //          16
  '', //                                     17
  '```text', //                              18
  'Sectie: 1.1',
  'Type: meerkeuze',
  'Vraag: Welke?',
  'Opties:',
  'A. een',
  'B. twee',
  'Juist: E',
  '```',
  '',
].join('\n');

test('dry run of the example content: only JSON lines, ending in result', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  const r = project.run(['--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(r.stderr, '', 'nothing on stderr in JSON mode');
  const events = parseEvents(r.stdout);
  const last = events[events.length - 1];
  assert.strictEqual(last.type, 'result');
  assert.strictEqual(last.dryRun, true);
  assert.strictEqual(last.pages, 5);
  assert.strictEqual(last.written.length, 5);
  assert.strictEqual(events.filter((e) => e.type === 'result').length, 1);
  for (const e of events) {
    assert.ok(['progress', 'warning', 'page', 'quiz', 'file', 'orphan', 'result'].includes(e.type), `unexpected type ${e.type}`);
    if (e.type === 'warning') {
      assert.deepStrictEqual(Object.keys(e).sort(), ['code', 'file', 'line', 'message', 'type']);
      assert.match(e.code, /^[a-z]+(-[a-z]+)*$/);
    }
  }
  assert.deepStrictEqual(events.find((e) => e.code === 'marker-allowed'), {
    type: 'warning', file: 'content/module-2-concept.md', line: 13, code: 'marker-allowed',
    message: 'marker: Een DHCP-lease duurt standaard 24 uur. [CONTROLEREN] (page unpublished, allowed)',
  });
});

test('warnings carry file, line and a stable code', (t) => {
  const project = makeProject({ withContent: false, files: { 'content/module-1.md': PROBLEMS } });
  t.after(() => project.cleanup());
  const r = project.run(['--dry-run', '--json']);
  assert.strictEqual(r.status, 0, r.stderr);
  const warnings = parseEvents(r.stdout).filter((e) => e.type === 'warning');
  const by = (code) => warnings.filter((w) => w.code === code);

  assert.deepStrictEqual(by('marker-blocking').map((w) => [w.file, w.line]), [['content/module-1.md', 10]]);
  assert.deepStrictEqual(by('image-no-alt').map((w) => [w.file, w.line]), [['content/module-1.md', 12]]);
  assert.deepStrictEqual(by('image-missing').map((w) => [w.file, w.line, w.message]),
    [['content/module-1.md', 12, 'image not found: images/bestaat-niet.png']]);
  assert.deepStrictEqual(by('link-unknown-page').map((w) => [w.file, w.message]),
    [['content/module-1.md', 'link to unknown page bestaat-niet.md']]);
  assert.ok(by('quiz-invalid').length >= 1);
  assert.ok(by('quiz-invalid').every((w) => w.file === 'content/module-1.md' && w.line === 16));
});

test('a blocked publish ends with an error event and exit code 1', (t) => {
  const project = makeProject({ withContent: false, files: { 'content/module-1.md': PROBLEMS } });
  t.after(() => project.cleanup());
  const r = project.run(['--json'], 'sync.js', { CANVAS_TOKEN: 'never-used' });
  assert.strictEqual(r.status, 1);
  const events = parseEvents(r.stdout);
  const last = events[events.length - 1];
  assert.strictEqual(last.type, 'error');
  assert.strictEqual(last.code, 'blocked-images');
  assert.match(last.message, /^Not publishing: 1 image\/file problem/);
  assert.ok(!events.some((e) => e.type === 'result'));
});

test('usage errors have the code "usage"', (t) => {
  const project = makeProject();
  t.after(() => project.cleanup());
  for (const args of [['--asset-base-url', 'https://x'], ['--dry-run', '--only', 'bestaat-niet.md'], ['--dry-run', '--only']]) {
    const r = project.run([...args, '--json']);
    assert.strictEqual(r.status, 1, args.join(' '));
    const events = parseEvents(r.stdout);
    const e = events[events.length - 1];
    assert.strictEqual(e.type, 'error');
    assert.strictEqual(e.code, 'usage', args.join(' '));
  }
});

test('without --json the human log is unchanged in shape', (t) => {
  const project = makeProject({ withContent: false, files: { 'content/module-1.md': PROBLEMS } });
  t.after(() => project.cleanup());
  const r = project.run(['--dry-run']);
  assert.strictEqual(r.status, 0);
  assert.match(r.stderr, /^ {2}! marker module-1\.md:10: Tekst die nog \[CONTROLEREN\] moet\.$/m);
  assert.match(r.stderr, /^ {2}! module-1\.md: image without alt text: images\/bestaat-niet\.png$/m);
  assert.match(r.stdout, /^Dry run: 1 pages written to \.\/out/m);
  assert.doesNotMatch(r.stdout, /^\{/m);
});
