#!/usr/bin/env node
'use strict';
// Markdown -> Canvas pages, with a generated course overview on every page.
//
//   node sync.js --dry-run          build into ./out, no Canvas calls
//   node sync.js                    build + publish changed pages
//   node sync.js --force            republish every page, ignore hashes
//   node sync.js --only module-1.md limit publishing to one file (TOC still uses all)
//   node sync.js --with-pdf         also build the PDF of the published pages, upload it and link it at the bottom of the TOC
//   node sync.js --json             one JSON event per line on stdout instead of the human log (README "Machine-readable output")
//   node sync.js --dry-run --only module-1.md       render and write only that page (fast preview)
//   node sync.js --dry-run --asset-base-url <url>   images, downloads and logos point at <url>/<project path>
//
// Local images (![alt](images/x.png)) and linked files ([text](files/module-1/x.zip)) are uploaded to the course's Files first.
// "Test jezelf" blocks become Canvas New Quizzes; the page links to them.
// A page with `home: true` (and `published: true`) becomes the course's front page.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const juiceModule = require('juice');
const juice = juiceModule.default || juiceModule; // juice >= 12 ships an ESM-style default export
const { createRenderer, slugify } = require('./lib/render');
const { renderToc } = require('./lib/toc');
const { Canvas } = require('./lib/canvas');
const { createImages } = require('./lib/images');
const { parseQuiz, buildPayload } = require('./lib/quiz');
const { syncQuizzes, quizOptions } = require('./lib/quizsync');
const { loadConfig } = require('./lib/config');
const log = require('./lib/log');

const ROOT = __dirname;
const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const WITH_PDF = args.includes('--with-pdf');
const JSON_OUT = args.includes('--json');
const optValue = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const ONLY_ARG = optValue('--only');
// --only accepts module-1.md as well as content/module-1.md.
const ONLY = ONLY_ARG && !ONLY_ARG.startsWith('--') ? path.basename(ONLY_ARG) : ONLY_ARG;
const ASSET_BASE_URL = optValue('--asset-base-url');

log.configure({ json: JSON_OUT });
loadDotEnv(path.join(ROOT, '.env'));
const MAP_FILE = path.join(ROOT, 'canvas-map.json');
let config; // course.config.json + defaults (quiz icon)
let map;
let coursePath;

main().catch((err) => { log.error(err); process.exit(1); });

