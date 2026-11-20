'use strict';
// Loads course.config.json and fills in defaults, so a course whose config predates a feature
// still gets it. Values a course sets itself always win; the file itself is never changed.

const fs = require('fs');
const path = require('path');

// Block logos used when a block has no logo of its own ("logo" missing or null).
// "logo": false (or "") means: no icon. A default only applies when its file exists.
const DEFAULT_LOGOS = {
  quiz: 'assets/icons/quiz.svg',
};

// Callouts the tool always knows. A course's "callouts" list is extended with these, never
// shortened: an unregistered "::: story" would otherwise show up as plain text on the page.
const DEFAULT_CALLOUTS = ['tip', 'info', 'warning', 'story'];

// Icon per callout, used when calloutIcons has no entry for it ("" in the config: no icon).
const DEFAULT_CALLOUT_ICONS = { tip: '💡', info: 'ℹ️', warning: '⚠️', story: '📖' };

// Text label per header variant ## Titel {.easy}, used when variantLabels has no entry for it.
// Without a label the level would only be shown by colour.
const DEFAULT_VARIANT_LABELS = {
  easy: 'Easy', medium: 'Medium', hard: 'Hard', home: '@Home', extra: 'Extra', case: 'Case', letop: 'Let op',
};

const fillMissing = (target, defaults) => {
  for (const [k, v] of Object.entries(defaults)) if (target[k] === undefined || target[k] === null) target[k] = v;
  return target;
};

function applyDefaults(config, root) {
  config.blocks = config.blocks || {};
  for (const [name, logo] of Object.entries(DEFAULT_LOGOS)) {
    const block = config.blocks[name] = config.blocks[name] || {};
    if (block.logo === undefined || block.logo === null) {
      if (fs.existsSync(path.join(root, logo))) block.logo = logo;
    } else if (block.logo === false || block.logo === '') {
      block.logo = null; // explicitly no icon
    }
  }

  const callouts = Array.isArray(config.callouts) ? config.callouts : [];
  config.callouts = [...new Set([...callouts, ...DEFAULT_CALLOUTS])];
  config.calloutIcons = fillMissing({ ...(config.calloutIcons || {}) }, DEFAULT_CALLOUT_ICONS);
  config.variantLabels = fillMissing({ ...(config.variantLabels || {}) }, DEFAULT_VARIANT_LABELS);
  return config;
}

function loadConfig(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'course.config.json'), 'utf8'));
  return applyDefaults(config, root);
}

module.exports = {
  loadConfig, applyDefaults, DEFAULT_LOGOS, DEFAULT_CALLOUTS, DEFAULT_CALLOUT_ICONS, DEFAULT_VARIANT_LABELS,
};
