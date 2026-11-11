'use strict';
// "Test jezelf" blocks -> Canvas New Quizzes items.
//
// Input: the text of ```text blocks in the Schrijfwijzer quiz format (one or more questions per
// block, each starting with "Sectie:" or "Type:"). Output: New Quizzes API item payloads.
// IDs are derived from the quiz key, so the same Markdown always gives the same payload (and hash).

const crypto = require('crypto');
const MarkdownIt = require('markdown-it');

const mdInline = new MarkdownIt({ html: false, linkify: false, typographer: false });
const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Markdown inline (`code`, **vet**) -> HTML, and -> plain text (for fields Canvas shows as text).
// Apostrophes inside code are written as &#39; (same text on screen). Some firewalls in front of Canvas
// answer "403 Forbidden" to request bodies that contain SQL-injection text such as ' OR '1'='1.
const encCode = (s) => String(s).replace(/'/g, '&#39;');
const encInlineCode = (html) => html.replace(/<code>([\s\S]*?)<\/code>/g, (m, c) => `<code>${encCode(c)}</code>`);
const inlineHtml = (s) => encInlineCode(mdInline.renderInline(String(s || '').trim()));
const inlineKeepSpaces = (s) => encInlineCode(mdInline.renderInline(String(s || ''))); // text around fill-in blanks
const plain = (s) => String(s || '').trim().replace(/`([^`]*)`/g, '$1').replace(/\*\*([^*]+)\*\*/g, '$1');

// Deterministic UUID (v4 layout) from a seed.
function uuid(seed) {
  const h = crypto.createHash('sha256').update(seed).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[parseInt(h[16], 16) % 4]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---------------------------------------------------------------------------------------------
// Parsing

const TYPE_ALIASES = {
  'meerkeuze': 'meerkeuze',
  'meerdere antwoorden': 'meerdere antwoorden',
  'juist/fout': 'juist/fout', 'waar/onwaar': 'juist/fout',
  'koppelen': 'koppelen',
  'ordenen': 'ordenen',
  'categoriseren': 'categoriseren',
  'dropdown': 'dropdown',
  'woordenbank': 'woordenbank',
  'numeriek': 'numeriek',
  'invullen': 'invullen',
};
const EXPERIMENTAL = new Set(['dropdown', 'woordenbank', 'invullen']);

// Keys at the start of a line (column 0). Everything else continues the previous key.
const KEY_RE = /^(Sectie|Type|Vraag|Code|Opties|Juist|Paren|Volgorde|Indeling|Afleiders|Feedback bij juist antwoord|Feedback bij fout antwoord|Feedback(?:\s+[A-Z])?)\s*:\s?(.*)$/;

function splitQuestions(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const starter = lines.some((l) => /^Sectie\s*:/.test(l)) ? /^Sectie\s*:/ : /^Type\s*:/;
  const chunks = [];
  let cur = null;
  for (const line of lines) {
    if (starter.test(line)) { cur = []; chunks.push(cur); }
    if (cur) cur.push(line);
  }
  return chunks.map((c) => c.join('\n'));
}

function parseQuestion(text) {
  const fields = {};
  const order = [];
  let key = null;
  for (const raw of text.split('\n')) {
    const m = raw.match(KEY_RE);
    if (m) {
      key = m[1].replace(/\s+/g, ' ');
      if (!(key in fields)) order.push(key);
      fields[key] = { value: m[2], lines: [] };
    } else if (key) {
      fields[key].lines.push(raw);
    }
  }
  const val = (k) => (fields[k] ? fields[k].value.trim() : '');
  const block = (k) => (fields[k] ? fields[k].lines : []);
  const listOf = (k) => {
    const items = block(k).map((l) => l.trim()).filter(Boolean);
    const inline = val(k);
    if (inline) items.unshift(...inline.split('|').map((s) => s.trim()).filter(Boolean));
    return items;
  };
  // Multi-line text field: first line + continuation lines.
  const text_ = (k) => [val(k), ...block(k).map((l) => l.trim())].filter(Boolean).join(' ');

  const rawType = val('Type');
  const typeName = rawType.replace(/\(.*\)/, '').trim().toLowerCase();
  const q = {
    section: val('Sectie'),
    rawType,
    type: TYPE_ALIASES[typeName] || null,
    question: text_('Vraag'),
    code: dedent(block('Code')),
    correct: text_('Juist'),
    feedback: text_('Feedback'),
    feedbackCorrect: text_('Feedback bij juist antwoord'),
    feedbackIncorrect: text_('Feedback bij fout antwoord'),
    optionFeedback: {},
    options: [],
    pairs: [],
    order: listOf('Volgorde').map((s) => s.replace(/^(\d+[.)]|[-*])\s+/, '')),
    categorized: [],
    distractors: listOf('Afleiders'),
  };
  for (const k of order) {
    const m = k.match(/^Feedback ([A-Z])$/);
    if (m) q.optionFeedback[m[1]] = text_(k);
  }
  for (const line of block('Opties').map((l) => l.trim()).filter(Boolean)) {
    const m = line.match(/^([A-Z])[.)]\s+(.*)$/);
    if (m) q.options.push({ letter: m[1], text: m[2] });
    else if (q.options.length) q.options[q.options.length - 1].text += ' ' + line;
  }
  const arrow = (line) => {
    const m = line.match(/^(.*?)\s*(?:→|->)\s*(.*)$/);
    return m ? [m[1].trim(), m[2].trim()] : null;
  };
  q.pairs = block('Paren').map((l) => l.trim()).filter(Boolean).map(arrow).filter(Boolean);
  q.categorized = block('Indeling').map((l) => l.trim()).filter(Boolean).map(arrow).filter(Boolean);
  return q;
}

function dedent(lines) {
  const ls = [...lines];
  while (ls.length && !ls[ls.length - 1].trim()) ls.pop();
  while (ls.length && !ls[0].trim()) ls.shift();
  const indent = Math.min(...ls.filter((l) => l.trim()).map((l) => l.match(/^\s*/)[0].length), Infinity);
  return ls.map((l) => l.slice(Number.isFinite(indent) ? indent : 0)).join('\n');
}

// ---------------------------------------------------------------------------------------------
// Validation: returns a list of problems (strings) for one question.

function validate(q) {
  const p = [];
  if (!q.type) return [`unknown type "${q.rawType}" (use: ${Object.keys(TYPE_ALIASES).join(', ')})`];
  if (!q.question) p.push('Vraag is missing');
  const letters = q.options.map((o) => o.letter);
  const correctLetters = q.correct.split(',').map((s) => s.trim()).filter(Boolean);
  switch (q.type) {
    case 'meerkeuze':
    case 'meerdere antwoorden':
      if (q.options.length < 2) p.push('needs at least 2 Opties (A. ..., B. ...)');
      if (!correctLetters.length) p.push('Juist is missing');
      for (const c of correctLetters) if (!letters.includes(c)) p.push(`Juist "${c}" is not one of the options`);
      if (q.type === 'meerkeuze' && correctLetters.length !== 1) p.push('meerkeuze needs exactly one correct letter');
      for (const l of letters) if (!q.optionFeedback[l] && !q.feedback) p.push(`Feedback ${l} is missing`);
      break;
    case 'juist/fout':
      if (parseBool(q.correct) === null) p.push('Juist must be "juist" or "fout"');
      break;
    case 'koppelen':
      if (q.pairs.length < 2) p.push('needs at least 2 Paren (left → right)');
      break;
    case 'ordenen':
      if (q.order.length < 2) p.push('needs at least 2 lines under Volgorde, in the correct order');
      break;
    case 'categoriseren':
      if (q.categorized.length < 2) p.push('needs at least 2 lines under Indeling (item → category)');
      break;
    case 'numeriek':
      if (!parseNumeric(q.correct)) p.push(`Juist "${q.correct}" is not a number, "x ± y", "x ± y %" or "x tot y"`);
      break;
    case 'dropdown':
      if (!blanksIn(q.question).length) p.push('Vraag needs at least one [[*correct|wrong|wrong]] blank');
      for (const b of blanksIn(q.question)) if (b.options.filter((o) => o.correct).length !== 1) p.push(`blank [[${b.raw}]] needs exactly one * (the correct option)`);
      break;
    case 'woordenbank':
      if (!blanksIn(q.question).length) p.push('Vraag needs at least one [[word]] blank');
      break;
    case 'invullen':
      if (!q.correct && !blanksIn(q.question).length) p.push('Juist is missing (variants separated by |)');
      break;
    default:
  }
  if (q.type !== 'meerkeuze' && !q.feedback && !q.feedbackCorrect && !q.feedbackIncorrect && !Object.keys(q.optionFeedback).length) {
    p.push('Feedback is missing');
  }
  return p;
}

function parseBool(s) {
  const v = String(s).trim().toLowerCase();
  if (['juist', 'waar', 'true'].includes(v)) return true;
  if (['fout', 'onwaar', 'false'].includes(v)) return false;
  return null;
}

// "1" | "3,5" | "1,5 ± 0,1" | "10 ± 5 %" | "190 tot 210" | "190..210"; several separated by "|".
function parseNumeric(s) {
  const num = (x) => x.trim().replace(/\s/g, '').replace(',', '.');
  const isNum = (x) => /^-?\d+(\.\d+)?$/.test(x);
  const out = [];
  for (const part of String(s).split('|').map((x) => x.trim()).filter(Boolean)) {
    let m;
    if ((m = part.match(/^(-?[\d.,\s]+?)\s*(?:±|\+\/-)\s*([\d.,]+)\s*(%?)$/)) && isNum(num(m[1])) && isNum(num(m[2]))) {
      out.push({ type: 'marginOfError', value: num(m[1]), margin: num(m[2]), margin_type: m[3] ? 'percent' : 'absolute' });
    } else if ((m = part.match(/^(-?[\d.,]+)\s*(?:\.\.|tot)\s*(-?[\d.,]+)$/)) && isNum(num(m[1])) && isNum(num(m[2]))) {
      out.push({ type: 'withinARange', start: num(m[1]), end: num(m[2]) });
    } else if (isNum(num(part))) {
      out.push({ type: 'exactResponse', value: num(part) });
    } else {
      return null;
    }
  }
  return out.length ? out : null;
}

// [[*a|b|c]] (dropdown), [[word]] (word bank / fill in)
function blanksIn(text) {
  const out = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let m;
  while ((m = re.exec(text))) {
    const options = m[1].split('|').map((s) => s.trim()).map((s) => ({ text: s.replace(/^\*/, '').trim(), correct: s.startsWith('*') }));
    out.push({ raw: m[1], options, index: m.index, length: m[0].length });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Building New Quizzes items

function buildItem(q, { seed, position, opts, linkSections }) {
  const id = (role) => uuid(`${seed}|${position}|${role}`);
  const fb = (s) => (s ? linkSections(inlineHtml(s)) : '');
  const p = (html) => (html ? `<p>${html}</p>` : '');

  // Q7: students must see whether one or several answers are correct. The "(één antwoord is juist)"
  // after Type is only visible to authors, so the hint is added to the question when it is missing.
  let question = q.question;
  if (opts.addAnswerHint !== false) {
    if (q.type === 'meerkeuze' && !/kies\s+één|één\s+(juist\s+)?antwoord/i.test(question)) question += ' Kies één antwoord.';
    if (q.type === 'meerdere antwoorden' && !/meerdere|alle\s+juiste/i.test(question)) question += ' Kies alle juiste antwoorden.';
  }
  let stem = p(inlineHtml(question));
  if (q.code) stem += `<pre><code>${encCode(escHtml(q.code))}</code></pre>`;

  const entry = {
    interaction_type_slug: null,
    title: `Vraag ${position}`,
    item_body: stem,
    calculator_type: 'none',
    feedback: { neutral: p(fb(q.feedback)), correct: p(fb(q.feedbackCorrect)), incorrect: p(fb(q.feedbackIncorrect)) },
  };

  switch (q.type) {
    case 'meerkeuze': {
      const choices = q.options.map((o, i) => ({ id: id(`choice-${o.letter}`), position: i + 1, item_body: p(inlineHtml(o.text)) }));
      const correct = choices[q.options.findIndex((o) => o.letter === q.correct.trim())];
      Object.assign(entry, {
        interaction_type_slug: 'choice',
        interaction_data: { choices },
        properties: { shuffle_rules: { choices: { to_lock: [], shuffled: opts.shuffleChoices } }, vary_points_by_answer: false },
        scoring_data: { value: correct.id },
        scoring_algorithm: 'Equivalence',
        answer_feedback: Object.fromEntries(q.options.map((o, i) => [choices[i].id, p(fb(q.optionFeedback[o.letter]))])),
      });
      break;
    }
    case 'meerdere antwoorden': {
      const choices = q.options.map((o, i) => ({ id: id(`choice-${o.letter}`), position: i + 1, item_body: p(inlineHtml(o.text)) }));
      const correct = q.correct.split(',').map((s) => s.trim());
      Object.assign(entry, {
        interaction_type_slug: 'multi-answer',
        interaction_data: { choices },
        properties: { shuffle_rules: { choices: { to_lock: [], shuffled: opts.shuffleChoices } } },
        scoring_data: { value: q.options.map((o, i) => (correct.includes(o.letter) ? choices[i].id : null)).filter(Boolean) },
        scoring_algorithm: opts.multiAnswerScoring,
      });
      // Per-answer feedback is not supported for this type: show it all after the attempt.
      entry.feedback.neutral += optionFeedbackList(q, fb);
      break;
    }
    case 'juist/fout':
      Object.assign(entry, {
        interaction_type_slug: 'true-false',
        interaction_data: { true_choice: 'Juist', false_choice: 'Fout' },
        properties: {},
        scoring_data: { value: parseBool(q.correct) },
        scoring_algorithm: 'Equivalence',
      });
      entry.feedback.neutral += optionFeedbackList(q, fb);
      break;
    case 'koppelen': {
      const questions = q.pairs.map(([left], i) => ({ id: id(`match-${i}`), item_body: plain(left) }));
      const answers = [...new Set([...q.pairs.map(([, right]) => plain(right)), ...q.distractors.map(plain)])];
      Object.assign(entry, {
        interaction_type_slug: 'matching',
        interaction_data: { answers, questions },
        properties: { shuffle_rules: { questions: { shuffled: opts.shuffleChoices } } },
        scoring_data: {
          value: Object.fromEntries(q.pairs.map(([, right], i) => [questions[i].id, plain(right)])),
          edit_data: {
            matches: q.pairs.map(([left, right], i) => ({ answer_body: plain(right), question_id: questions[i].id, question_body: plain(left) })),
            distractors: q.distractors.map(plain),
          },
        },
        scoring_algorithm: opts.matchingScoring,
      });
      break;
    }
    case 'ordenen': {
      const choices = q.order.map((text, i) => ({ id: id(`order-${i}`), item_body: p(inlineHtml(text)) }));
      Object.assign(entry, {
        interaction_type_slug: 'ordering',
        interaction_data: { choices: Object.fromEntries(choices.map((c) => [c.id, c])) },
        properties: { top_label: 'Eerst', bottom_label: 'Laatst', shuffle_rules: null, include_labels: true, display_answers_paragraph: false },
        scoring_data: { value: choices.map((c) => c.id) },
        scoring_algorithm: 'DeepEquals',
      });
      break;
    }
    case 'categoriseren': {
      const catNames = [...new Set(q.categorized.map(([, cat]) => cat))];
      const cats = catNames.map((name, i) => ({ id: id(`cat-${i}`), item_body: plain(name) }));
      const items = [...q.categorized.map(([item]) => item), ...q.distractors].map((text, i) => ({ id: id(`catitem-${i}`), item_body: plain(text) }));
      Object.assign(entry, {
        interaction_type_slug: 'categorization',
        interaction_data: {
          categories: Object.fromEntries(cats.map((c) => [c.id, c])),
          distractors: Object.fromEntries(items.map((c) => [c.id, c])),
          category_order: cats.map((c) => c.id),
        },
        properties: { shuffle_rules: { questions: { shuffled: opts.shuffleChoices } } },
        scoring_data: {
          value: cats.map((c, ci) => ({
            id: c.id,
            scoring_data: { value: q.categorized.map(([, cat], ii) => (cat === catNames[ci] ? items[ii].id : null)).filter(Boolean) },
            scoring_algorithm: 'AllOrNothing',
          })),
          score_method: 'all_or_nothing',
        },
        scoring_algorithm: 'Categorization',
      });
      break;
    }
    case 'numeriek':
      Object.assign(entry, {
        interaction_type_slug: 'numeric',
        interaction_data: {},
        properties: {},
        scoring_data: { value: parseNumeric(q.correct).map((v, i) => ({ id: id(`num-${i}`), ...v })) },
        scoring_algorithm: 'Numeric',
      });
      break;
    case 'dropdown':
    case 'woordenbank':
    case 'invullen':
      Object.assign(entry, fillBlank(q, id, opts));
      if (q.code) entry.item_body += `<pre><code>${encCode(escHtml(q.code))}</code></pre>`;
      break;
    default:
      throw new Error(`unsupported type ${q.type}`);
  }

  return { item: { entry_type: 'Item', position, points_possible: opts.pointsPerQuestion, entry } };
}

function optionFeedbackList(q, fb) {
  const letters = Object.keys(q.optionFeedback);
  if (!letters.length) return '';
  return letters.map((l) => {
    const opt = q.options.find((o) => o.letter === l);
    return `<p><strong>${opt ? `${l}. ${inlineHtml(opt.text)}` : l}</strong>: ${fb(q.optionFeedback[l])}</p>`;
  }).join('');
}

// rich-fill-blank. Blanks are written as [[...]] in Vraag; "invullen" without [[ ]] gets one blank
// at the end. Experimental: the item_body placeholder format is not documented by Instructure.
function fillBlank(q, id, opts) {
  let blanks = blanksIn(q.question);
  let question = q.question;
  if (q.type === 'invullen' && !blanks.length) {
    question = `${question}\u00a0[[${q.correct}]]`;
    blanks = blanksIn(question);
  }
  const wordBank = q.type === 'woordenbank'
    ? [...new Set([...blanks.map((b) => b.options[0].text), ...q.distractors])].map((w, i) => ({ id: id(`word-${i}`), item_body: plain(w) }))
    : [];

  const bl = blanks.map((b, i) => {
    const bid = id(`blank-${i}`);
    if (q.type === 'dropdown') {
      const choices = b.options.map((o, j) => ({ id: id(`blank-${i}-opt-${j}`), position: j + 1, item_body: plain(o.text) }));
      const right = choices[b.options.findIndex((o) => o.correct)];
      return {
        def: { id: bid, answer_type: 'dropdown', choices },
        score: { id: bid, scoring_data: { value: right.id, blank_text: right.item_body }, scoring_algorithm: 'Equivalence' },
        text: right.item_body,
      };
    }
    if (q.type === 'woordenbank') {
      const word = plain(b.options[0].text);
      const choice = wordBank.find((w) => w.item_body === word);
      return {
        def: { id: bid, answer_type: 'wordbank', choices: null },
        score: { id: bid, scoring_data: { value: word, choice_id: choice.id, blank_text: word }, scoring_algorithm: 'TextEquivalence' },
        text: word,
      };
    }
    const variants = b.options.map((o) => plain(o.text));
    return {
      def: { id: bid, answer_type: 'openEntry' },
      score: { id: bid, scoring_data: { value: variants, blank_text: variants[0] }, scoring_algorithm: 'TextInChoices' },
      text: variants[0],
    };
  });

  // Replace each [[...]] by a placeholder span (item_body) and a backticked answer (working_item_body).
  let body = '';
  let working = '';
  let last = 0;
  blanks.forEach((b, i) => {
    const before = question.slice(last, b.index);
    body += inlineKeepSpaces(before) + `<span id="blank_${bl[i].def.id}"></span>`;
    working += inlineKeepSpaces(before) + '`' + bl[i].text + '`';
    last = b.index + b.length;
  });
  body += inlineKeepSpaces(question.slice(last));
  working += inlineKeepSpaces(question.slice(last));

  const shuffleChildren = Object.fromEntries(bl.map((b, i) => [String(i), { children: b.def.answer_type === 'dropdown' ? { choices: { shuffled: opts.shuffleChoices } } : null }]));
  return {
    interaction_type_slug: 'rich-fill-blank',
    item_body: `<p>${body}</p>`,
    interaction_data: { blanks: bl.map((b) => b.def), word_bank_choices: wordBank, reuse_word_bank_choices: false },
    properties: { shuffle_rules: { blanks: { children: shuffleChildren } } },
    scoring_data: { value: bl.map((b) => b.score), working_item_body: `<p>${working}</p>` },
    scoring_algorithm: 'MultipleMethods',
  };
}

// ---------------------------------------------------------------------------------------------
// One "Test jezelf" block -> { title, questions, problems, payload(builder) }

function parseQuiz(quiz) {
  const questions = quiz.texts.flatMap(splitQuestions).map(parseQuestion);
  const problems = [];
  questions.forEach((q, i) => {
    for (const msg of validate(q)) problems.push(`${quiz.where}, question ${i + 1}: ${msg}`);
  });
  if (!questions.length) problems.push(`${quiz.where}: no questions found (each starts with "Sectie:" or "Type:")`);
  const experimental = [...new Set(questions.map((q) => q.type).filter((t) => EXPERIMENTAL.has(t)))];
  return { ...quiz, questions, problems, experimental };
}

// Rewrites "zie 1.1" / "(zie 2.4)" in feedback HTML to links to that section's page.
function sectionLinker(sectionHref) {
  return (html) => html.replace(/\b(zie\s+(?:de\s+\w+\s+in\s+)?)(\d+(?:\.\d+)+)\b/gi, (m, zie, num) => {
    const href = sectionHref(num);
    return href ? `${zie}<a href="${escHtml(href)}" target="_blank">${num}</a>` : m;
  });
}

function buildPayload(parsed, { opts, sectionHref }) {
  const linkSections = sectionLinker(sectionHref);
  const items = parsed.questions.map((q, i) => buildItem(q, { seed: parsed.key, position: i + 1, opts, linkSections }));
  const quiz = {
    title: parsed.title,
    instructions: opts.instructions || '',
    points_possible: Math.max(1, items.length * opts.pointsPerQuestion),
    grading_type: 'points',
    quiz_settings: {
      calculator_type: 'none',
      one_at_a_time_type: 'none',
      shuffle_answers: false, // per item via shuffle_rules
      shuffle_questions: false,
      has_time_limit: false,
      require_student_access_code: false,
      multiple_attempts: {
        multiple_attempts_enabled: true,
        attempt_limit: false,
        max_attempts: null,
        score_to_keep: 'latest',
        cooling_period: false,
      },
      result_view_settings: { result_view_restricted: false },
    },
  };
  return { quiz, items };
}

module.exports = { parseQuiz, buildPayload, splitQuestions, parseQuestion, parseNumeric, uuid };