async function main() {
  if (args.includes('--only') && (!ONLY || ONLY.startsWith('--'))) throw log.toolError('--only needs a file name, e.g. --only module-1.md', 'usage');
  if (args.includes('--asset-base-url') && (!ASSET_BASE_URL || ASSET_BASE_URL.startsWith('--'))) {
    throw log.toolError('--asset-base-url needs a URL', 'usage');
  }
  if (ASSET_BASE_URL && !DRY) throw log.toolError('--asset-base-url only works with --dry-run', 'usage');

  try {
    config = loadConfig(ROOT);
  } catch (err) {
    throw log.toolError(`course.config.json: ${err.message}`, 'config');
  }
  log.configure({ contentDir: config.contentDir || 'content' });
  map = fs.existsSync(MAP_FILE) ? JSON.parse(fs.readFileSync(MAP_FILE, 'utf8')) : {};
  coursePath = `${config.baseUrl.replace(/\/$/, '')}/courses/${config.courseId}`;

  const renderer = createRenderer(config);
  const contentDir = path.join(ROOT, config.contentDir || 'content');

  // 1. Parse every page (needed up front: every page's TOC lists all pages).
  log.progress('parse', 'Reading the Markdown pages');
  const pages = fs.readdirSync(contentDir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((file) => {
    const raw = fs.readFileSync(path.join(contentDir, file), 'utf8');
    const a = renderer.analyze(raw, file);
    return { file, raw, ...a };
  });
  if (ONLY && !pages.some((p) => p.file === ONLY)) {
    throw log.toolError(`--only ${ONLY_ARG}: no such page in ${config.contentDir || 'content'}/ (files starting with _ are skipped)`, 'usage');
  }
  // Fast preview: a dry run of one page renders (and highlights) only that page.
  const renderOnly = DRY && ONLY;

  // Author markers ([CONTROLEREN], [NIET GETEST]) must be resolved before a page goes live.
  const markerRe = new RegExp((config.blockingMarkers || ['[CONTROLEREN]', '[NIET GETEST]'])
    .map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'));
  const markerProblems = [];
  for (const p of pages) {
    p.raw.split('\n').forEach((line, i) => {
      if (!markerRe.test(line)) return;
      const msg = `${p.file}:${i + 1}: ${line.trim().slice(0, 80)}`;
      const blocking = p.fm.published === true;
      if (blocking) markerProblems.push(msg);
      log.warning({
        file: log.contentPath(p.file), line: i + 1, code: blocking ? 'marker-blocking' : 'marker-allowed',
        message: `marker: ${line.trim().slice(0, 80)}${blocking ? ' (published page: blocks publishing)' : ' (page unpublished, allowed)'}`,
      }, `  ! marker ${msg}${blocking ? '' : ' (page unpublished, allowed)'}`);
    });
  }
  log.progress('highlight', 'Highlighting code');
  await renderer.highlight(renderOnly ? pages.filter((p) => p.file === ONLY) : pages);
  pages.sort((a, b) =>
    num(a.fm.module) - num(b.fm.module) || num(a.fm.order) - num(b.fm.order) || a.file.localeCompare(b.file));

  // 2. Images: every local image referenced from Markdown or used as a block logo.
  log.progress('validate', 'Checking images, files and quizzes');
  const outDir = path.join(ROOT, 'out');
  const images = createImages({ root: ROOT, contentDir, outDir, map, config, coursePath, assetBaseUrl: ASSET_BASE_URL });
  for (const p of pages) for (const r of p.imageRefs) images.collect(r.src, 'content', p.file, 'image', r.line);
  for (const p of pages) for (const r of p.fileRefs) images.collect(r.href, 'content', p.file, 'file', r.line); // [text](files/module-1/x.zip)
  for (const [name, b] of Object.entries(config.blocks || {})) if (b.logo) images.collect(b.logo, 'config', `blocks.${name}.logo`);

  // 3. Test jezelf blocks: parse and validate every question before anything is sent to Canvas.
  const quizzes = pages.flatMap((p) => p.quizzes.map((q) => parseQuiz({ ...q, file: p.file })));
  const quizProblems = quizzes.flatMap((q) => q.problems);
  for (const q of quizzes) {
    for (const msg of q.problems) {
      log.warning({ file: log.contentPath(q.file), line: q.line ?? null, code: 'quiz-invalid', message: msg }, `  ! ${msg}`);
    }
  }
  for (const q of quizzes) {
    if (!q.experimental.length) continue;
    const message = `${q.where}: uses ${q.experimental.join(', ')} (experimental): check these questions in Canvas after publishing`;
    log.warning({ file: log.contentPath(q.file), line: q.line ?? null, code: 'quiz-experimental', message }, `  ! ${message}`);
  }

  // The page with `home: true` becomes the course's front page (at most one, and it must be published).
  const home = frontPageCandidate(pages);

  // 4. Make sure every page exists in Canvas with the right title (so we know the real URL slugs),
  //    and that every image is uploaded (so we know its file id).
  if (!DRY && images.problems.length && !args.includes('--allow-missing-images') && !args.includes('--allow-missing-files')) {
    throw log.toolError(`Not publishing: ${images.problems.length} image/file problem(s), see the warnings above. `
      + 'Fix them, or run with --allow-missing-images (or --allow-missing-files).', 'blocked-images');
  }
  if (!DRY && markerProblems.length) {
    throw log.toolError(`Not publishing: ${markerProblems.length} unresolved marker(s) on published pages, see the warnings above. `
      + 'Resolve them, or set published: false on that page.', 'blocked-markers');
  }
  if (!DRY && quizProblems.length) {
    throw log.toolError(`Not publishing: ${quizProblems.length} problem(s) in Test jezelf questions, see the warnings above.`, 'blocked-quizzes');
  }
  // --with-pdf: build the PDF first, so a failure (e.g. Chromium missing) happens before anything is sent to Canvas.
  let pdf = null;
  if (WITH_PDF) {
    if (!pages.some((p) => p.fm.published === true)) {
      log.warning({ code: 'pdf-no-published-pages', message: '--with-pdf: no page has `published: true`, no PDF made' },
        '  ! --with-pdf: no page has `published: true`, no PDF made');
    } else {
      log.progress('pdf', 'Building the PDF of the published pages');
      pdf = await require('./convert-pdf').generatePdf({ publishedOnly: true });
    }
  }

  const canvas = DRY ? null : new Canvas(config.baseUrl, process.env.CANVAS_TOKEN);
  let uploaded = 0;
  let pdfState = null;
  if (!DRY) {
    log.progress('pages', 'Matching pages in Canvas');
    await ensurePages(canvas, pages);
    log.progress('files', 'Uploading images and files');
    uploaded = await images.upload(canvas, saveMap);
    if (pdf) pdfState = await uploadPdf(canvas, pdf);
  }
  // The TOC link stays once a PDF was uploaded, also on runs without --with-pdf (otherwise every plain run
  // would strip it and the next --with-pdf run would add it again). Remove it by deleting "_pdf" from canvas-map.json.
  const pdfTitle = config.pdfLinkTitle || 'Download deze cursus (PDF)';
  const pdfLink = pdf && DRY ? { href: `pdf/${pdf.name}`, title: pdfTitle }
    : map._pdf && map._pdf.id ? { href: `${coursePath}/files/${map._pdf.id}/download?download_frd=1`, title: pdfTitle }
    : null;
  if (!WITH_PDF && pdfLink) log.note('  note: the PDF link in the TOC points at the last uploaded PDF; run with --with-pdf to refresh it');

  for (const p of pages) {
    const slug = map[p.file]?.url || slugify(p.title); // dry run: predicted slug
    p.href = `${coursePath}/pages/${slug}`;
  }
  const byFile = new Map(pages.map((p) => [p.file, p]));

  // "zie 1.1" in quiz feedback links to the page and section where 1.1 lives.
  const sectionHrefs = new Map();
  for (const p of pages) for (const s of p.sections) {
    const m = s.title.match(/^(\d+(?:\.\d+)+)/);
    if (m && !sectionHrefs.has(m[1])) sectionHrefs.set(m[1], `${p.href}#${s.id}`);
  }
  const sectionHref = (num) => sectionHrefs.get(num);

  // 5. Quizzes: create or update in Canvas (dry run: write the payloads to out/quizzes for inspection).
  const outQuizDir = path.join(outDir, 'quizzes');
  let quizStats = null;
  if (DRY && !renderOnly) {
    fs.mkdirSync(outQuizDir, { recursive: true });
    for (const q of quizzes) {
      if (q.problems.length) continue;
      const payload = buildPayload(q, { opts: quizOptions(config), sectionHref });
      fs.writeFileSync(path.join(outQuizDir, slugify(q.key) + '.json'), JSON.stringify(payload, null, 2));
    }
  } else if (!DRY && quizzes.length) {
    log.progress('quizzes', 'Creating and updating Test jezelf quizzes');
    quizStats = await syncQuizzes({
      canvas, config, map, saveMap, quizzes, sectionHref, coursePath,
      pageOf: (file) => byFile.get(file), only: ONLY, force: FORCE,
    });
  }
  const resolveQuiz = (key) => (map._quizzes || {})[key] || null;

  // 6. Render every page with its own TOC.
  log.progress('render', renderOnly ? `Rendering ${ONLY}` : 'Rendering the pages');
  const template = fs.readFileSync(path.join(ROOT, config.template || 'template.html'), 'utf8');
  const css = config.inlineCss && config.cssFile ? fs.readFileSync(path.join(ROOT, config.cssFile), 'utf8') : null;
  fs.mkdirSync(outDir, { recursive: true });

  let changed = 0;
  const written = [];
  for (const p of pages) {
    if (renderOnly && p.file !== ONLY) continue;
    const env = {
      file: p.file,
      resolvePage: (f) => byFile.get(path.basename(f))?.href,
      resolveImage: (src, kind) => images.resolve(src, kind, DRY),
      resolveFile: (href) => images.resolve(href, 'content', DRY, 'file'),
      resolveQuiz,
    };
    const body = renderer.renderBody(p, env);
    let html = template
      .replace('{{toc}}', () => renderToc(pages, p, config, renderer.px, pdfLink))
      .replace('{{content}}', () => body)
      .replace('{{title}}', () => p.title);
    if (css) html = juice(html, { extraCss: css, removeStyleTags: true, preserveMediaQueries: false, applyWidthAttributes: false, applyHeightAttributes: false });

    const outName = p.file.replace(/\.md$/, '.html');
    fs.writeFileSync(path.join(outDir, outName), html);
    written.push(`out/${outName}`);

    const hash = crypto.createHash('sha256').update(html).digest('hex');
    if (DRY || (ONLY && p.file !== ONLY)) continue;
    const pageUrl = `${coursePath}/pages/${map[p.file].url}`;
    if (!FORCE && map[p.file]?.hash === hash) {
      log.page({ file: log.contentPath(p.file), action: 'skipped', url: pageUrl });
      continue;
    }

    const wikiPage = { body: html };
    if (typeof p.fm.published === 'boolean') wikiPage.published = p.fm.published;
    await canvas.updatePage(config.courseId, map[p.file].url, wikiPage);
    map[p.file].hash = hash;
    saveMap();
    changed++;
    log.page({ file: log.contentPath(p.file), action: 'updated', url: `${coursePath}/pages/${map[p.file].url}` },
      `  updated  ${p.file} -> ${map[p.file].url}`);
  }

  // 7. Course front page, and pages that are still in Canvas but no longer in the Markdown.
  let frontPage = null;
  if (!DRY) {
    if (home && (!ONLY || ONLY === home.file)) frontPage = await setFrontPage(canvas, home);
    if (!ONLY) reportOrphanPages(pages);
  }

  const nQuestions = quizzes.reduce((n, q) => n + q.questions.length, 0);
  const human = DRY && renderOnly
    ? `Dry run: ${written[0]} written (only ${ONLY}; the overview lists all ${pages.length} pages).`
    : DRY
      ? `Dry run: ${pages.length} pages written to ./out (links use predicted slugs, images local paths; `
        + `${images.count()} image/file(s) found; ${quizzes.length} quiz(zes) with ${nQuestions} questions, payloads in out/quizzes).`
      : `Done: ${changed} page(s) updated, ${pages.length - changed} unchanged; ${uploaded} image(s) uploaded`
        + (quizStats ? `; quizzes: ${quizStats.created} created, ${quizStats.updated} updated, ${quizStats.unchanged} unchanged` : '')
        + (pdfState ? `; PDF ${pdfState}` : '') + '.';
  log.result(DRY
    ? {
      dryRun: true, only: ONLY ? log.contentPath(ONLY) : null, pages: pages.length, written,
      files: images.count(), quizzes: quizzes.length, questions: nQuestions,
      frontPage: home ? log.contentPath(home.file) : null,
    }
    : {
      dryRun: false, only: ONLY ? log.contentPath(ONLY) : null, pages: pages.length,
      pagesUpdated: changed, pagesUnchanged: pages.length - changed, filesUploaded: uploaded,
      quizzes: quizStats || { created: 0, updated: 0, unchanged: 0 }, pdf: pdfState, frontPage,
    }, human);
}

// The page with `home: true`, if exactly one and published; warns (and returns null) otherwise.
function frontPageCandidate(pages) {
  const homes = pages.filter((p) => p.fm.home === true);
  if (homes.length > 1) {
    const list = homes.map((p) => p.file).sort().join(', ');
    log.warning({ code: 'home-multiple', message: `home: true on more than one page (${list}); the front page is not changed` },
      `  ! home: true on more than one page (${list}); the front page is not changed`);
    return null;
  }
  if (homes.length === 1 && homes[0].fm.published !== true) {
    const p = homes[0];
    log.warning({ file: log.contentPath(p.file), code: 'home-unpublished', message: 'home: true on a page without published: true; the front page is not changed' },
      `  ! ${p.file}: home: true on a page without published: true; the front page is not changed`);
    return null;
  }
  return homes[0] || null;
}

// Set the course front page (only when it changed, or with --force). Never touches the course's home view.
async function setFrontPage(canvas, home) {
  const entry = map[home.file];
  const url = `${coursePath}/pages/${entry.url}`;
  const file = log.contentPath(home.file);
  if (!FORCE && map._frontPage && String(map._frontPage.page_id) === String(entry.page_id)) {
    return { file, url, action: 'unchanged' };
  }
  await canvas.setFrontPage(config.courseId, entry.url);
  map._frontPage = { file: home.file, page_id: entry.page_id, url: entry.url };
  saveMap();
  log.note(`  front page ${home.file} -> ${entry.url}`, { step: 'frontpage', message: `front page set to ${file} (${url})` });
  return { file, url, action: 'set' };
}

// Pages the tool published earlier whose .md file is gone: left alone in Canvas, but reported.
function reportOrphanPages(pages) {
  const present = new Set(pages.map((p) => p.file));
  for (const [file, e] of Object.entries(map)) {
    if (file.startsWith('_') || present.has(file) || !e || !e.url) continue;
    const url = `${coursePath}/pages/${e.url}`;
    log.orphan({ kind: 'page', file: log.contentPath(file), url },
      `  ! page ${file} is no longer in the Markdown; it still exists in Canvas (${url}). Delete it there if it is not needed.`);
  }
}

// Upload the PDF (same name -> on_duplicate overwrite keeps the file id, so the TOC link stays valid).
async function uploadPdf(canvas, pdf) {
  const prev = map._pdf;
  const pdfPath = `pdf/${pdf.name}`;
  if (prev && prev.hash === pdf.hash && prev.name === pdf.name && !FORCE) {
    log.file({ path: pdfPath, action: 'unchanged', url: `${coursePath}/files/${prev.id}/download?download_frd=1` }, `  PDF unchanged (${pdf.name})`);
    return 'unchanged';
  }
  const opts = config.files || {};
  const file = await canvas.uploadFile(config.courseId, {
    name: pdf.name, buffer: fs.readFileSync(pdf.pdfFile), contentType: 'application/pdf',
    folder: [opts.folder || 'course-sync', 'pdf'].join('/'),
  });
  if (opts.usageRights) await canvas.setUsageRights(config.courseId, [file.id], opts.usageRights);
  if (opts.hidden) await canvas.updateFile(file.id, { hidden: true });
  map._pdf = { hash: pdf.hash, id: file.id, name: pdf.name };
  saveMap();
  log.file({ path: pdfPath, action: 'uploaded', url: `${coursePath}/files/${file.id}/download?download_frd=1` },
    `  uploaded PDF ${pdf.name} (${pdf.pageCount} pages) -> file ${file.id}`);
  return 'uploaded';
}

async function ensurePages(canvas, pages) {
  const remote = await canvas.listPages(config.courseId);
  const byId = new Map(remote.map((r) => [String(r.page_id), r]));
  const byTitle = new Map(remote.map((r) => [r.title, r]));

  for (const p of pages) {
    const entry = map[p.file];
    const file = log.contentPath(p.file);
    // Known page (by id), else adopt an existing page with the same title (first migration), else create.
    let r = entry && byId.get(String(entry.page_id));
    if (!r && byTitle.has(p.title)) {
      r = byTitle.get(p.title);
      log.page({ file, action: 'adopted', url: `${coursePath}/pages/${r.url}` }, `  adopted  ${p.file} -> existing page "${p.title}"`);
    }
    if (!r) {
      r = await canvas.createPage(config.courseId, {
        title: p.title,
        body: '<p>Wordt gegenereerd…</p>',
        published: p.fm.published === true,
      });
      log.page({ file, action: 'created', url: `${coursePath}/pages/${r.url}` }, `  created  ${p.file} -> ${r.url}`);
    } else if (r.title !== p.title) {
      r = await canvas.updatePage(config.courseId, r.url, { title: p.title }); // slug may change
      log.page({ file, action: 'renamed', url: `${coursePath}/pages/${r.url}` }, `  renamed  ${p.file} -> ${r.url}`);
    }
    map[p.file] = { ...(map[p.file] || {}), page_id: r.page_id, url: r.url };
  }
  saveMap();
}

function saveMap() { fs.writeFileSync(MAP_FILE, JSON.stringify(map, null, 2) + '\n'); }
function num(v) { return v === undefined || v === null || v === '' ? Infinity : Number(v); }

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
