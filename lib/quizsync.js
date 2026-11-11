'use strict';
// Creates or updates one Canvas New Quiz per "Test jezelf" block.
// canvas-map.json "_quizzes": { "<file>#<heading-id>": { id, url, hash } }
//
// Unchanged quizzes are skipped (hash of the full payload + publish state). A changed quiz keeps
// its id and URL: its settings are updated and its questions are replaced.

const crypto = require('crypto');
const { buildPayload } = require('./quiz');

async function syncQuizzes({ canvas, config, map, saveMap, quizzes, pageOf, sectionHref, coursePath, only, force, log }) {
  const opts = quizOptions(config);
  const store = map._quizzes || (map._quizzes = {});
  const stats = { created: 0, updated: 0, unchanged: 0 };

  const todo = quizzes.filter((q) => !only || q.file === only);
  let groupId = null;
  if (todo.length && opts.assignmentGroup) {
    groupId = (await canvas.findOrCreateAssignmentGroup(config.courseId, opts.assignmentGroup)).id;
  }

  for (const parsed of todo) {
    const page = pageOf(parsed.file);
    const published = page.fm.published === true;
    const { quiz, items } = buildPayload(parsed, { opts, sectionHref });
    if (groupId) quiz.assignment_group_id = groupId;
    const hash = crypto.createHash('sha256').update(JSON.stringify({ quiz, items, published, omit: opts.omitFromFinalGrade })).digest('hex');

    let entry = store[parsed.key];
    if (entry && !(await canvas.getQuiz(config.courseId, entry.id))) {
      log(`  ! quiz "${parsed.title}" (${entry.id}) was deleted in Canvas; creating it again`);
      entry = null;
    }
    if (entry && !force && entry.hash === hash) { stats.unchanged++; continue; }

    try {
      let id;
      if (entry) {
        id = entry.id;
        await canvas.updateQuiz(config.courseId, id, quiz);
        for (const it of (await canvas.listQuizItems(config.courseId, id)) || []) {
          await canvas.deleteQuizItem(config.courseId, id, it.id);
        }
      } else {
        id = (await canvas.createQuiz(config.courseId, quiz)).id;
        // Remember the quiz right away: if a question is refused below, the next run reuses this quiz
        // (hash null = "questions not complete") instead of creating a second, empty one.
        store[parsed.key] = { id: String(id), url: `${coursePath}/assignments/${id}`, hash: null };
        saveMap();
      }
      for (const [n, item] of items.entries()) {
        try {
          await canvas.createQuizItem(config.courseId, id, item);
        } catch (err) {
          throw new Error(`question ${n + 1} ("${plainQuestion(parsed, n)}"): ${err.message}`);
        }
      }
      await canvas.updateAssignment(config.courseId, id, { published, omit_from_final_grade: opts.omitFromFinalGrade });

      store[parsed.key] = { id: String(id), url: `${coursePath}/assignments/${id}`, hash };
      saveMap();
      stats[entry ? 'updated' : 'created']++;
      log(`  ${entry ? 'updated ' : 'created '} quiz "${parsed.title}" (${items.length} questions) -> ${store[parsed.key].url}`);
    } catch (err) {
      throw new Error(`quiz "${parsed.title}" (${parsed.file}): ${err.message}\n`
        + 'The quiz is remembered, so the next run continues with it. If students already made attempts, '
        + 'Canvas may refuse to change its questions: edit it in Canvas or give the heading a new {#id} to create a fresh quiz.');
    }
  }

  // Quizzes that are no longer in the Markdown are left alone in Canvas, but reported.
  const seen = new Set(quizzes.map((q) => q.key));
  for (const [key, e] of Object.entries(store)) {
    if (!seen.has(key) && (!only || key.startsWith(`${only}#`))) {
      log(`  ! quiz ${key} is no longer in the Markdown; it still exists in Canvas (${e.url}). Delete it there if it is not needed.`);
    }
  }
  return stats;
}

function plainQuestion(parsed, n) {
  const q = parsed.questions[n];
  return String((q && q.question) || '').replace(/\s+/g, ' ').slice(0, 70);
}

function quizOptions(config) {
  const q = config.quizzes || {};
  return {
    assignmentGroup: q.assignmentGroup === undefined ? 'Test jezelf' : q.assignmentGroup,
    pointsPerQuestion: q.pointsPerQuestion || 1,
    shuffleChoices: q.shuffleChoices !== false,
    multiAnswerScoring: q.multiAnswerScoring || 'PartialScore',
    matchingScoring: q.matchingScoring || 'PartialDeep',
    omitFromFinalGrade: q.omitFromFinalGrade !== false,
    instructions: q.instructions === undefined
      ? '<p>Deze test telt niet mee voor je punten. Je kan hem zo vaak maken als je wil. Na het indienen zie je bij elke vraag of je antwoord juist is, met uitleg.</p>'
      : q.instructions,
    addAnswerHint: q.addAnswerHint !== false,
  };
}

module.exports = { syncQuizzes, quizOptions };
