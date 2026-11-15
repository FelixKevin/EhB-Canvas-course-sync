'use strict';
// Minimal Canvas REST client (Node 18+ fetch). Only what the sync needs.

// Node's fetch reports every network problem as "TypeError: fetch failed"; the real reason
// (DNS, timeout, refused, certificate, dropped connection) is only in err.cause.
const TRANSIENT = /^(ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT)$/;
const RETRY_METHODS = new Set(['GET', 'PUT', 'DELETE']); // safe to repeat; POST/PATCH could create or change twice
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function networkCause(err) {
  let c = err && err.cause;
  if (c && Array.isArray(c.errors) && c.errors.length) c = { ...c.errors[0], code: c.code || c.errors[0].code };
  return { code: (c && (c.code || c.name)) || '', message: (c && c.message) || (err && err.message) || String(err) };
}

function hintFor(code, host) {
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) return `The name ${host} cannot be resolved: check baseUrl in course.config.json and your internet connection or VPN.`;
  if (/ECONNREFUSED/.test(code)) return `${host} refused the connection: check baseUrl (https, no port) in course.config.json.`;
  if (/TIMEOUT|ETIMEDOUT/.test(code)) return `No answer from ${host} in time: check your connection, VPN or a firewall/proxy on this network, then run the sync again.`;
  if (/ECONNRESET|EPIPE|UND_ERR_SOCKET/.test(code)) return `${host} closed the connection. Often a network hiccup (run the sync again; unchanged pages are skipped), sometimes a firewall or proxy that drops the request.`;
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS/.test(code)) return 'The TLS certificate is not trusted. On a school or company network a proxy often replaces it: '
    + 'point NODE_EXTRA_CA_CERTS at that proxy\'s root certificate (ask IT), or use another network.';
  if (process.env.HTTPS_PROXY || process.env.https_proxy) return 'HTTPS_PROXY is set, but Node\'s fetch does not use it: try without the proxy, or ask IT.';
  return 'Check your internet connection and baseUrl in course.config.json, then run the sync again.';
}

// fetch() with a readable error and, for repeatable requests, up to 3 attempts on a dropped connection.
async function send(method, url, init) {
  const { origin, pathname } = new URL(url);
  for (let attempt = 1; ; attempt++) {
    try {
      return await fetch(url, { ...init, method });
    } catch (err) {
      const { code, message } = networkCause(err);
      if (RETRY_METHODS.has(method) && TRANSIENT.test(code) && attempt < 3) {
        console.warn(`  ! ${method} ${pathname}: ${code}, retrying (${attempt + 1}/3)`);
        await sleep(1000 * attempt);
        continue;
      }
      // Query strings are left out: upload URLs carry signed parameters.
      const e = new Error(`${method} ${origin}${pathname} failed: ${message}${code ? ` (${code})` : ''}`
        + `${attempt > 1 ? ` after ${attempt} attempts` : ''}\n  ${hintFor(code, new URL(url).host)}`);
      e.cause = err;
      throw e;
    }
  }
}

class Canvas {
  constructor(baseUrl, token) {
    if (!token) throw new Error('CANVAS_TOKEN is not set (env var or .env file)');
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
  }

