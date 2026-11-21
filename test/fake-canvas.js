'use strict';
// A tiny in-memory Canvas for tests: just the page endpoints sync.js uses
// (list, create, update incl. front_page). Every request is recorded.

const http = require('http');

function slug(title) {
  return String(title).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function startFakeCanvas({ courseId = 1, pages: initial = [] } = {}) {
  let nextId = 100;
  const pages = initial.map((p) => ({ page_id: nextId++, url: slug(p.title), published: false, front_page: false, ...p }));
  const requests = [];
  const base = `/api/v1/courses/${courseId}/pages`;

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://fake');
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, path: url.pathname, body, auth: req.headers.authorization });
      const send = (status, data) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      };

      if (req.method === 'GET' && url.pathname === base) return send(200, pages);
      if (req.method === 'POST' && url.pathname === base) {
        const w = body.wiki_page;
        const page = { page_id: nextId++, url: slug(w.title), title: w.title, body: w.body, published: !!w.published, front_page: false };
        pages.push(page);
        return send(200, page);
      }
      if (req.method === 'PUT' && url.pathname.startsWith(`${base}/`)) {
        const page = pages.find((p) => p.url === decodeURIComponent(url.pathname.slice(base.length + 1)));
        if (!page) return send(404, { errors: [{ message: 'page not found' }] });
        const w = body.wiki_page;
        if (w.title !== undefined && w.title !== page.title) { page.title = w.title; page.url = slug(w.title); }
        if (w.body !== undefined) page.body = w.body;
        if (w.published !== undefined) page.published = w.published;
        if (w.front_page) {
          if (!page.published) return send(400, { errors: [{ message: 'The front page cannot be unpublished' }] });
          for (const p of pages) p.front_page = false;
          page.front_page = true;
        }
        return send(200, page);
      }
      send(404, { errors: [{ message: `not implemented in fake: ${req.method} ${url.pathname}` }] });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    courseId,
    pages,
    requests,
    frontPageRequests: () => requests.filter((r) => r.method === 'PUT' && r.body && r.body.wiki_page && r.body.wiki_page.front_page),
    reset() { requests.length = 0; },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startFakeCanvas };
