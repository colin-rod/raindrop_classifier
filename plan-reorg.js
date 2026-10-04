// Plan a full reorganisation of the library against taxonomy.json.
//
//   node plan-reorg.js                 classify everything (resumes if interrupted)
//   node plan-reorg.js --limit 50      try it on the first 50 bookmarks
//   node plan-reorg.js --summarize     rebuild the plan from the cache, no API calls
//
// Reads library-export.json, calls OpenAI, and writes:
//   reorg-cache.json     raw per-bookmark results (lets a run resume)
//   reorg-plan.json      from -> to for every bookmark (input to the apply step)
//   reorg-summary.md     what to review before applying
//
// Nothing in Raindrop is read or written.

import 'dotenv/config';
import fs from 'fs/promises';
import OpenAI from 'openai';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const BATCH = 5;         // bookmarks per model call; 15 made the model lazy
const CONCURRENCY = 4;   // model calls in flight
const PROMPT_VERSION = 2; // bump to invalidate cached results
const FILES = {
  export: 'library-export.json',
  taxonomy: 'taxonomy.json',
  cache: 'reorg-cache.json',
  plan: 'reorg-plan.json',
  summary: 'reorg-summary.md',
};

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : Infinity;
const SUMMARIZE_ONLY = args.includes('--summarize');

const readJson = async (path, fallback) => {
  try { return JSON.parse(await fs.readFile(path, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT' && fallback !== undefined) return fallback; throw e; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

// "Angèle" -> "angele", "Conan O'Brien" -> "conan-obrien", "Fontaines D.C." -> "fontaines-dc"
export function slug(name) {
  return String(name)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const library = await readJson(FILES.export);
const taxonomy = await readJson(FILES.taxonomy);
const { rules } = taxonomy;
const VOCAB = new Set(Object.values(taxonomy.tags).flat());
const RESERVED = new Set(taxonomy.reserved);
const COLLECTIONS = new Set(taxonomy.collections);

const bookmarks = library.bookmarks.slice(0, LIMIT);
const STOPLIST = new Set((rules.entityStoplist || []).map(slug));

// Cached results from an older taxonomy or prompt are ignored, not deleted.
const CACHE_VERSION = `${taxonomy.version}.${PROMPT_VERSION}`;
const cache = await readJson(FILES.cache, {});
const fresh = id => cache[id]?._v === CACHE_VERSION ? cache[id] : null;

// ---------------------------------------------------------------- classify

// Group names are shown as headings only. In v1 they were written as
// "group: tags" and the model returned the group names as tags.
const vocabText = Object.entries(taxonomy.tags)
  .map(([group, tags]) => `# ${group} (heading, not a tag)\n${tags.join(', ')}`).join('\n');

const SYSTEM = `You file bookmarks into a fixed collection structure and tag them.

COLLECTIONS:
${taxonomy.collections.join('\n')}

TOPIC TAGS:
${vocabText}

For each bookmark:
- "collection": the best collection path. File by subject, not format: a cooking video goes to
  Cooking & Recipes, a sports article to Sports & Games. Watch & Listen is for entertainment
  (music, film/TV, comedy, interviews, celebrity news and gossip). Always make your best guess;
  use "UNSURE" only when the title and excerpt give no clue at all (e.g. "Instagram", a bare name).
- "tags": ${rules.minTopicTags}-${rules.maxTopicTags} topic tags. Be generous: cover subject, place, companies/people, and format
  (e.g. long-read, opinion, explainer, tutorial, interview). Every bookmark has at least ${rules.minTopicTags}.
- "entities": up to ${rules.maxEntityTags} specific named entities the bookmark is substantially about or made by:
    "artist"  = musician or band (every credited artist on a music video, including features)
    "show"    = a TV series, film, film franchise or podcast
    "creator" = a YouTube channel, comedian, chef, writer, blogger or newsletter author
    "person"  = an actor, celebrity or public figure the piece is about
  Use canonical names: the host's name for talk and late-night shows ("Stephen Colbert", not
  "The Late Show"; "Jimmy Fallon", not "The Tonight Show"), "Tomas Pueyo" for Uncharted Territories.
  Never list news outlets (Gizmodo, TechCrunch, BBC, WSJ...), companies, or software products/AI models.
- "suggest": up to 2 topic tags you wish existed, only for a clearly important missing topic. Usually empty.
Return every bookmark you were given, with its id unchanged.`;

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'filing',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['id', 'collection', 'tags', 'entities', 'suggest'],
            properties: {
              id: { type: 'string' },
              // Enums make an invented tag or collection impossible rather than
              // something to clean up afterwards.
              collection: { type: 'string', enum: [...taxonomy.collections, 'UNSURE'] },
              tags: { type: 'array', items: { type: 'string', enum: [...VOCAB] } },
              entities: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['name', 'type'],
                  properties: {
                    name: { type: 'string' },
                    type: { type: 'string', enum: rules.entityTypes },
                  },
                },
              },
              suggest: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      },
    },
  },
};

const openai = SUMMARIZE_ONLY ? null : new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

