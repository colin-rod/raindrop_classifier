// Apply reorg-plan.json to Raindrop.
//
//   node apply-reorg.js --dry-run          show what would change, write nothing
//   node apply-reorg.js                    create collections, move and retag bookmarks
//   node apply-reorg.js --limit 20         apply to the first 20 bookmarks only (a test)
//   node apply-reorg.js --revert <runId>   put every bookmark a run changed back exactly
//   node apply-reorg.js --plan other.json  use a different plan file
//
// Each real run writes reorg-apply-<runId>.json with every bookmark's
// collection and tags *before* it was changed; that file is what --revert uses.
// Rerunning after an interruption is safe: bookmarks already in their target
// state are skipped, so only the remainder is changed (and logged) again.
//
// Old collections are never deleted. Bookmarks added after the export are not
// in the plan and are left alone.

import 'dotenv/config';
import fs from 'fs/promises';
import { RaindropClient, sleep } from './raindrop-api.js';

const args = process.argv.slice(2);
const opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const DRY = args.includes('--dry-run');
const REVERT = opt('--revert');
const PLAN = opt('--plan') || 'reorg-plan.json';
const LIMIT = Number(opt('--limit') || Infinity);
const SEP = ' / ';
const FALLBACK_RESERVED = ['to-read', 'to-watch', 'to-try', 'favorite', 'revisit'];

const client = new RaindropClient(process.env.RAINDROP_TOKEN, { dryRun: DRY });

