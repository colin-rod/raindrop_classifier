// File new bookmarks from Unsorted into the reorganised collections.
//
//   node classify.js             classify and update everything in Unsorted
//   node classify.js --dry-run   show what it would do, write nothing
//
// Uses the same rules as the reorganisation (taxonomy.json):
//   - collections are resolved by path at runtime, so no IDs are hardcoded
//   - topic tags come only from the fixed vocabulary (enforced by the schema)
//   - artist/show/creator/person tags appear once a name is on 2+ bookmarks;
//     when a name reaches that threshold, the earlier bookmark is tagged too
//   - tags already on a bookmark (e.g. ones you added when saving) are kept
//
// State lives in classifier-state.json (entity counts, bookmarks left in
// Unsorted). The workflow commits it after each run.

import 'dotenv/config';
import fs from 'fs/promises';
import OpenAI from 'openai';
import { RaindropClient, sleep } from './raindrop-api.js';

const MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const DRY = process.argv.includes('--dry-run');
const STATE_FILE = 'classifier-state.json';
const SEP = ' / ';

const taxonomy = JSON.parse(await fs.readFile('taxonomy.json', 'utf8'));
const { rules } = taxonomy;
const VOCAB = new Set(Object.values(taxonomy.tags).flat());
const NOTES = taxonomy.tagNotes || {};

export function slug(name) {
  return String(name)
    .normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['’.]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

const BLOCKLIST = new Set((rules.entityBlocklist || []).map(slug));
const ALIASES = new Map(Object.entries(rules.entityAliases || {}).map(([k, v]) => [slug(k), slug(v)]));
const DISCARD_TYPES = new Set(rules.discardEntityTypes || []);

const entitySlug = e => {
  if (DISCARD_TYPES.has(e.type) || !rules.entityTypes.includes(e.type)) return null;
  let s = slug(e.name);
  s = ALIASES.get(s) || s;
  return s && !BLOCKLIST.has(s) ? s : null;
};

// ------------------------------------------------------------------ model

const vocabText = Object.entries(taxonomy.tags)
  .map(([group, tags]) => `# ${group} (heading, not a tag)\n` +
    tags.map(t => NOTES[t] ? `${t} (${NOTES[t]})` : t).join(', ')).join('\n');

const SYSTEM = `You file a bookmark into a fixed collection structure and tag it.

COLLECTIONS:
${taxonomy.collections.join('\n')}

TOPIC TAGS:
${vocabText}

Return:
- "collection": the best collection path. File by subject, not format: a cooking video goes to
  Cooking & Recipes, a sports article to Sports & Games. Watch & Listen is for entertainment
  (music, film/TV, comedy, interviews, celebrity news and gossip). Always make your best guess;
  use "UNSURE" only when the title and excerpt give no clue at all (e.g. "Instagram", a bare name).
- "tags": ${rules.minTopicTags}-${rules.maxTopicTags} topic tags that clearly apply. A wrong tag is worse than a missing one:
  never add a tag just to reach a number. Respect the notes in brackets. Add a place, company or
  person tag only when it is central to the piece. Judge from the title and excerpt only.
- "entities": up to ${rules.maxEntityTags} specific named entities the bookmark is substantially about or made by:
    "artist"  = musician or band (every credited artist on a music video, including features)
    "show"    = a TV series, film, film franchise or podcast
    "creator" = a YouTube channel, comedian, chef, writer, blogger or newsletter author
    "person"  = an actor, celebrity or public figure the piece is about
    "company_or_product" = a company, app, website, AI model or product (these are dropped; tag them here
                           instead of under another type)
  Use canonical names: the host's name for talk and late-night shows ("Stephen Colbert", not
  "The Late Show"; "Jimmy Fallon", not "The Tonight Show"), "Tomas Pueyo" for Uncharted Territories.
  Use full names, never a first name alone. Never list news outlets (Gizmodo, TechCrunch, BBC, WSJ...).`;

const SCHEMA = {
  type: 'json_schema',
  json_schema: {
    name: 'filing',
    strict: true,
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['collection', 'tags', 'entities'],
      properties: {
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
      },
    },
  },
};

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function classify(b) {
  for (let attempt = 1; ; attempt++) {
    try {
      const resp = await openai.chat.completions.create({
        model: MODEL,
        temperature: 0,
        response_format: SCHEMA,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: JSON.stringify({
            title: b.title, domain: b.domain, type: b.type, excerpt: (b.excerpt || '').slice(0, 300),
          }) },
        ],
      });
      return JSON.parse(resp.choices[0].message.content);
    } catch (err) {
      const retriable = err.status === 429 || err.status >= 500 || err instanceof SyntaxError;
      if (!retriable || attempt >= 4) throw err;
      await sleep(1000 * 2 ** attempt);
    }
  }
}

// -------------------------------------------------------------- raindrop

const client = new RaindropClient(process.env.RAINDROP_TOKEN, { dryRun: DRY });

