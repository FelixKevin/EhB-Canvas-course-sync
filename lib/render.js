'use strict';
// Deterministic Markdown -> Canvas HTML renderer. See README for the full mapping.
// Every class it emits (and every class an author writes as {.name}) gets config.classPrefix
// ("ti_"), so the sub-account theme CSS can target these pages without touching anyone else's.

const MarkdownIt = require('markdown-it');
const container = require('markdown-it-container');
const attrs = require('markdown-it-attrs');
const matter = require('gray-matter');

const esc = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function slugify(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'sectie';
}

// "1.1 Hoe data beweegt" -> "1_1"; otherwise a slug. Deduplicated per page.
function sectionId(text, used) {
  const m = text.match(/^(\d+(?:\.\d+)*)\.?\s/);
  const base = m ? m[1].replace(/\./g, '_') : slugify(text);
  let id = base, i = 2;
  while (used.has(id)) id = `${base}-${i++}`;
  return id;
}

function plainText(inlineToken) {
  return (inlineToken.children || [])
    .filter((c) => c.type === 'text' || c.type === 'code_inline')
    .map((c) => c.content).join('').trim();
}

function createRenderer(config) {
  const prefix = config.classPrefix ?? 'ti_';
  const px = (classes) => String(classes).split(/\s+/).filter(Boolean)
    .map((c) => (c.startsWith(prefix) ? c : prefix + c)).join(' ');
  const cls = (classes) => `class="${esc(px(classes))}"`;
  const code = config.code || {};

  const md = new MarkdownIt({ html: true, linkify: true, typographer: false });
  md.use(attrs, { allowedAttributes: ['class', 'id', 'target', 'title', 'width', 'height'] });

  // --- link blocks: ::: oefening / ::: github / ::: jsfiddle (config.blocks) --
  for (const [name, b] of Object.entries(config.blocks || {})) {
    md.use(container, name, {
      render(tokens, idx, _opts, env) {
        if (tokens[idx].nesting === 1) {
          const close = env.inSection ? '</div>\n\n' : '';
          env.inSection = false;
          env.block = b;
          const logoSrc = b.logo && env.resolveImage ? env.resolveImage(b.logo, 'config') : b.logo;
          const logo = logoSrc
            ? `<div ${cls('block_logo')}><img src="${esc(logoSrc)}" alt="" ${cls('block_img')}></div>\n` : '';
          const heading = b.heading ? `<div ${cls('block_heading')}>${esc(b.heading)}</div>\n` : '';
          return `${close}<div ${cls(`block block_${name}`)}>\n${logo}<div ${cls('block_body')}>\n${heading}`;
        }
        env.block = null;
        return '</div>\n</div>\n';
      },
    });
  }

  // --- Test jezelf -> quiz link block (stays inside its section) -----------------
  // env.resolveQuiz(key) -> { url, count } once the quiz exists in Canvas.
  md.renderer.rules.ti_quiz = (tokens, idx, _o, env) => {
    const q = tokens[idx].meta.quiz;
    if (env.renderQuiz) return env.renderQuiz(q); // convert-pdf.js: questions as text instead of a link
    const b = (config.blocks || {}).quiz || {};
    const info = env.resolveQuiz ? env.resolveQuiz(q.key) : null;
    const count = q.count;
    const logoSrc = b.logo && env.resolveImage ? env.resolveImage(b.logo, 'config') : b.logo;
    const logo = logoSrc ? `<div ${cls('block_logo')}><img src="${esc(logoSrc)}" alt="" ${cls('block_img')}></div>\n` : '';
    const target = b.linkTarget ? ` target="${esc(b.linkTarget)}"` : '';
    const meta = (config.quizzes && config.quizzes.metaText || '{n} vragen · telt niet mee · onbeperkt pogingen')
      .replace('{n}', String(count));
    // Three cells (icon | title + meta | button): the button sits on the right, vertically centred,
    // while the reading order stays title first. Phones stack the button below (theme/mobile CSS).
    return `<div ${cls('block block_quiz')}>\n${logo}<div ${cls('block_body')}>\n`
      + `<div ${cls('block_heading')}>${esc(q.title)}</div>\n`
      + `<div ${cls('block_meta')}>${esc(meta)}</div>\n`
      + `</div>\n<div ${cls('block_action')}>\n`
      + `<a href="${esc(info && info.url ? info.url : '#ti_quiz_not_published')}" ${cls('block_link')}${target}>${esc(b.linkText || 'Start de quiz')}</a>\n`
      + '</div>\n</div>\n';
  };

  // --- callouts: ::: tip / info / warning ------------------------------------
  for (const name of config.callouts || []) {
    md.use(container, name, {
      render(tokens, idx) {
        if (tokens[idx].nesting !== 1) return '</div>\n';
        const icon = (config.calloutIcons || {})[name];
        const iconHtml = icon ? `<span ${cls('callout_icon')} aria-hidden="true">${esc(icon)}</span>\n` : '';
        return `<div ${cls(`callout callout_${name}`)}>\n${iconHtml}`;
      },
    });
  }

  // Paragraphs: stripped inside link blocks; "Dit betekent voor jou: ..." becomes a takeaway box.
  md.renderer.rules.paragraph_open = (tk, i, o, env, self) => {
    if (env.block) return '';
    if (tk[i].meta && tk[i].meta.takeaway) {
      return `<div ${cls('callout callout_takeaway')}>\n<p><strong ${cls('callout_label')}>${esc(config.takeawayPrefix)}</strong>`;
    }
    return self.renderToken(tk, i, o);
  };
  md.renderer.rules.paragraph_close = (tk, i, o, env, self) => {
    if (env.block) return '';
    if (tk[i].meta && tk[i].meta.takeaway) return '</p>\n</div>\n';
    return self.renderToken(tk, i, o);
  };

  // --- images: local files are uploaded to Canvas; env.resolveImage maps src -> URL ---------
  // ![Alt text](images/router.png "Optional caption"){width=400}
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    const raw = t.attrGet('src') || '';
    const src = env.resolveImage ? env.resolveImage(raw, 'content') : raw;
    const alt = self.renderInlineAsText(t.children || [], opts, env);
    const extra = ['width', 'height'].filter((a) => t.attrGet(a))
      .map((a) => ` ${a}="${esc(t.attrGet(a))}"`).join('');
    const classes = px(['img', t.attrGet('class') || ''].join(' '));
    const img = `<img src="${esc(src)}" alt="${esc(alt)}" class="${esc(classes)}"${extra}>`;
    const caption = t.attrGet('title');
    if (!caption) return img;
    env.figure = (env.figure || 0) + 1;
    const label = config.figureLabel ? `<strong ${cls('caption_label')}>${esc(config.figureLabel.replace('{n}', env.figure))}</strong> ` : '';
    return `${img}<span ${cls('caption')}>${label}${esc(caption)}</span>`;
  };

  // --- tables: plain rows + td (header row styled via tr:first-child) --------
  md.renderer.rules.table_open = () => `<table ${cls('table')}>\n`;
  md.renderer.rules.thead_open = md.renderer.rules.thead_close = () => '';
  md.renderer.rules.tbody_open = md.renderer.rules.tbody_close = () => '';
  md.renderer.rules.th_open = (tk, i, _o, _e, self) => `<td${self.renderAttrs(tk[i])}>`;
  md.renderer.rules.th_close = () => '</td>';

  // --- code ------------------------------------------------------------------
  // Fences are highlighted beforehand (async, Shiki) and stored on token.meta.html.
  md.renderer.rules.fence = (tokens, idx) => {
    const t = tokens[idx];
    const lang = fenceLang(t);
    const isOutput = (code.outputLangs || []).includes(lang);
    const label = isOutput ? (code.outputLabel || 'Output') : (code.labels || {})[lang];
    const head = label ? `<div ${cls('code_label')}>${esc(label)}</div>\n` : '';
    const pre = t.meta && t.meta.html
      ? t.meta.html
      : `<pre ${cls(isOutput ? 'output' : 'code')}>${esc(t.content.replace(/\n$/, ''))}</pre>`;
    return `<div ${cls('codeblock')}>\n${head}${pre}\n</div>\n`;
  };
  md.renderer.rules.code_block = md.renderer.rules.fence;

  md.renderer.rules.code_inline = (tokens, idx) => {
    const t = tokens[idx];
    return `<span ${cls(t.attrGet('class') || config.inlineCodeClass || 'mono')}>${esc(t.content)}</span>`;
  };

  // --- headings / sections ---------------------------------------------------
  const tagFor = (tag) => (config.headingMap || {})[tag] || tag;
  md.renderer.rules.heading_open = (tokens, idx, _o, env, self) => {
    const t = tokens[idx];
    const tag = tagFor(t.tag);
    const a = self.renderAttrs(t);
    if (t.meta && t.meta.sectionId) {
      const close = env.inSection ? '</div>\n\n' : '';
      env.inSection = true;
      // ## Titel {.easy} -> a text label in the header, so the variant is not shown by colour alone
      const variant = (t.attrGet('class') || '').split(/\s+/).map((c) => c.replace(prefix, ''))
        .find((c) => (config.variantLabels || {})[c]);
      const badge = variant ? `<span ${cls(`variant variant_${variant}`)}>${esc(config.variantLabels[variant])}</span> ` : '';
      return `${close}<div ${cls('section')}><a id="${esc(t.meta.sectionId)}"></a>\n<${tag}${a}>${badge}`;
    }
    return `<${tag}${a}>`;
  };
  md.renderer.rules.heading_close = (tokens, idx) => {
    const t = tokens[idx];
    // backToTopLabel: accessible name when the visible text is only an arrow
    const label = config.backToTopLabel ? ` title="${esc(config.backToTopLabel)}" aria-label="${esc(config.backToTopLabel)}"` : '';
    const back = t.meta && t.meta.section && config.backToTopText
      ? ` <a href="#${esc(config.topId || 'ti_top')}" ${cls('top')}${label}>${esc(config.backToTopText)}</a>` : '';
    return `${back}</${tagFor(t.tag)}>\n`;
  };

  // A link to a file in the repo (files/module-1/start.zip): not a URL, not an anchor, not another page.
  const isLocalFileLink = (href) => !!href && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#|\?)/i.test(href)
    && !/\.md(#.*)?$/i.test(href.split('?')[0]);

  // --- links: external -> new tab, ./other.md#x -> Canvas page URL -----------
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx];
    let href = t.attrGet('href') || '';
    const mdLink = href.match(/^(?:\.\/)?([^#:?]+\.md)(#.*)?$/);
    if (mdLink && env.resolvePage) {
      const url = env.resolvePage(mdLink[1]);
      if (url) { href = url + (mdLink[2] || ''); t.attrSet('href', href); }
      else console.warn(`  ! ${env.file}: link to unknown page ${mdLink[1]}`);
    }
    if (isLocalFileLink(href)) {
      // Local file: env.resolveFile gives the Canvas download URL of the uploaded copy.
      const url = env.resolveFile && env.resolveFile(href);
      if (url) { href = url; t.attrSet('href', href); }
      if (!env.block) t.attrJoin('class', px('filelink'));
    }
    const external = /^https?:\/\//.test(href) && !(config.baseUrl && href.startsWith(config.baseUrl));
    if (env.block) {
      t.attrJoin('class', px('block_link'));
      if (env.block.linkTarget && !t.attrGet('target')) t.attrSet('target', env.block.linkTarget);
    } else if (external && config.externalLinksNewTab && !t.attrGet('target')) {
      t.attrSet('target', '_blank');
      t.attrSet('rel', 'noopener');
    }
    return self.renderToken(tokens, idx, opts);
  };

  function fenceLang(t) {
    const lang = (t.info || '').trim().split(/\s+/)[0].toLowerCase();
    return (code.aliases || {})[lang] || lang;
  }

  // Prefix author-written classes ({.letop} -> ti_letop), recursively.
  function prefixAttrs(tokens) {
    for (const t of tokens) {
      const c = t.attrGet && t.attrGet('class');
      if (c && t.type !== 'code_inline') t.attrSet('class', px(c));
      if (c && t.type === 'code_inline') t.attrSet('class', c); // prefixed at render time
      if (t.children) prefixAttrs(t.children);
    }
  }

  // Parse + annotate tokens. Returns title, sections, fences and the token stream.
  function analyze(source, file) {
    const { data: fm, content } = matter(source);
    const tokens = md.parse(content, {});
    prefixAttrs(tokens);
    const used = new Set();
    const sections = [];
    const fences = [];
    const images = [];
    const files = [];
    const quizzes = [];
    let title = fm.title;
    const out = [];
    const takeaway = config.takeawayPrefix;
    // Quizzes are on unless the config says "quizzes": { "enabled": false }.
    const quizOn = !(config.quizzes && config.quizzes.enabled === false);
    const quizHeading = new RegExp((config.quizzes && config.quizzes.headingPattern) || '^Test\\s+jezelf\\b', 'i');
    const isQuizFence = (t) => t && t.type === 'fence' && /^\s*(Sectie|Type)\s*:/.test(t.content);
    const fmLines = source.split('\n').length - content.split('\n').length; // to report real line numbers
    const lineOf = (t) => (t.map ? t.map[0] + 1 + fmLines : '?');

    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i];
      if (t.type === 'hr') continue; // section boxes replace the --- separators
      if (t.type === 'heading_open' && t.tag === 'h1') {
        if (!title) title = plainText(tokens[i + 1]);
        i += 2; // Canvas shows the page title itself
        continue;
      }
      // "### Test jezelf 1.1 – Titel" + ```text blocks in the quiz format -> one quiz.
      if (quizOn && t.type === 'heading_open' && t.tag !== 'h1' && quizHeading.test(plainText(tokens[i + 1]))
          && !isQuizFence(tokens[i + 3])) {
        console.warn(`  ! ${file}:${lineOf(t)}: "${plainText(tokens[i + 1])}" is not directly followed by a \`\`\`text block `
          + 'whose first line is "Sectie:" or "Type:"; no quiz is made, the heading stays as text');
      }
      if (quizOn && t.type === 'fence' && isQuizFence(t)) {
        console.warn(`  ! ${file}:${lineOf(t)}: quiz questions without a "### Test jezelf ..." heading directly above them; `
          + 'they are shown as a code block, no quiz is made');
      }
      if (quizOn && t.type === 'heading_open' && t.tag !== 'h1'
          && quizHeading.test(plainText(tokens[i + 1])) && isQuizFence(tokens[i + 3])) {
        const qTitle = plainText(tokens[i + 1]);
        const qId = t.attrGet('id') || slugify(qTitle);
        const texts = [];
        let j = i + 3;
        while (isQuizFence(tokens[j])) texts.push(tokens[j++].content);
        const count = texts.join('\n').split('\n').filter((l) => /^Sectie\s*:/.test(l)).length
          || texts.join('\n').split('\n').filter((l) => /^Type\s*:/.test(l)).length;
        const quiz = { key: `${file}#${qId}`, title: qTitle, texts, where: `${file} "${qTitle}"`, count };
        quizzes.push(quiz);
        const tok = new t.constructor('ti_quiz', '', 0);
        tok.block = true;
        tok.meta = { quiz };
        out.push(tok);
        i = j - 1;
        continue;
      }
      if (t.type === 'heading_open' && t.tag === config.sectionHeading) {
        const text = plainText(tokens[i + 1]);
        const explicit = t.attrGet('id'); // "## Titel {#eigen-id}"
        if (explicit) t.attrs = t.attrs.filter(([k]) => k !== 'id');
        const id = explicit || sectionId(text, used);
        used.add(id);
        t.meta = { sectionId: id };
        tokens[i + 2].meta = { section: true };
        sections.push({ id, title: text });
      }
      if (takeaway && t.type === 'paragraph_open' && t.level === 0
          && tokens[i + 1].content.startsWith(takeaway)) {
        t.meta = { takeaway: true };
        const first = tokens[i + 1].children[0]; // label is rendered bold by paragraph_open
        if (first && first.type === 'text' && first.content.startsWith(takeaway)) first.content = first.content.slice(takeaway.length);
        // find the matching close
        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j].type === 'paragraph_close') { tokens[j].meta = { takeaway: true }; break; }
        }
      }
      if (t.type === 'fence') fences.push(t);
      if (t.type === 'inline') {
        for (const c of t.children || []) {
          if (c.type === 'link_open') {
            const href = c.attrGet('href') || '';
            if (isLocalFileLink(href)) files.push(href);
            continue;
          }
          if (c.type !== 'image') continue;
          images.push(c.attrGet('src'));
          if (!c.children || !c.children.length) console.warn(`  ! ${file}: image without alt text: ${c.attrGet('src')}`);
        }
      }
      out.push(t);
    }
    if (!title) throw new Error(`${file}: no title (front matter "title" or a # heading)`);
    return { fm, title, sections, fences, images, files, quizzes, tokens: out };
  }

  // Syntax highlighting with Shiki. Output is plain spans with inline colours, so it survives
  // Canvas' sanitizer and also works in the mobile app (which ignores theme CSS).
  async function highlight(pages) {
    if (!code.highlight) return;
    const { createHighlighter, bundledLanguages } = await import('shiki');
    const wanted = new Set();
    for (const p of pages) for (const f of p.fences) {
      const l = fenceLang(f);
      if (l && bundledLanguages[l] && !(code.outputLangs || []).includes(l)) wanted.add(l);
    }
    const hl = await createHighlighter({ themes: [code.theme], langs: [...wanted] });
    for (const p of pages) for (const f of p.fences) {
      const l = fenceLang(f);
      if (!wanted.has(l)) continue;
      let html = hl.codeToHtml(f.content.replace(/\n$/, ''), { lang: l, theme: code.theme });
      html = html
        .replace(/^<pre class="[^"]*"/, `<pre ${cls('code')}`)
        .replace(' tabindex="0"', '')
        .replace(/<span class="line">/g, '<span>');
      if (code.background) html = html.replace(/background-color:#[0-9a-fA-F]+/, `background-color:${code.background}`);
      f.meta = { html };
    }
  }

  function renderBody(analyzed, env) {
    env.inSection = false;
    env.figure = 0;
    const first = analyzed.tokens[0];
    let html = '';
    if (first && !(first.meta && first.meta.sectionId) && !/^container_/.test(first.type)) {
      html += `<div ${cls('section intro')}>\n`;
      env.inSection = true;
    }
    html += md.renderer.render(analyzed.tokens, md.options, env);
    if (env.inSection) html += '</div>\n';
    return html;
  }

  return { analyze, highlight, renderBody, px };
}

module.exports = { createRenderer, slugify, esc };
