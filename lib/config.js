'use strict';
// Loads course.config.json and fills in defaults that depend on files shipped with the tool.

const fs = require('fs');
const path = require('path');

// Block logos used when a block has no logo of its own ("logo" missing or null).
// "logo": false (or "") means: no icon. A default only applies when its file exists.
const DEFAULT_LOGOS = {
  quiz: 'assets/icons/quiz.svg',
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
  return config;
}

function loadConfig(root) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'course.config.json'), 'utf8'));
  return applyDefaults(config, root);
}

module.exports = { loadConfig, applyDefaults, DEFAULT_LOGOS };