async function collectionIds() {
  const [roots, children] = await Promise.all([
    client.get('/collections'),
    client.get('/collections/childrens'),
  ]);
  const all = [...(roots.items || []), ...(children.items || [])];
  const byId = new Map(all.map(c => [c._id, c]));
  const path = c => {
    const parts = [];
    const seen = new Set();
    while (c && !seen.has(c._id)) {
      seen.add(c._id);
      parts.unshift(c.title);
      c = byId.get(c.parent?.$id);
    }
    return parts.join(SEP);
  };
  return new Map(all.map(c => [path(c), c._id]));
}

async function addTag(id, tag) {
  const { item } = await client.get(`/raindrop/${id}`);
  if (!item || (item.tags || []).includes(tag)) return false;
  await client.write('PUT', `/raindrop/${id}`, { tags: [...(item.tags || []), tag] }, `tag ${id} +${tag}`);
  return true;
}

// ------------------------------------------------------------------ main

async function loadState() {
  try { return JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return { version: 1, entities: {}, leftUnsorted: [] }; throw e; }
}

const state = await loadState();
const leftUnsorted = new Set(state.leftUnsorted || []);
const ids = await collectionIds();

const missing = taxonomy.collections.filter(p => !ids.has(p));
if (missing.length === taxonomy.collections.length) {
  console.error('❌ None of the new collections exist yet. Run apply-reorg.js first.');
  process.exit(1);
}
if (missing.length) console.warn(`⚠️ Collections not found in Raindrop (bookmarks for them are skipped and retried next run): ${missing.join(', ')}`);

const unsorted = (await client.allBookmarks({ collectionId: -1 }))
  .filter(b => (b.collection?.$id ?? -1) === -1 && !leftUnsorted.has(b._id));

if (!unsorted.length) {
  console.log('🎉 Nothing new in Unsorted.');
  process.exit(0);
}
console.log(`📥 ${unsorted.length} new bookmarks in Unsorted${DRY ? ' (dry run)' : ''} · model ${MODEL}\n`);

const counts = { filed: 0, unsure: 0, skipped: 0, failed: 0, backfilled: 0 };

for (const b of unsorted) {
  try {
    const r = await classify(b);
    if (r.collection !== 'UNSURE' && !ids.has(r.collection)) {
      counts.skipped++;
      console.warn(`⏭️ ${b.title}: "${r.collection}" doesn't exist in Raindrop, left for next run`);
      continue;
    }

    // Topic tags: the schema already restricts them to the vocabulary.
    const tags = [...new Set(r.tags)].slice(0, rules.maxTopicTags);

    // Entity tags: count every sighting; tag once a name is on 2+ bookmarks.
    const entityTags = [];
    const backfill = [];
    for (const e of r.entities.slice(0, rules.maxEntityTags)) {
      const s = entitySlug(e);
      if (!s) continue;
      if (VOCAB.has(s)) { if (!tags.includes(s)) tags.push(s); continue; }

      const entry = state.entities[s] ||= { name: e.name, type: e.type, bookmarks: [] };
      if (!entry.bookmarks.includes(b._id)) entry.bookmarks.push(b._id);
      if (entry.bookmarks.length >= rules.minEntityBookmarks) {
        entityTags.push(s);
        // Just crossed the threshold: the earlier bookmarks need the tag too.
        if (entry.bookmarks.length === rules.minEntityBookmarks) {
          backfill.push(...entry.bookmarks.filter(id => id !== b._id).map(id => [id, s]));
        }
      }
    }

    const finalTags = [...new Set([...(b.tags || []), ...tags, ...entityTags])];
    const target = r.collection === 'UNSURE' ? -1 : ids.get(r.collection);

    await client.write('PUT', `/raindrop/${b._id}`, { collection: { $id: target }, tags: finalTags }, `bookmark ${b._id}`);
    for (const [id, tag] of backfill) {
      if (DRY || await addTag(id, tag)) counts.backfilled++;
    }

    if (target === -1) {
      // Remember it so it isn't re-classified every week; you can file it by hand.
      leftUnsorted.add(b._id);
      counts.unsure++;
      console.log(`🤷 ${b.title}\n   stays in Unsorted [${finalTags.join(', ')}]`);
    } else {
      counts.filed++;
      console.log(`✅ ${b.title}\n   → ${r.collection} [${finalTags.join(', ')}]`);
    }
    if (backfill.length) console.log(`   + tagged ${backfill.length} earlier bookmark(s) with ${[...new Set(backfill.map(([, t]) => t))].join(', ')}`);
  } catch (err) {
    counts.failed++;
    console.error(`❌ ${b.title}: ${err.message}`);
  }
}

state.leftUnsorted = [...leftUnsorted];
state.lastRun = new Date().toISOString();
if (!DRY) await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 1));

console.log(`\n✨ ${counts.filed} filed, ${counts.unsure} left in Unsorted, ${counts.skipped} skipped, ${counts.failed} failed, ${counts.backfilled} earlier bookmarks tagged${DRY ? ' (dry run, nothing written)' : ''}.`);
if (counts.failed) process.exitCode = 1;
