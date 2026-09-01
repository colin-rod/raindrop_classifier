// Thin wrapper over the Raindrop REST API.
//
// Collection 0 means "all collections" for every endpoint here, which is how we
// stop being blind to bookmarks outside the nine collections the classifier
// manages.

import fetch from "node-fetch";

const BASE = "https://api.raindrop.io/rest/v1";
const RATE_LIMIT_PAUSE_MS = 400; // Raindrop allows 120 req/min

export const sleep = ms => new Promise(r => setTimeout(r, ms));

export class RaindropClient {
  constructor(token, { dryRun = false } = {}) {
    if (!token) throw new Error('RAINDROP_TOKEN is not set');
    this.token = token;
    this.dryRun = dryRun;
    this.writes = [];
  }

  async request(method, path, body) {
    const resp = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

    if (!resp.ok) {
      throw new Error(`${method} ${path} → ${resp.status} ${await resp.text()}`);
    }
    return resp.json();
  }

  get(path) {
    return this.request('GET', path);
  }

  // Every mutation funnels through here so --dry-run is a property of the
  // client rather than something each call site has to remember.
  async write(method, path, body, label) {
    this.writes.push({ method, path, body, label });
    if (this.dryRun) return { result: true, dryRun: true };
    const out = await this.request(method, path, body);
    await sleep(RATE_LIMIT_PAUSE_MS);
    return out;
  }

  /**
   * The whole tag vocabulary with exact counts, in one call.
   * Replaces walking every bookmark just to count tags.
   */
  async getTags(collectionId = 0) {
    const data = await this.get(`/tags/${collectionId}`);
    const counts = new Map();
    for (const { _id, count } of data.items || []) counts.set(_id, count);
    return counts;
  }

  /**
   * Merge many tags into one, server-side, across every bookmark.
   * Unlike rewriting a bookmark's whole tags array this cannot clobber
   * unrelated tags.
   */
  mergeTags(canonical, variants, collectionId = 0) {
    return this.write(
      'PUT',
      `/tags/${collectionId}`,
      { replace: canonical, tags: variants },
      `${variants.join(', ')} → ${canonical}`
    );
  }

  setBookmarkTags(id, tags) {
    return this.write('PUT', `/raindrop/${id}`, { tags }, `bookmark ${id}`);
  }

  /** Every bookmark in the account, fully paginated with no page cap. */
  async allBookmarks({ collectionId = 0, onProgress } = {}) {
    const perpage = 50; // Raindrop documents 50 as the maximum
    const all = [];
    let page = 0;

    while (true) {
      const data = await this.get(`/raindrops/${collectionId}?perpage=${perpage}&page=${page}`);
      const items = data.items || [];
      if (!items.length) break;

      all.push(...items);
      if (onProgress) onProgress(all.length);
      page++;
      await sleep(RATE_LIMIT_PAUSE_MS);
    }

    return all;
  }

  /** tag -> [bookmark id], the provenance a revert needs. */
  async tagProvenance(tags, bookmarks) {
    const wanted = new Set(tags);
    const provenance = {};
    for (const b of bookmarks) {
      for (const tag of b.tags || []) {
        if (!wanted.has(tag)) continue;
        (provenance[tag] ||= []).push(String(b._id));
      }
    }
    return provenance;
  }
}
