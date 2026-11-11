#!/usr/bin/env node
'use strict';
// Markdown -> one printable PDF of the whole course. Standalone: never talks to Canvas and never
// reads or writes canvas-map.json, so it cannot interfere with sync.js.
//
//   node convert-pdf.js                      whole course -> out/pdf/<title>.pdf
//   node convert-pdf.js --module 1           only module 1 (comma separated: 1,3)
//   node convert-pdf.js --published-only     only pages with `published: true` (what `sync.js --with-pdf` uses)
//   node convert-pdf.js --out handout.pdf    other output path
//
// Layout: cover, table of contents (with page numbers), then per module: the module text followed
// by its exercises. "Test jezelf" blocks become questions as text, without answers or feedback.
// Look: css/style.css (same as the Canvas pages) + css/pdf.css (print rules, cover, quiz text).
// Settings: pdf.config.json (title, author, date, footer, hidden blocks, ...). --config <file> uses another one.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { pathToFileURL } = require('url');
const { createRenderer, slugify, esc } = require('./lib/render');
const { parseQuiz } = require('./lib/quiz');
const { renderQuizText } = require('./lib/pdfquiz');

const ROOT = __dirname;

module.exports = { generatePdf };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => args.includes(name);
  const opt = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  if (flag('--help') || flag('-h')) {
    console.log('node convert-pdf.js [--module 1,2] [--published-only] [--out file.pdf] [--config file.json]');
    process.exit(0);
  }
  generatePdf({
    publishedOnly: flag('--published-only'),
    modules: opt('--module') ? opt('--module').split(',').map((x) => x.trim()) : null,
    out: opt('--out'),
    config: opt('--config'),
  }).catch((err) => { console.error(err.message || err); process.exit(1); });
}