function describe(b) {
  return {
    id: String(b.id),
    title: b.title,
    domain: b.domain,
    type: b.type,
    excerpt: b.excerpt,
  };
}

async function classifyBatch(batch) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        response_format: SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify(batch.map(describe)) },
        ],
      });
      const { items = [] } = JSON.parse(resp.choices[0].message.content);
      return items;
    } catch (err) {
      const retriable = err.status === 429 || err.status >= 500 || err instanceof SyntaxError;
      if (!retriable || attempt >= 5) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

async function run(todo, batchSize, label) {
  const batches = [];
  for (let i = 0; i < todo.length; i += batchSize) batches.push(todo.slice(i, i + batchSize));
  let done = 0;
  const worker = async () => {
    while (batches.length) {
      const batch = batches.shift();
      const items = await classifyBatch(batch);
      const byId = new Map(items.map(i => [String(i.id), i]));
      for (const b of batch) {
        // A bookmark the model skipped stays uncached and is retried next run.
        const r = byId.get(String(b.id));
        if (r) cache[b.id] = { ...r, _v: CACHE_VERSION };
      }
      done += batch.length;
      await fs.writeFile(FILES.cache, JSON.stringify(cache));
      process.stdout.write(`\r${label}: ${done}/${todo.length}`);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  process.stdout.write('\n');
}

// Second look, one bookmark per call: too few tags, or "unsure" about a title
// that clearly says something.
const weak = b => {
  const r = fresh(b.id);
  if (!r) return false;
  const informative = (b.title || '').trim().split(/\s+/).length >= 4;
  return r.tags.length < rules.minTopicTags || (r.collection === 'UNSURE' && informative);
};

if (!SUMMARIZE_ONLY) {
  const todo = bookmarks.filter(b => !fresh(b.id));
  console.log(`${bookmarks.length - todo.length} already classified, ${todo.length} to go (model ${MODEL})`);
  if (todo.length) await run(todo, BATCH, 'Classified');

  const retry = bookmarks.filter(b => weak(b) && !fresh(b.id).retried);
  if (retry.length) {
    await run(retry, 1, 'Second look');
    for (const b of retry) if (fresh(b.id)) cache[b.id].retried = true;
    await fs.writeFile(FILES.cache, JSON.stringify(cache));
  }
}

// ---------------------------------------------------------------- validate

// Entity tags only exist once a name recurs, so count across the whole run
// before deciding which ones become tags.
const entityCounts = new Map(); // slug -> { names: Map(name -> n), types: Map(type -> n), count }
for (const b of bookmarks) {
  const r = fresh(b.id);
  if (!r) continue;
  const seen = new Set();
  for (const e of (r.entities || []).slice(0, rules.maxEntityTags)) {
    const s = slug(e.name);
    if (!s || seen.has(s) || STOPLIST.has(s) || !rules.entityTypes.includes(e.type)) continue;
    seen.add(s);
    const entry = entityCounts.get(s) || { names: new Map(), types: new Map(), count: 0 };
    entry.count++;
    entry.names.set(e.name, (entry.names.get(e.name) || 0) + 1);
    entry.types.set(e.type, (entry.types.get(e.type) || 0) + 1);
    entityCounts.set(s, entry);
  }
}
const top = m => [...m.entries()].sort((a, b) => b[1] - a[1])[0][0];

const entityTags = new Map(); // slug -> tag actually written
for (const [s, e] of entityCounts) {
  // An entity that already is a topic tag (sam-altman, elon-musk) just uses it.
  if (VOCAB.has(s)) { entityTags.set(s, s); continue; }
  if (e.count < rules.minEntityBookmarks) continue;
  entityTags.set(s, RESERVED.has(s) ? `${s}-${top(e.types)}` : s);
}

const plan = [];
const flags = { unsure: [], badCollection: [], missing: [], fewTags: [] };
const rejectedTags = new Map();
const suggested = new Map();
const tagUse = new Map();

for (const b of bookmarks) {
  const r = fresh(b.id);
  const keepReserved = (b.tags || []).filter(t => RESERVED.has(t));

  if (!r) {
    flags.missing.push(b);
    continue;
  }

  let collection = r.collection;
  let flag = null;
  if (collection === 'UNSURE') { collection = 'Unsorted'; flag = 'unsure'; flags.unsure.push(b); }
  else if (!COLLECTIONS.has(collection)) {
    flags.badCollection.push({ ...b, proposed: collection });
    collection = 'Unsorted'; flag = 'bad-collection';
  }

  const topic = [];
  for (const raw of r.tags || []) {
    const t = slug(raw);
    if (VOCAB.has(t)) { if (!topic.includes(t)) topic.push(t); }
    else rejectedTags.set(t, (rejectedTags.get(t) || 0) + 1);
  }
  topic.splice(rules.maxTopicTags);

  const entities = [];
  for (const e of r.entities || []) {
    const tag = entityTags.get(slug(e.name));
    if (!tag) continue;
    if (VOCAB.has(tag)) { if (!topic.includes(tag)) topic.push(tag); }
    else if (!entities.includes(tag)) entities.push(tag);
  }
  entities.splice(rules.maxEntityTags);
  if (topic.length < rules.minTopicTags) flags.fewTags.push(b);

  for (const s of r.suggest || []) {
    const t = slug(s);
    if (t && !VOCAB.has(t)) suggested.set(t, (suggested.get(t) || 0) + 1);
  }

  const tags = [...topic, ...entities, ...keepReserved];
  for (const t of [...topic, ...entities]) tagUse.set(t, (tagUse.get(t) || 0) + 1);

  plan.push({
    id: b.id,
    title: b.title,
    from: { collectionId: b.collectionId, collection: b.collection, tags: b.tags || [] },
    to: { collection, tags },
    ...(flag ? { flag } : {}),
  });
}

await fs.writeFile(FILES.plan, JSON.stringify({
  createdAt: new Date().toISOString(),
  exportedAt: library.exportedAt,
  taxonomyVersion: taxonomy.version,
  entityTags: Object.fromEntries([...entityTags].map(([s, tag]) => {
    const e = entityCounts.get(s);
    return [tag, { name: top(e.names), type: top(e.types), bookmarks: e.count }];
  })),
  items: plan,
}, null, 2));

// ---------------------------------------------------------------- summary

const count = (xs, key) => {
  const m = new Map();
  for (const x of xs) m.set(key(x), (m.get(key(x)) || 0) + 1);
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const list = (pairs, n = Infinity) => pairs.slice(0, n).map(([k, v]) => `${k} (${v})`).join(', ') || '—';
const titles = (xs, n = 40) => xs.slice(0, n).map(b => `- ${b.title}${b.proposed ? ` → *${b.proposed}*` : ''}`).join('\n') || '—';

const unusedVocab = [...VOCAB].filter(t => !tagUse.has(t));
const lowUse = [...tagUse.entries()].filter(([t, n]) => VOCAB.has(t) && n < 3).sort((a, b) => a[1] - b[1]);
const entitiesByType = type => [...entityTags].filter(([, tag]) => !VOCAB.has(tag))
  .map(([s, tag]) => [tag, entityCounts.get(s)])
  .filter(([, e]) => top(e.types) === type)
  .sort((a, b) => b[1].count - a[1].count)
  .map(([tag, e]) => [`${tag}`, e.count]);
const nearMisses = [...entityCounts].filter(([, e]) => e.count === rules.minEntityBookmarks - 1).length;

const movesTotal = plan.length; // every collection is new, so every bookmark moves

const md = `# Reorganisation plan

${plan.length} of ${bookmarks.length} bookmarks planned · model ${MODEL} · nothing written to Raindrop yet.

Average tags per bookmark: ${(plan.reduce((n, p) => n + p.to.tags.length, 0) / (plan.length || 1)).toFixed(1)} · bookmarks with an entity tag: ${plan.filter(p => p.to.tags.some(t => !VOCAB.has(t) && !RESERVED.has(t))).length}

## Collections

| Collection | Bookmarks |
|---|---|
${count(plan, p => p.to.collection).map(([c, n]) => `| ${c} | ${n} |`).join('\n')}

## Where the old collections go

${count(plan, p => p.from.collection).map(([from]) => `**${from}** → ${list(count(plan.filter(p => p.from.collection === from), p => p.to.collection), 5)}`).join('\n\n')}

## Topic tags

Most used: ${list([...tagUse.entries()].filter(([t]) => VOCAB.has(t)).sort((a, b) => b[1] - a[1]), 40)}

Used fewer than 3 times (drop or merge?): ${list(lowUse)}

Never used: ${unusedVocab.join(', ') || '—'}

## Entity tags (${entityTags.size}, each on ${rules.minEntityBookmarks}+ bookmarks)

**Artists:** ${list(entitiesByType('artist'))}

**Shows:** ${list(entitiesByType('show'))}

**Creators:** ${list(entitiesByType('creator'))}

**People:** ${list(entitiesByType('person'))}

${nearMisses} more entities appear on only one bookmark and get no tag.

## Tags the model wanted to add (not applied)

${list([...suggested.entries()].sort((a, b) => b[1] - a[1]), 40)}

## Invented tags that were rejected

${list([...rejectedTags.entries()].sort((a, b) => b[1] - a[1]), 40)}

## Needs a decision

**Unsure, will stay in Unsorted (${flags.unsure.length}):**
${titles(flags.unsure)}

**Proposed a collection that doesn't exist (${flags.badCollection.length}):**
${titles(flags.badCollection)}

**Fewer than ${rules.minTopicTags} valid topic tags (${flags.fewTags.length}):**
${titles(flags.fewTags, 20)}

**Not classified yet, rerun to retry (${flags.missing.length})**
`;

await fs.writeFile(FILES.summary, md);
console.log(`\nWrote ${FILES.plan} and ${FILES.summary}`);
console.log(`${plan.length} planned, ${movesTotal} moves, ${entityTags.size} entity tags, ` +
  `${flags.unsure.length + flags.badCollection.length} need a decision, ${flags.missing.length} missing`);
