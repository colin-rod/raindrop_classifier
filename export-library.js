// Read-only snapshot of the whole library, to design a new collection
// structure from what is actually there rather than from the tag registry.
//
//   node export-library.js            -> library-export.json + summary
//
// Makes GET requests only. Nothing in Raindrop is changed.

import 'dotenv/config';
import fs from 'fs/promises';
import { RaindropClient } from './raindrop-api.js';

const OUT = 'library-export.json';
const EXCERPT_CHARS = 200; // enough to classify on, small enough to upload

const client = new RaindropClient(process.env.RAINDROP_TOKEN);

// Root and nested collections come from two endpoints; join them so every
// bookmark can be labelled with its full path ("Work / Research").
async function collectionPaths() {
  const [roots, children] = await Promise.all([
    client.get('/collections'),
    client.get('/collections/childrens'),
  ]);

  const byId = new Map();
  for (const c of [...(roots.items || []), ...(children.items || [])]) {
    byId.set(c._id, { title: c.title, parent: c.parent?.$id ?? null, count: c.count });
  }

  const path = id => {
    const parts = [];
    const seen = new Set();
    let cur = id;
    while (cur != null && byId.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      parts.unshift(byId.get(cur).title);
      cur = byId.get(cur).parent;
    }
    return parts.join(' / ');
  };

  const special = { [-1]: 'Unsorted', [-99]: 'Trash' };
  const paths = new Map([...byId.keys()].map(id => [id, path(id)]));
  return { paths, byId, label: id => special[id] ?? paths.get(id) ?? `#${id}` };
}

const { byId, label } = await collectionPaths();

const bookmarks = await client.allBookmarks({
  onProgress: n => process.stdout.write(`\rFetched ${n} bookmarks…`),
});
process.stdout.write('\n');

const items = bookmarks.map(b => ({
  id: b._id,
  title: b.title,
  domain: b.domain,
  link: b.link,
  excerpt: (b.excerpt || '').slice(0, EXCERPT_CHARS),
  tags: b.tags || [],
  type: b.type,
  created: b.created,
  collectionId: b.collection?.$id,
  collection: label(b.collection?.$id),
}));

// Whole tag vocabulary with exact counts, one call.
const tagCounts = await client.getTags(0);
const tags = [...tagCounts.entries()]
  .map(([tag, count]) => ({ tag, count }))
  .sort((a, b) => b.count - a.count);

const collections = [...byId.entries()].map(([id, c]) => ({
  id, title: c.title, path: label(id), parent: c.parent, count: c.count,
}));

await fs.writeFile(OUT, JSON.stringify({
  exportedAt: new Date().toISOString(),
  totalBookmarks: items.length,
  collections,
  tags,
  bookmarks: items,
}, null, 2));

// Console summary: where things live today.
const perCollection = new Map();
for (const b of items) perCollection.set(b.collection, (perCollection.get(b.collection) || 0) + 1);

console.log(`\n${items.length} bookmarks across ${perCollection.size} collections:\n`);
for (const [name, n] of [...perCollection.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${name}`);
}
const empty = collections.filter(c => !perCollection.has(c.path));
if (empty.length) console.log(`\nEmpty collections: ${empty.map(c => c.path).join(', ')}`);
const singleUse = tags.filter(t => t.count === 1).length;
const untagged = items.filter(b => !b.tags.length).length;
console.log(`\n${tags.length} unique tags, ${singleUse} used only once; ${untagged} bookmarks untagged`);
console.log(`Top tags: ${tags.slice(0, 15).map(t => `${t.tag}(${t.count})`).join(', ')}`);
console.log(`\nWrote ${OUT}`);