// o: { publishedOnly, modules: ['1','3'], out, config }.
// Returns { pdfFile, name, hash, pageCount, parts, modules }; hash covers everything that ends up in the PDF
// (HTML + image bytes), so callers can skip an upload when it did not change (the PDF itself holds a timestamp).
async function generatePdf(o = {}) {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'course.config.json'), 'utf8'));
  const cfgFile = path.resolve(ROOT, o.config || 'pdf.config.json');
  const fileCfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};
  const cfg = {
    title: 'Cursus',
    subtitle: '',
    author: '',
    organisation: '',
    date: 'auto',
    edition: '',
    logo: null,
    footer: '{title}',
    runningHeader: true,
    headerPrefix: '',
    accent: '#E30613',
    palette: {},
    tocTitle: 'Inhoud',
    tocExercises: false,
    hideBlocks: ['github', 'oefening'],
    quizNote: '',
    fileNote: 'bestand in Canvas: {name}',
    pageSize: 'A4',
    ...fileCfg,
  };
  const fill = (t) => String(t).replace(/\{(title|subtitle|author|organisation|date|edition)\}/g, (m, k) => cfg[k] || '')
    .replace(/\s*[·|–-]\s*$/, '').replace(/^\s*[·|–-]\s*/, '').trim();
  const prefix = config.classPrefix ?? 'ti_';
  const contentDir = path.join(ROOT, config.contentDir || 'content');
  // No "Terug naar boven" links on paper.
  const renderer = createRenderer({ ...config, backToTopText: '' });
  const px = renderer.px;

  // 1. Parse every page (same rules as sync.js: files starting with _ are skipped).
  let pages = fs.readdirSync(contentDir).filter((f) => f.endsWith('.md') && !f.startsWith('_')).sort().map((file) => {
    const raw = fs.readFileSync(path.join(contentDir, file), 'utf8');
    return { file, slug: file.replace(/\.md$/, ''), raw, ...renderer.analyze(raw, file) };
  });
  pages = pages.filter((p) => p.fm.pdf !== false);
  // "Published" means what sync.js means: `published: true` in the front matter.
  if (o.publishedOnly) pages = pages.filter((p) => p.fm.published === true);
  if (o.modules) pages = pages.filter((p) => o.modules.includes(String(p.fm.module)));
  if (!pages.length) throw new Error('No pages to convert (check --module / --published-only).');
  pages.sort((a, b) => num(a.fm.module) - num(b.fm.module) || num(a.fm.order) - num(b.fm.order) || a.file.localeCompare(b.file));
  await renderer.highlight(pages);

  const drafts = pages.filter((p) => p.fm.published !== true).length;
  if (drafts) console.log(`  note: ${drafts} unpublished page(s) are included (use --published-only to leave them out)`);
  for (const p of pages) {
    p.raw.split('\n').forEach((line, i) => {
      if (/\[CONTROLEREN\]|\[NIET GETEST\]/.test(line)) console.warn(`  ! marker ${p.file}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }

  // 2. Quizzes: parsed with the same parser as the Canvas sync; only questions/options are printed.
  const quizzes = new Map();
  for (const p of pages) for (const q of p.quizzes) {
    const parsed = parseQuiz({ ...q, file: p.file });
    for (const msg of parsed.problems) if (!/Feedback/.test(msg)) console.warn(`  ! ${msg}`);
    quizzes.set(q.key, parsed);
  }

  // 3. Group into modules: pages with the same front matter `module`, in order (module text, then exercises).
  const groups = [];
  for (const p of pages) {
    const key = p.fm.module ?? p.title;
    let g = groups.find((x) => x.key === key);
    if (!g) groups.push(g = { key, label: null, pages: [] });
    g.pages.push(p);
    if (p.fm.moduleTitle) g.label = p.fm.moduleTitle;
  }
  for (const g of groups) if (!g.label) g.label = g.pages[0].title;

  // 4. Render page bodies. Section ids are prefixed per file (two pages may both have "oefening-1").
  const byFile = new Set(pages.map((p) => p.file));
  const assets = new Set(); // absolute paths of every image in the PDF (for the change hash)
  const env = (p) => ({
    file: p.file,
    resolvePage: (f) => (byFile.has(path.basename(f)) ? `PDFLINK:${path.basename(f)}` : undefined),
    resolveImage: (src, kind) => resolveImage(src, kind, contentDir, assets),
    resolveFile: (href) => `PDFFILE:${href}`,
    renderQuiz: (q) => renderQuizText(quizzes.get(q.key), { px, note: cfg.quizNote }),
  });
  const codeblockRe = new RegExp(`<div class="${prefix}codeblock">([\\s\\S]*?)</pre>`, 'g');
  const hideRe = new RegExp(`<div class="${prefix}block ${prefix}block_(?:${(cfg.hideBlocks || []).map((b) => b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') || '(?!)'})">[\\s\\S]*?</div>\\n</div>\\n`, 'g');
  for (const p of pages) {
    p.html = renderer.renderBody(p, env(p))
      .replace(/<a id="([^"]+)"><\/a>\n<(h[1-6])([^>]*)>/g, '<$2 id="$1"$3>')
      .replace(/(\s)id="([^"]+)"/g, (m, sp, id) => `${sp}id="${p.slug}-${id}"`)
      .replace(/href="#([^"]+)"/g, (m, id) => `href="#${p.slug}-${id}"`)
      .replace(/href="PDFLINK:([^"#]+)(?:#([^"]*))?"/g, (m, f, h) => `href="#${f.replace(/\.md$/, '')}-${h || 'top'}"`)
      .replace(hideRe, '')
      // Files to download only exist in Canvas: keep the text, say which file it is.
      .replace(/<a href="PDFFILE:([^"]*)"[^>]*>([\s\S]*?)<\/a>/g, (m, href, text) =>
        `<span class="${prefix}filelink">${text}</span>${cfg.fileNote ? ` <span class="${prefix}pdf_filenote">(${esc(cfg.fileNote.replace('{name}', path.basename(decodeURI(href))))})</span>` : ''}`)
      .replace(codeblockRe, (m) => ((m.match(/\n/g) || []).length > 30
        ? m.replace(`class="${prefix}codeblock"`, `class="${prefix}codeblock ${prefix}pdf_long"`) : m));
  }

  // 5. Assemble the document.
  const css = ['css/style.css', 'css/pdf.css'].map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
  if (!cfg.date || cfg.date === 'auto') cfg.date = capitalize(new Date().toLocaleDateString('nl-BE', { month: 'long', year: 'numeric' }));
  const date = cfg.date;
  const cls = (c) => `class="${px(c)}"`;

  const cssString = (s) => JSON.stringify(String(s)).replace(/\\u([0-9a-f]{4})/gi, '\\$1 ');
  const pageRules = `
@page { size: ${cfg.pageSize}; margin: 20mm 14mm 18mm 14mm;
  @bottom-left { content: ${cssString(fill(cfg.footer))}; font: 8pt Lato, Inter, Arial, sans-serif; color: #5a6a73; }
  @bottom-right { content: counter(page); font: 8pt Lato, Inter, Arial, sans-serif; color: #5a6a73; }
}
@page cover { margin: 0; @bottom-left { content: none; } @bottom-right { content: none; } }
${!cfg.runningHeader ? '' : groups.map((g, i) => `@page g${i} { @top-left { content: ${cssString([fill(cfg.headerPrefix), g.label].filter(Boolean).join(' · '))}; font: 600 8pt Lato, Inter, Arial, sans-serif; color: #0d5c5a; } }`).join('\n')}`;

  const logoUrl = cfg.logo ? resolveImage(cfg.logo, 'config', contentDir, assets) : null;
  const cover = `<section ${cls('pdf_cover')}>
<div ${cls('pdf_cover_top')}>${logoUrl ? `<img src="${esc(logoUrl)}" alt="">` : ''}${cfg.organisation ? `<div ${cls('pdf_cover_org')}>${esc(cfg.organisation)}</div>` : ''}</div>
<div ${cls('pdf_cover_main')}><div ${cls('pdf_cover_bar')}></div><div ${cls('pdf_cover_title')}>${esc(cfg.title)}</div>${cfg.subtitle ? `<div ${cls('pdf_cover_subtitle')}>${esc(cfg.subtitle)}</div>` : ''}${cfg.author ? `<div ${cls('pdf_cover_author')}>${esc(cfg.author)}</div>` : ''}</div>
<div ${cls('pdf_cover_foot')}><span>${esc(date)}</span><span>${esc(cfg.edition)}</span></div>
</section>`;

  const chapters = groups.map((g, gi) => g.pages.map((p) => {
    return `<section ${cls('pdf_chapter')} id="${p.slug}-top" style="page: g${gi}">\n<div ${cls('pdf_chhead')}><h1>${esc(p.title)}</h1></div>\n${p.html}</section>`;
  }).join('\n')).join('\n');

  const tocHtml = (numbers) => {
    const n = (id) => `<span ${cls('pdf_toc_n')}>${numbers.get(id) ?? '00'}</span>`;
    const row = (id, label, c) => `<a href="#${id}" ${cls(c)}><span>${esc(label)}</span><span ${cls('pdf_toc_dots')}></span>${n(id)}</a>`;
    return `<section ${cls('pdf_toc')}>\n<div ${cls('pdf_toc_title')}>${esc(cfg.tocTitle)}</div>\n`
      + groups.map((g) => `<div ${cls('pdf_toc_group')}>\n${row(`${g.pages[0].slug}-top`, g.label, 'pdf_toc_gtitle')}\n`
        + g.pages.filter((p, k) => k === 0 || cfg.tocExercises).map((p, k) => (k > 0 ? row(`${p.slug}-top`, p.fm.tocLabel || p.title, 'pdf_toc_page') + '\n' : '')
          + p.sections.map((s) => row(`${p.slug}-${s.id}`, s.title, 'pdf_toc_sec')).join('\n')).join('\n')
        + '\n</div>').join('\n')
      + '\n</section>';
  };

  const build = (numbers) => `<!doctype html>
<html lang="nl"><head><meta charset="utf-8"><title>${esc(cfg.title)}</title>
<style>${applyPalette(`${css}\n${pageRules}`, cfg)}</style></head>
<body class="${px('pdf')}">
${cover}
${tocHtml(numbers)}
${chapters}
</body></html>`;

  // 6. Print with Chromium. Pass 1 has placeholder page numbers in the table of contents; the page of
  //    every heading is then read from the PDF and pass 2 fills them in (repeated if the layout moved).
  let chromium;
  try { ({ chromium } = require('playwright')); } catch {
    throw new Error('Playwright is not installed. Run: npm install && npx playwright install chromium');
  }
  const outDir = path.join(ROOT, 'out', 'pdf');
  fs.mkdirSync(outDir, { recursive: true });
  const base = slugify(cfg.title);
  const htmlFile = path.join(outDir, `${base}.html`);
  const pdfFile = path.resolve(o.out || path.join(outDir, `${base}.pdf`));

  const ids = groups.flatMap((g) => g.pages.filter((p, k) => k === 0 || cfg.tocExercises).flatMap((p) => [`${p.slug}-top`, ...p.sections.map((s) => `${p.slug}-${s.id}`)]));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    let numbers = new Map();
    let pdf;
    let settled = false;
    for (let pass = 1; pass <= 6 && !settled; pass++) {
      fs.writeFileSync(htmlFile, build(numbers));
      await page.goto(pathToFileURL(htmlFile).href, { waitUntil: 'load' });
      await page.emulateMedia({ media: 'print' });
      await page.evaluate(() => document.fonts.ready);
      pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true, outline: true, tagged: true });
      const found = await pageNumbers(pdf);
      const next = new Map(ids.filter((id) => found.has(id)).map((id) => [id, found.get(id)]));
      const missing = ids.filter((id) => !next.has(id));
      if (missing.length) throw new Error(`Cannot find the page of ${missing.length} heading(s) in the PDF, e.g. ${missing[0]}. The table of contents would show wrong numbers.`);
      // Settled when the numbers printed in this PDF equal the page numbers measured in it.
      settled = pass > 1 && ids.every((id) => numbers.get(id) === next.get(id));
      numbers = next;
    }
    if (!settled) throw new Error('The page numbers in the table of contents do not settle (layout keeps changing). Run again or report this.');
    fs.mkdirSync(path.dirname(pdfFile), { recursive: true });
    fs.writeFileSync(pdfFile, pdf);
    const total = (await pageCount(pdf));
    const nq = [...quizzes.values()].reduce((a, q) => a + q.questions.length, 0);
    console.log(`PDF: ${total} pages, ${groups.length} module(s), ${pages.length} part(s), ${quizzes.size} quiz(zes) with ${nq} questions (no answers) -> ${path.relative(process.cwd(), pdfFile)}`);
    const h = crypto.createHash('sha256').update(build(numbers));
    for (const f of [...assets].sort()) h.update(f).update(fs.readFileSync(f));
    return { pdfFile, name: path.basename(pdfFile), hash: h.digest('hex'), pageCount: total, parts: pages.length, modules: groups.length };
  } finally {
    await browser.close();
  }
}

// ---- helpers ---------------------------------------------------------------------------------

function resolveImage(src, kind, contentDir, assets) {
  if (!src || /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(src)) return src; // http(s), data:, anchors stay as they are
  const abs = path.resolve(kind === 'config' ? ROOT : contentDir, decodeURI(src.split(/[?#]/)[0]));
  if (!fs.existsSync(abs)) { console.warn(`  ! image not found: ${src}`); return src; }
  if (assets) assets.add(abs);
  return pathToFileURL(abs).href;
}

// Chromium writes a named destination for every in-document link target. Map them to page numbers.
async function pageNumbers(buf) {
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef } = require('pdf-lib');
  const doc = await PDFDocument.load(buf);
  const index = new Map(doc.getPages().map((p, i) => [p.ref.toString(), i + 1]));
  const out = new Map();
  const take = (name, target) => {
    let v = target instanceof PDFRef ? doc.context.lookup(target) : target;
    if (v instanceof PDFDict) v = v.lookup(PDFName.of('D'));
    if (v instanceof PDFArray) {
      const ref = v.get(0);
      if (ref instanceof PDFRef && index.has(ref.toString())) out.set(name, index.get(ref.toString()));
    }
  };
  const decode = (k) => (k.decodeText ? k.decodeText() : String(k).replace(/^\//, ''));
  const dests = doc.catalog.lookupMaybe(PDFName.of('Dests'), PDFDict);
  if (dests) for (const [k, v] of dests.entries()) take(decode(k), v);
  const names = doc.catalog.lookupMaybe(PDFName.of('Names'), PDFDict);
  const tree = names && names.lookupMaybe(PDFName.of('Dests'), PDFDict);
  const walk = (node) => {
    if (!node) return;
    const arr = node.lookupMaybe(PDFName.of('Names'), PDFArray);
    if (arr) for (let i = 0; i + 1 < arr.size(); i += 2) take(arr.lookup(i).decodeText(), arr.get(i + 1));
    const kids = node.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids) for (let i = 0; i < kids.size(); i++) walk(kids.lookup(i, PDFDict));
  };
  walk(tree);
  return out;
}

async function pageCount(buf) {
  const { PDFDocument } = require('pdf-lib');
  return (await PDFDocument.load(buf)).getPageCount();
}

function num(v) { return v === undefined || v === null || v === '' ? Infinity : Number(v); }
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

// ---- PDF colours -------------------------------------------------------------------------------
// style.css (shared with the Canvas pages) is written in the teal template colours. For the PDF every
// teal is replaced by a shade of cfg.accent (default: the red of the logo), so style.css stays untouched.
// Single colours can be overridden in pdf.config.json: "palette": { "#e8820c": "#ff0000" }.
const TEAL = {
  '#25b4b1': ['accent'], '#167572': ['accent'],
  '#0f6e6b': ['black', 0.18], '#0d5c5a': ['black', 0.38], '#073332': ['black', 0.65], '#0d2b2a': ['black', 0.8],
  '#36d6d2': ['white', 0.45], '#7fb3b1': ['white', 0.55], '#c8e6e5': ['white', 0.75], '#d4f0ef': ['white', 0.82],
  '#d7ecec': ['white', 0.85], '#e3f1f1': ['white', 0.88], '#eaf7f7': ['white', 0.91], '#f3fafa': ['white', 0.95],
  // other template colours: info callout (blue), warning callout and "let op" banner (amber)
  '#3b7dd8': ['black', 0.5], '#eef4fc': ['white', 0.93],
  '#c9831a': ['fixed', '#d4560b'], '#fdf4e6': ['fixed', '#fff0e6'], '#b25d0e': ['fixed', '#b8460b'],
};

function applyPalette(css, cfg) {
  const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const toHex = (rgb) => '#' + rgb.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
  const mix = (rgb, to, t) => rgb.map((v, i) => v + (to - v) * t);
  const accent = hex(String(cfg.accent).toLowerCase());
  const map = {};
  for (const [from, [kind, arg]] of Object.entries(TEAL)) {
    map[from] = kind === 'accent' ? toHex(accent)
      : kind === 'black' ? toHex(mix(accent, 0, arg))
      : kind === 'white' ? toHex(mix(accent, 255, arg))
      : arg;
  }
  Object.assign(map, Object.fromEntries(Object.entries(cfg.palette || {}).map(([k, v]) => [k.toLowerCase(), v])));
  return css.replace(/#[0-9a-fA-F]{6}(?![0-9a-fA-F])/g, (m) => map[m.toLowerCase()] || m);
}
