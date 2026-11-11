'use strict';
// "Test jezelf" questions as printable text for convert-pdf.js. NEVER prints answers or feedback:
// Juist, Feedback*, the pairing of matching items and the correct order are all left out, and
// everything that has a "right" order is shown in a scrambled, deterministic order.

const crypto = require('crypto');
const MarkdownIt = require('markdown-it');

const mdInline = new MarkdownIt({ html: false, linkify: false, typographer: false });
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Deterministic scramble (same PDF every run). Never returns the input order.
function scramble(items, seed) {
  const h = (s) => crypto.createHash('sha1').update(`${seed}|${s}`).digest('hex');
  const out = [...items].sort((a, b) => h(a).localeCompare(h(b)));
  if (items.length > 1 && out.every((x, i) => x === items[i])) out.push(out.shift());
  return out;
}

const HINTS = {
  'meerkeuze': 'Kies één antwoord.',
  'meerdere antwoorden': 'Kies alle juiste antwoorden.',
  'juist/fout': 'Kies juist of fout.',
  'koppelen': 'Schrijf bij elk nummer de letter van het juiste antwoord.',
  'ordenen': 'Zet in de juiste volgorde: schrijf 1, 2, 3, … in de vakjes.',
  'categoriseren': 'Schrijf bij elk item de juiste categorie. Niet elk item hoeft bij een categorie te horen.',
  'dropdown': 'Kies bij elke keuze de juiste optie.',
  'woordenbank': 'Vul de lege plekken in met woorden uit de woordenbank.',
  'invullen': 'Vul het antwoord in.',
  'numeriek': 'Geef een getal als antwoord.',
};

function renderQuizText(quiz, { px, note }) {
  const cls = (c) => `class="${esc(px(c))}"`;
  const inl = (s) => mdInline.renderInline(String(s || ''))
    .replace(/<code>/g, `<span ${cls('mono')}>`).replace(/<\/code>/g, '</span>');
  const line = () => `<span ${cls('pdf_line')}></span>`;
  const box = (round) => `<span ${cls(round ? 'pdf_box pdf_box_round' : 'pdf_box')}></span>`;
  const opt = (mark, label, text) =>
    `<div ${cls('pdf_opt')}>${mark}${label ? `<span ${cls('pdf_opt_label')}>${esc(label)}</span>` : ''}<span>${text}</span></div>`;

  const questions = quiz.questions.map((q, i) => {
    const seed = `${quiz.key}#${i}`;
    let body = '';
    let text = q.question;

    // Blanks in the question text: dropdown shows the choices, the others show an empty line.
    const blankRe = /\[\[([^\]]+)\]\]/g;
    let words = [];
    if (/\[\[/.test(text)) {
      let out = '';
      let last = 0;
      let m;
      let n = 0;
      while ((m = blankRe.exec(text))) {
        out += inl(text.slice(last, m.index));
        const choices = m[1].split('|').map((s) => s.trim().replace(/^\*/, '').trim());
        if (q.type === 'dropdown') {
          out += `<span ${cls('pdf_choice')}>${scramble(choices, `${seed}-${n}`).map(esc).join(' / ')}</span>`;
        } else {
          words.push(choices[0]);
          out += `<span ${cls('pdf_blank')}></span>`;
        }
        last = m.index + m[0].length;
        n++;
      }
      out += inl(text.slice(last));
      text = out;
    } else {
      text = inl(text);
    }

    const code = q.code
      ? `<div ${cls('codeblock')}><pre ${cls('code')}>${esc(q.code)}</pre></div>` : '';

    switch (q.type) {
      case 'meerkeuze':
        body = q.options.map((o) => opt(box(true), `${o.letter}.`, inl(o.text))).join('');
        break;
      case 'meerdere antwoorden':
        body = q.options.map((o) => opt(box(false), `${o.letter}.`, inl(o.text))).join('');
        break;
      case 'juist/fout':
        body = `<div ${cls('pdf_inline_opts')}>${opt(box(true), '', 'Juist')}${opt(box(true), '', 'Fout')}</div>`;
        break;
      case 'koppelen': {
        const right = scramble(q.pairs.map((p) => p[1]), seed);
        body = `<div ${cls('pdf_cols')}><div>`
          + q.pairs.map((p, k) => opt(`<span ${cls('pdf_num')}>${k + 1}</span>`, '', inl(p[0]) + ` ${line()}`)).join('')
          + '</div><div>'
          + right.map((r, k) => opt('', `${String.fromCharCode(65 + k)}.`, inl(r))).join('')
          + '</div></div>';
        break;
      }
      case 'ordenen':
        body = scramble(q.order, seed).map((s) => opt(`<span ${cls('pdf_write')}></span>`, '', inl(s))).join('');
        break;
      case 'categoriseren': {
        const cats = [...new Set(q.categorized.map((c) => c[1]))];
        const items = scramble([...q.categorized.map((c) => c[0]), ...q.distractors], seed);
        body = `<div ${cls('pdf_bank')}><strong>Categorieën:</strong> ${scramble(cats, `${seed}-c`).map((c) => `<span>${inl(c)}</span>`).join('')}</div>`
          + items.map((s) => opt('', '', inl(s) + ` ${line()}`)).join('');
        break;
      }
      case 'woordenbank': {
        const bank = [...new Set([...words, ...q.distractors])].sort((a, b) => a.localeCompare(b, 'nl'));
        body = `<div ${cls('pdf_bank')}><strong>Woordenbank:</strong> ${bank.map((w) => `<span>${esc(w)}</span>`).join('')}</div>`;
        break;
      }
      case 'invullen':
        body = /\[\[/.test(q.question) ? '' : `<div ${cls('pdf_answer')}>Antwoord: ${line()}</div>`;
        break;
      case 'numeriek':
        body = `<div ${cls('pdf_answer')}>Antwoord: ${line()}</div>`;
        break;
      default:
        break; // unknown type: only the question text
    }

    const hint = HINTS[q.type] ? `<div ${cls('pdf_hint')}>${esc(HINTS[q.type])}</div>` : '';
    return `<div ${cls('pdf_q')}>\n<div ${cls('pdf_q_head')}><span ${cls('pdf_q_num')}>${i + 1}</span>`
      + `<div ${cls('pdf_q_text')}>${text}</div></div>\n${code}${hint}\n<div ${cls('pdf_q_body')}>${body}</div>\n</div>\n`;
  }).join('');

  const count = quiz.questions.length;
  return `<div ${cls('pdf_quiz')}>\n<div ${cls('pdf_quiz_head')}><span>${esc(quiz.title)}</span>`
    + `<span ${cls('pdf_quiz_count')}>${count} ${count === 1 ? 'vraag' : 'vragen'}</span></div>\n`
    + questions
    + (note ? `<div ${cls('pdf_quiz_note')}>${esc(note)}</div>\n` : '')
    + '</div>\n';
}

module.exports = { renderQuizText, scramble };
