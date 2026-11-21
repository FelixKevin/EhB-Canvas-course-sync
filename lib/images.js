'use strict';
// Local images and downloadable files -> Canvas course files.
//
// Markdown images ![](images/x.png), links to files [text](files/module-1/start.zip) (relative to
// content/) and local block logos (relative to the project root) are uploaded once, tracked by content hash in canvas-map.json under "_files", and re-uploaded
// only when the file changes. Pages then point at <course>/files/<id>/preview, the same URL the
// Canvas editor uses for embedded images.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const log = require('./log');

const TYPES = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.webp': 'image/webp',
};

const MIME = {
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.txt': 'text/plain', '.csv': 'text/csv',
  '.json': 'application/json', '.xml': 'application/xml', '.html': 'text/html', '.css': 'text/css',
  '.js': 'text/javascript', '.md': 'text/markdown', '.sql': 'application/sql', '.php': 'application/x-httpd-php',
  '.py': 'text/x-python', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.7z': 'application/x-7z-compressed', '.gz': 'application/gzip',
};
const mimeOf = (abs) => TYPES[path.extname(abs).toLowerCase()] || MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream';

const isLocal = (src) => !!src && !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(src);

// Dry run with --asset-base-url: <base>/<project-relative path>, keeping a ?query or #hash of the base
// after the path (signed preview URLs carry one).
function assetUrl(base, key) {
  const cut = base.search(/[?#]/);
  const head = (cut === -1 ? base : base.slice(0, cut)).replace(/\/+$/, '');
  const tail = cut === -1 ? '' : base.slice(cut);
  return `${head}/${key.split('/').map(encodeURIComponent).join('/')}${tail}`;
}

function createImages({ root, contentDir, outDir, map, config, coursePath, assetBaseUrl = null }) {
  const opts = config.files || {};
  const files = map._files || (map._files = {});
  const used = new Map(); // key -> absolute path
  const problems = [];
  const baseDirs = { content: contentDir, config: root };

  // src as written -> { key, abs } (key = path relative to the project root, forward slashes)
  function locate(src, kind) {
    if (!isLocal(src)) return null;
    const abs = path.resolve(baseDirs[kind] || contentDir, decodeURI(src.split(/[?#]/)[0]));
    const key = path.relative(root, abs).split(path.sep).join('/');
    return { key, abs };
  }

  // Phase 1: check every referenced file exists (and, for images, is an image).
  // what = 'image' (default) or 'file' (a link the student can download).
  // line: 1-based line in the Markdown file (for the JSON warning), when known.
  function collect(src, kind, where, what = 'image', line = null) {
    const loc = locate(src, kind);
    if (!loc) return;
    const [problem, code] = loc.key.startsWith('..') ? [`${what} outside the project`, `${what}-outside-project`]
      : !fs.existsSync(loc.abs) ? [`${what} not found`, `${what}-missing`]
      : fs.statSync(loc.abs).isDirectory() ? ['is a folder, not a file', `${what}-is-folder`]
      : what === 'image' && !TYPES[path.extname(loc.abs).toLowerCase()] ? ['not a supported image type (png, jpg, gif, svg, webp)', 'image-unsupported']
      : [null, null];
    if (problem) {
      problems.push(`${where}: ${problem}: ${src}`);
      const file = kind === 'content' ? log.contentPath(where) : 'course.config.json';
      return log.warning({ file, line: kind === 'content' ? line : null, code, message: `${kind === 'content' ? '' : `${where}: `}${problem}: ${src}` },
        `  ! ${where}: ${problem}: ${src}`);
    }
    used.set(loc.key, loc.abs);
  }

  // Phase 2: upload new or changed files.
  async function upload(canvas, saveMap) {
    let uploaded = 0;
    for (const [key, abs] of used) {
      const buffer = fs.readFileSync(abs);
      const hash = crypto.createHash('sha256').update(buffer).digest('hex');
      if (files[key]?.hash === hash) {
        log.file({ path: key, action: 'unchanged', url: files[key].url });
        continue;
      }

      const folder = [opts.folder || 'course-sync', path.posix.dirname(key)].filter((s) => s && s !== '.').join('/');
      const file = await canvas.uploadFile(config.courseId, {
        name: path.basename(abs), buffer, contentType: mimeOf(abs), folder,
      });
      if (opts.usageRights) await canvas.setUsageRights(config.courseId, [file.id], opts.usageRights);
      if (opts.hidden) await canvas.updateFile(file.id, { hidden: true });

      files[key] = { hash, id: file.id, url: `${coursePath}/files/${file.id}/preview` };
      saveMap();
      uploaded++;
      log.file({ path: key, action: 'uploaded', url: files[key].url }, `  uploaded ${key} -> file ${file.id}`);
    }
    return uploaded;
  }

  // Render time: src as written -> URL for the page. Dry run: a path the local preview can open.
  // as 'file' gives the download URL of a linked file instead of the image preview URL.
  function resolve(src, kind, dry, as = 'image') {
    const loc = locate(src, kind);
    if (!loc || !used.has(loc.key)) return src;
    if (dry) return assetBaseUrl ? assetUrl(assetBaseUrl, loc.key) : path.relative(outDir, loc.abs).split(path.sep).join('/');
    if (as === 'file') {
      const f = files[loc.key];
      if (!f) return src;
      return opts.linkStyle === 'preview' ? `${coursePath}/files/${f.id}?wrap=1` : `${coursePath}/files/${f.id}/download?download_frd=1`;
    }
    return files[loc.key]?.url || src;
  }

  return { collect, upload, resolve, count: () => used.size, problems };
}

module.exports = { createImages, assetUrl };