  async request(method, pathOrUrl, body) {
    const url = pathOrUrl.startsWith('http') ? pathOrUrl : this.baseUrl + pathOrUrl;
    const res = await send(method, url, {
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${method} ${url} -> ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
    }
    const text = await res.text();
    return { data: text ? JSON.parse(text) : null, headers: res.headers }; // DELETE may return an empty body
  }

  // Follows Canvas' Link-header pagination.
  async getAll(path) {
    let next = path + (path.includes('?') ? '&' : '?') + 'per_page=100';
    const all = [];
    while (next) {
      const { data, headers } = await this.request('GET', next);
      all.push(...data);
      const link = headers.get('link') || '';
      const m = link.split(',').find((p) => p.includes('rel="next"'));
      next = m ? m.match(/<([^>]+)>/)[1] : null;
    }
    return all;
  }

  listPages(courseId) {
    return this.getAll(`/api/v1/courses/${courseId}/pages`);
  }

  async createPage(courseId, wikiPage) {
    return (await this.request('POST', `/api/v1/courses/${courseId}/pages`, { wiki_page: wikiPage })).data;
  }

  async updatePage(courseId, url, wikiPage) {
    return (await this.request('PUT', `/api/v1/courses/${courseId}/pages/${encodeURIComponent(url)}`, { wiki_page: wikiPage })).data;
  }

  // Canvas file upload, 3 steps: 1) announce the file, 2) POST it to the upload URL Canvas returns
  // (no auth header there), 3) confirm via the redirect/Location if Canvas asks for it.
  // on_duplicate=overwrite: a changed image replaces the old one instead of piling up copies.
  async uploadFile(courseId, { name, buffer, contentType, folder }) {
    const { data: pre } = await this.request('POST', `/api/v1/courses/${courseId}/files`, {
      name, size: buffer.length, content_type: contentType, parent_folder_path: folder, on_duplicate: 'overwrite',
    });

    const form = new FormData();
    for (const [k, v] of Object.entries(pre.upload_params || {})) form.append(k, String(v));
    form.append(pre.file_param || 'file', new Blob([buffer], { type: contentType }), name);
    const res = await send('POST', pre.upload_url, { body: form, redirect: 'manual' });

    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) return (await this.request('GET', location)).data;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`upload of ${name} -> ${res.status} ${res.statusText}\n${text.slice(0, 500)}`);
    }
    const body = await res.text();
    try {
      const json = JSON.parse(body);
      if (json && json.id) return json;
    } catch { /* not JSON: fall through to Location */ }
    if (location) return (await this.request('GET', location)).data;
    throw new Error(`upload of ${name}: Canvas returned no file id`);
  }

  // Needed when the course requires copyright info before files are visible to students.
  async setUsageRights(courseId, fileIds, useJustification) {
    return (await this.request('PUT', `/api/v1/courses/${courseId}/usage_rights`, {
      file_ids: fileIds, publish: true, usage_rights: { use_justification: useJustification },
    })).data;
  }

  // --- New Quizzes (/api/quiz/v1). A New Quiz is also an assignment with the same id. ---------
  async getQuiz(courseId, quizId) {
    try {
      return (await this.request('GET', `/api/quiz/v1/courses/${courseId}/quizzes/${quizId}`)).data;
    } catch (err) {
      if (/-> 404\b/.test(err.message)) return null; // deleted in Canvas
      throw err;
    }
  }

  async createQuiz(courseId, quiz) {
    return (await this.request('POST', `/api/quiz/v1/courses/${courseId}/quizzes`, { quiz })).data;
  }

  async updateQuiz(courseId, quizId, quiz) {
    return (await this.request('PATCH', `/api/quiz/v1/courses/${courseId}/quizzes/${quizId}`, { quiz })).data;
  }

  async listQuizItems(courseId, quizId) {
    return (await this.request('GET', `/api/quiz/v1/courses/${courseId}/quizzes/${quizId}/items`)).data;
  }

  async createQuizItem(courseId, quizId, item) {
    return (await this.request('POST', `/api/quiz/v1/courses/${courseId}/quizzes/${quizId}/items`, item)).data;
  }

  async deleteQuizItem(courseId, quizId, itemId) {
    return (await this.request('DELETE', `/api/quiz/v1/courses/${courseId}/quizzes/${quizId}/items/${itemId}`)).data;
  }

  // Publish state and "do not count towards the final grade" live on the assignment.
  async updateAssignment(courseId, assignmentId, assignment) {
    return (await this.request('PUT', `/api/v1/courses/${courseId}/assignments/${assignmentId}`, { assignment })).data;
  }

  async findOrCreateAssignmentGroup(courseId, name) {
    const groups = await this.getAll(`/api/v1/courses/${courseId}/assignment_groups`);
    const found = groups.find((g) => g.name === name);
    if (found) return found;
    return (await this.request('POST', `/api/v1/courses/${courseId}/assignment_groups`, { name, group_weight: 0 })).data;
  }

  async updateFile(fileId, attrs) {
    return (await this.request('PUT', `/api/v1/files/${fileId}`, attrs)).data;
  }
}

module.exports = { Canvas };
