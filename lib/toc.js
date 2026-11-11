'use strict';
// Builds the "Cursusoverzicht" sidebar for one page.
// Pages are grouped by front matter `module`; the group containing the
// current page is rendered <details open>, links to the current page are
// same-page anchors (no reload).

const { esc } = require('./render');

function groupPages(pages) {
  const groups = new Map();
  for (const p of pages) {
    if (p.fm.toc === false || p.fm.published === false) continue;
    const key = p.fm.module ?? p.title;
    if (!groups.has(key)) groups.set(key, { key, label: null, pages: [] });
    const g = groups.get(key);
    g.pages.push(p);
    if (p.fm.moduleTitle) g.label = p.fm.moduleTitle;
  }
  for (const g of groups.values()) if (!g.label) g.label = g.pages[0].title;
  return [...groups.values()];
}

function renderToc(pages, current, config, px, pdfLink) {
  const groups = groupPages(pages);
  // Links are direct children of <details>, matching `details > a` in style.css.
  const li = (href, text, isCurrent) =>
    `<a href="${esc(href)}" class="${px(isCurrent ? 'overview_link current' : 'overview_link')}">${esc(text)}</a>`;

  let html = `<div class="${px('overview')}" id="ti_overview">\n`
    + `<div class="${px('overview_title')}">${esc(config.tocTitle || 'Cursusoverzicht')}</div>\n`;

  for (const g of groups) {
    const open = g.pages.includes(current);
    html += `<details class="${px(open ? 'overview_module current' : 'overview_module')}"${open ? ' open' : ''}>`
      + `<summary class="${px('overview_summary')}">${esc(g.label)}</summary>\n`;
    for (const p of g.pages) {
      const isCurrent = p === current;
      const base = isCurrent ? '' : p.href;
      const mode = p.fm.tocMode || (p.sections.length ? 'sections' : 'page');
      if (mode === 'sections') {
        for (const s of p.sections) html += li(`${base}#${s.id}`, s.title, isCurrent) + '\n';
      } else {
        html += li(isCurrent ? `#${config.topId || 'ti_top'}` : p.href, p.fm.tocLabel || p.title, isCurrent) + '\n';
      }
    }
    html += '</details>\n';
  }

  // Links to things that are not generated from Markdown (exam page, quizzes, ...)
  for (const extra of config.extraTocGroups || []) {
    html += `<details class="${px('overview_module')}"><summary class="${px('overview_summary')}">${esc(extra.title)}</summary>\n`;
    for (const l of extra.links || []) html += li(l.href, l.title, false) + '\n';
    html += '</details>\n';
  }

  // Download link for the generated PDF (sync.js --with-pdf), always the last thing in the overview.
  if (pdfLink) html += `<a href="${esc(pdfLink.href)}" class="${px('overview_pdf')}">${esc(pdfLink.title)}</a>\n`;

  return html + '</div>\n';
}

module.exports = { renderToc };