// raindrop-api.js throws "METHOD path → status body"; retry rate limits,
// server errors and dropped connections, give up on anything else.
async function withRetry(fn, label) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = Number(/→ (\d{3})/.exec(err.message)?.[1] || 0);
      const network = !status && /failed, reason|ECONN|ETIMEDOUT|socket|network/i.test(err.message);
      if (!(status === 429 || status >= 500 || network) || attempt >= 6) throw err;
      const wait = status === 429 ? 60_000 : 2_000 * attempt;
      console.warn(`\n${label}: ${status || 'network'} error, retrying in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

const sameTags = (a, b) => a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');

async function reservedTags() {
  try {
    const t = JSON.parse(await fs.readFile('taxonomy.json', 'utf8'));
    return new Set(t.reserved || FALLBACK_RESERVED);
  } catch {
    return new Set(FALLBACK_RESERVED);
  }
}

async function currentLibrary() {
  const all = await client.allBookmarks({
    onProgress: n => process.stdout.write(`\rReading current library: ${n}`),
  });
  process.stdout.write('\n');
  return new Map(all.map(b => [b._id, b]));
}

// ------------------------------------------------------------- collections

async function existingCollections() {
  const [roots, children] = await Promise.all([
    client.get('/collections'),
    client.get('/collections/childrens'),
  ]);
  const byKey = new Map(); // "parentId|title" -> id
  for (const c of [...(roots.items || []), ...(children.items || [])]) {
    byKey.set(`${c.parent?.$id ?? 'root'}|${c.title}`, c._id);
  }
  return byKey;
}

// Creates any missing collection along each path, parents first, and reuses
// ones that already exist, so a second run creates nothing new.
async function ensureCollections(paths, log) {
  const byKey = await existingCollections();
  const ids = new Map([['Unsorted', -1]]);
  let placeholder = -1000;

  for (const path of [...paths].filter(p => p !== 'Unsorted').sort()) {
    let parent = 'root';
    const built = [];
    for (const title of path.split(SEP)) {
      built.push(title);
      const sub = built.join(SEP);
      if (ids.has(sub)) { parent = ids.get(sub); continue; }

      let id = byKey.get(`${parent}|${title}`);
      if (id === undefined) {
        const body = { title, ...(parent === 'root' ? {} : { parent: { $id: parent } }) };
        const res = await withRetry(() => client.write('POST', '/collection', body, `create ${sub}`), `create ${sub}`);
        id = DRY ? placeholder-- : res.item._id;
        byKey.set(`${parent}|${title}`, id);
        log.createdCollections.push({ path: sub, id });
        console.log(`  + ${sub}`);
      }
      ids.set(sub, id);
      parent = id;
    }
  }
  return ids;
}

// ------------------------------------------------------------------ revert

if (REVERT) {
  const logFile = `reorg-apply-${REVERT}.json`;
  const log = JSON.parse(await fs.readFile(logFile, 'utf8'));
  const changes = [...log.changes].reverse();
  console.log(`Reverting ${changes.length} bookmarks from ${logFile}${DRY ? ' (dry run)' : ''}`);

  const failures = [];
  let done = 0;
  for (const c of changes) {
    try {
      await withRetry(() => client.write('PUT', `/raindrop/${c.id}`, {
        collection: { $id: c.before.collectionId },
        tags: c.before.tags,
      }, `revert ${c.id}`), `revert ${c.id}`);
    } catch (err) {
      failures.push({ id: c.id, error: err.message });
    }
    process.stdout.write(`\rReverted ${++done}/${changes.length}`);
  }
  process.stdout.write('\n');
  if (failures.length) {
    await fs.writeFile(`reorg-revert-failures-${REVERT}.json`, JSON.stringify(failures, null, 2));
    console.log(`${failures.length} failed, see reorg-revert-failures-${REVERT}.json`);
  }
  console.log(`Done. Collections created by that run (${log.createdCollections.length}) were left in place.`);
  process.exit(0);
}

// ------------------------------------------------------------------- apply

const plan = JSON.parse(await fs.readFile(PLAN, 'utf8'));
const items = plan.items.slice(0, LIMIT);
const RESERVED = await reservedTags();
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const logFile = `reorg-apply-${runId}.json`;
const log = { runId, plan: PLAN, dryRun: DRY, startedAt: new Date().toISOString(), createdCollections: [], changes: [], failures: [] };
const saveLog = () => DRY ? null : fs.writeFile(logFile, JSON.stringify(log, null, 1));

console.log(`${DRY ? 'DRY RUN: ' : ''}applying ${items.length} planned bookmarks from ${PLAN}`);
const current = await currentLibrary();

console.log('Collections:');
const ids = await ensureCollections(new Set(items.map(i => i.to.collection)), log);
if (!log.createdCollections.length) console.log('  all already exist');
await saveLog();

// Work out every change against the library as it is now, not as exported.
const work = [];
const skipped = { missing: 0, unchanged: 0 };
for (const item of items) {
  const cur = current.get(item.id);
  if (!cur) { skipped.missing++; continue; }

  const curTags = cur.tags || [];
  // Reserved tags present right now survive, even ones added after the export.
  const tags = [...new Set([...item.to.tags, ...curTags.filter(t => RESERVED.has(t))])];
  const collectionId = ids.get(item.to.collection);
  const before = { collectionId: cur.collection?.$id ?? -1, tags: curTags };

  if (before.collectionId === collectionId && sameTags(curTags, tags)) { skipped.unchanged++; continue; }
  work.push({ id: item.id, title: item.title, to: item.to.collection, before, after: { collectionId, tags } });
}

console.log(`\n${work.length} to update · ${skipped.unchanged} already done · ${skipped.missing} no longer in Raindrop`);
for (const w of work.slice(0, 5)) {
  console.log(`  ${w.title.slice(0, 60)}\n    → ${w.to} [${w.after.tags.join(', ')}]  (was [${w.before.tags.join(', ')}])`);
}

if (DRY) {
  const minutes = Math.ceil((work.length + log.createdCollections.length) * 0.6 / 60);
  console.log(`\nDry run: nothing written. A real run would take roughly ${minutes} minutes.`);
  process.exit(0);
}
if (!work.length) process.exit(0);

console.log('\nStarting in 5 seconds (Ctrl+C to abort)…');
await sleep(5000);

let done = 0;
for (const w of work) {
  try {
    await withRetry(() => client.write('PUT', `/raindrop/${w.id}`, {
      collection: { $id: w.after.collectionId },
      tags: w.after.tags,
    }, `bookmark ${w.id}`), `bookmark ${w.id}`);
    log.changes.push({ id: w.id, before: w.before, after: w.after });
  } catch (err) {
    log.failures.push({ id: w.id, title: w.title, error: err.message });
  }
  done++;
  if (done % 25 === 0) await saveLog();
  process.stdout.write(`\rUpdated ${done}/${work.length}${log.failures.length ? ` (${log.failures.length} failed)` : ''}`);
}
process.stdout.write('\n');

log.finishedAt = new Date().toISOString();
await saveLog();

console.log(`\nDone: ${log.changes.length} bookmarks updated, ${log.createdCollections.length} collections created, ${log.failures.length} failed.`);
if (log.failures.length) console.log(`Failures are listed in ${logFile}; rerun to retry them.`);
console.log(`Undo with: node apply-reorg.js --revert ${runId}`);
