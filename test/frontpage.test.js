'use strict';
// home: true -> the course front page (PUT pages/:url with wiki_page[front_page]=true), against a fake Canvas.

const test = require('node:test');
const assert = require('node:assert');
const { makeProject, parseEvents } = require('./helpers');
const { startFakeCanvas } = require('./fake-canvas');

const intro = (fm) => `---\n${fm}\n---\n\n# Introductie\n\n## Je docenten\n\nTekst.\n`;
const module1 = (fm = 'module: 1\npublished: true') => `---\n${fm}\n---\n\n# Module 1\n\n## 1.1 Start\n\nTekst.\n`;

// A project on the fake Canvas, without block logos (no file uploads needed).
async function setup(t, files) {
  const canvas = await startFakeCanvas();
  const project = makeProject({
    withContent: false,
    files: { assets: null, ...files },
    config: (c) => ({ ...c, baseUrl: canvas.baseUrl, courseId: canvas.courseId, blocks: {}, extraTocGroups: [] }),
    env: { CANVAS_TOKEN: 'test-token' },
  });
  t.after(async () => { project.cleanup(); await canvas.close(); });
  const publish = async (...args) => {
    const r = await project.runAsync(['--json', ...args]);
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
    return parseEvents(r.stdout);
  };
  return { canvas, project, publish };
}

const resultOf = (events) => events[events.length - 1];

test('the home page becomes the front page once, again with --force', async (t) => {
  const { canvas, project, publish } = await setup(t, {
    'content/intro.md': intro('published: true\ntoc: false\nhome: true'),
    'content/module-1.md': module1(),
  });

  let events = await publish();
  assert.strictEqual(resultOf(events).type, 'result');
  assert.deepStrictEqual(resultOf(events).frontPage, {
    file: 'content/intro.md', url: `${canvas.baseUrl}/courses/1/pages/introductie`, action: 'set',
  });
  assert.deepStrictEqual(canvas.frontPageRequests().map((r) => r.path), ['/api/v1/courses/1/pages/introductie']);
  assert.strictEqual(canvas.requests.every((r) => r.auth === 'Bearer test-token'), true);
  assert.ok(canvas.pages.find((p) => p.url === 'introductie').front_page);
  const map = JSON.parse(project.read('canvas-map.json'));
  assert.deepStrictEqual(map._frontPage, { file: 'intro.md', page_id: map['intro.md'].page_id, url: 'introductie' });

  canvas.reset();
  events = await publish();
  assert.strictEqual(canvas.frontPageRequests().length, 0, 'unchanged front page is not set again');
  assert.strictEqual(resultOf(events).frontPage.action, 'unchanged');

  canvas.reset();
  events = await publish('--force');
  assert.strictEqual(canvas.frontPageRequests().length, 1, '--force sets it again');
  assert.strictEqual(resultOf(events).frontPage.action, 'set');
});

test('--only another page leaves the front page alone', async (t) => {
  const { canvas, publish } = await setup(t, {
    'content/intro.md': intro('published: true\nhome: true'),
    'content/module-1.md': module1(),
  });
  const events = await publish('--only', 'module-1.md');
  assert.strictEqual(canvas.frontPageRequests().length, 0);
  assert.strictEqual(resultOf(events).frontPage, null);
});

test('home: true on two pages: warning, no front page', async (t) => {
  const { canvas, project, publish } = await setup(t, {
    'content/intro.md': intro('published: true\nhome: true'),
    'content/module-1.md': module1('module: 1\npublished: true\nhome: true'),
  });
  const events = await publish();
  const w = events.filter((e) => e.type === 'warning' && e.code === 'home-multiple');
  assert.strictEqual(w.length, 1);
  assert.match(w[0].message, /intro\.md, module-1\.md/);
  assert.strictEqual(canvas.frontPageRequests().length, 0);
  assert.strictEqual(JSON.parse(project.read('canvas-map.json'))._frontPage, undefined);

  // The dry run ("Controleer") reports it too.
  const dry = parseEvents((await project.runAsync(['--dry-run', '--json'])).stdout);
  assert.ok(dry.some((e) => e.code === 'home-multiple'));
});

test('home: true on an unpublished page: warning, no front page', async (t) => {
  const { canvas, publish } = await setup(t, {
    'content/intro.md': intro('published: false\nhome: true'),
    'content/module-1.md': module1(),
  });
  const events = await publish();
  const w = events.find((e) => e.type === 'warning' && e.code === 'home-unpublished');
  assert.ok(w);
  assert.strictEqual(w.file, 'content/intro.md');
  assert.strictEqual(canvas.frontPageRequests().length, 0);
});

test('human log names the front page; without home: true nothing is set', async (t) => {
  const { canvas, project } = await setup(t, {
    'content/intro.md': intro('published: true\nhome: true'),
  });
  const r = await project.runAsync([]);
  assert.strictEqual(r.status, 0, r.stderr);
  assert.match(r.stdout, /^ {2}front page intro\.md -> introductie$/m);

  project.write('content/intro.md', intro('published: true'));
  canvas.reset();
  assert.strictEqual((await project.runAsync([])).status, 0);
  assert.strictEqual(canvas.frontPageRequests().length, 0);
});

test('a page removed from the Markdown is reported as an orphan, never deleted', async (t) => {
  const { canvas, project, publish } = await setup(t, {
    'content/intro.md': intro('published: true'),
    'content/module-1.md': module1(),
  });
  await publish();
  require('fs').rmSync(require('path').join(project.dir, 'content/module-1.md'));
  canvas.reset();
  const events = await publish();
  const orphan = events.find((e) => e.type === 'orphan');
  assert.deepStrictEqual(orphan, {
    type: 'orphan', kind: 'page', file: 'content/module-1.md', url: `${canvas.baseUrl}/courses/1/pages/module-1`,
  });
  assert.ok(!canvas.requests.some((r) => r.method === 'DELETE'));
});
