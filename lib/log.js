'use strict';
// One logger for everything sync.js and convert-pdf.js report.
//
// Human mode (default) prints exactly the text the tool has always printed, on the same stream.
// JSON mode (--json) writes one JSON object per line to stdout and nothing else, for programs that
// drive the tool (see README "Machine-readable output"). Every call passes both: the structured
// event and the human text.

let json = false;
let contentDir = 'content';

function configure(o = {}) {
  if (o.json !== undefined) json = !!o.json;
  if (o.contentDir) contentDir = String(o.contentDir).replace(/\/+$/, '');
}

const isJson = () => json;

// Content files are known to the tool by their bare name (module-1.md); events use the path
// relative to the project root (content/module-1.md).
const contentPath = (file) => (file ? `${contentDir}/${file}` : null);

function emit(event) {
  process.stdout.write(JSON.stringify(event) + '\n');
}

/** { file, line, code, message }: file relative to the project root, line 1-based or null. */
function warning({ file = null, line = null, code, message }, human) {
  if (json) return emit({ type: 'warning', file, line: line ?? null, code, message });
  console.warn(human);
}

/** A step of the run; JSON only (the human log never had these). */
function progress(step, message) {
  if (json) emit({ type: 'progress', step, message });
}

/**
 * An informational line: the human text, or in JSON a progress event (step "note" unless given).
 * o.message defaults to the human text without its indent and "note:" prefix.
 */
function note(human, o = {}) {
  if (json) return emit({ type: 'progress', step: o.step || 'note', message: o.message || human.replace(/^\s*(note:\s*)?/, '') });
  console.log(human);
}

/** { file, action: created|adopted|renamed|updated|skipped, url } */
function page({ file, action, url }, human) {
  if (json) return emit({ type: 'page', file, action, url });
  if (human) console.log(human);
}

/** { key, action: created|updated|unchanged|recreated, url } */
function quiz({ key, action, url }, human) {
  if (json) return emit({ type: 'quiz', key, action, url });
  if (human) console.log(human);
}

/** { path, action: uploaded|unchanged, url } */
function file({ path, action, url }, human) {
  if (json) return emit({ type: 'file', path, action, url });
  if (human) console.log(human);
}

/** { kind: quiz|page, key?, file?, url }: exists in Canvas, no longer in the Markdown. */
function orphan(event, human) {
  if (json) return emit({ type: 'orphan', ...event });
  console.log(human);
}

/** Final error (followed by exit code 1). */
function error(err) {
  if (!json) return console.error((err && err.message) || err);
  const text = String((err && err.message) || err);
  const [first, ...rest] = text.split('\n');
  emit({
    type: 'error',
    message: first,
    code: (err && err.toolCode) || (err && err.network ? 'network' : err && err.status ? 'canvas-http' : 'unknown'),
    hint: (err && err.hint) || rest.map((l) => l.trim()).filter(Boolean).join(' ') || null,
    ...(err && err.status ? { status: err.status } : {}),
  });
}

/** Summary, always the last line of a successful run. */
function result(summary, human) {
  if (json) return emit({ type: 'result', ...summary });
  console.log(human);
}

/** An Error with a stable code (and optional hint) for the JSON error event. */
function toolError(message, code, hint) {
  const e = new Error(message);
  e.toolCode = code;
  if (hint) e.hint = hint;
  return e;
}

module.exports = {
  configure, isJson, contentPath, warning, progress, note, page, quiz, file, orphan, error, result, toolError,
};
