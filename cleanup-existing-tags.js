import 'dotenv/config';
import OpenAI from "openai";
import fs from 'fs/promises';
import { RaindropClient, sleep } from './raindrop-api.js';
import {
  normalizeTag, lexicalGroups, circuitBreaker,
  plannedReverts, revertTags, sanitiseGroups, updateRegistry,
} from './tag-utils.js';

// Weekly tag consolidation across the whole account.
//
//   node cleanup-existing-tags.js              apply
//   node cleanup-existing-tags.js --dry-run    print the plan, write nothing
//   node cleanup-existing-tags.js --revert <runId>
//
// Merges are applied with PUT /tags/0, which rewrites a tag across every
// bookmark server-side. That replaces the old fetch-every-bookmark, recompute
// the tags array, PUT each one loop: it is one call per merge group instead of
// one per bookmark, and it cannot clobber tags outside the merge.

const DRY_RUN = process.argv.includes('--dry-run');
const REVERT_ID = process.argv[process.argv.indexOf('--revert') + 1];
const IS_REVERT = process.argv.includes('--revert');

const MERGE_LOG = 'tag-merge-log.json';
const REGISTRY = 'tag-registry.json';
const METRICS = 'tag-metrics.json';

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const COLLECTIONS = {
  "AI & Technology": 59437707,
  "Entertainment & Media": 59437708,
  "Business & Startups": 59437709,
  "Career & Professional Development": 59437710,
  "Politics & Current Affairs": 59437711,
  "Lifestyle & Practical": 59437712,
  "Finance & Economics": 59437713,
  "Global & Cultural": 59437715,
  "Others": 59437777
};
const COLLECTION_NAMES = Object.fromEntries(
  Object.entries(COLLECTIONS).map(([name, id]) => [id, name])
);

async function readJson(path, fallback) {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Semantic pass
// ---------------------------------------------------------------------------

/**
 * Ask the model to merge true synonyms.
 *
 * The old implementation sliced the vocabulary into windows of 20 and grouped
 * within each window, so two duplicates in different windows were never
 * compared -- at 600 tags any given pair had roughly a 3% chance of being seen
 * together. Here every prompt carries the FULL vocabulary as context and the
 * batch only decides which of its own tags fold into it, so a merge target can
 * live anywhere in the list.
 */
async function semanticGroups(tags, counts, batchSize = 120) {
  if (!tags.length) return [];

  const vocabulary = tags
    .map(t => `${t} (${counts.get(t) || 0})`)
    .join(', ');

  // Sorting puts lexically adjacent tags in the same batch, which keeps related
  // concepts together and makes each batch cheaper to reason about.
  const sorted = [...tags].sort();
  const groups = [];

  for (let i = 0; i < sorted.length; i += batchSize) {
    const batch = sorted.slice(i, i + batchSize);

    const prompt = `You are consolidating a bookmark tag vocabulary.

FULL VOCABULARY (tag followed by its usage count):
${vocabulary}

TAGS TO DECIDE ON THIS PASS:
${batch.join(', ')}

For each tag in "TAGS TO DECIDE ON", decide whether it is a true synonym of
another tag. The canonical you choose may be ANY tag from the full vocabulary,
not just from this batch.

A synonym means the two tags name THE SAME THING. If you would ever want to
filter on one but not the other, they are not synonyms.

  ✅ "crypto" + "cryptocurrency" + "crypto-industry" → "crypto"
  ✅ "job-market" + "jobs" + "employment" → "jobs"
  ✅ "tv-show" + "tv-shows" → "tv-shows"
  ✅ "data-analysis" + "data-analytics" → whichever is used more

Do NOT merge related-but-distinct concepts, or a specific thing into its
general category. These are all real mistakes made on this vocabulary:
  ❌ "artificial-intelligence" → "art"   (a prefix match is not a meaning match)
  ❌ "video-games" → "video"             (a genre is not the medium)
  ❌ "risk-management" → "security"      (related, not the same)
  ❌ "software" → "software-development" (a field is not its subject)
  ❌ "marvel" → "movies"                 (a franchise is not the medium)
  ❌ "ai-coding" → "ai"                  (a subtopic is not its parent)

Never merge a tag into one that shares only a prefix or substring.
Never merge a more-used tag into a less-used one — the canonical must be the
tag with the HIGHER usage count shown above.
Keep named entities (people, companies, franchises) separate unless they are
genuinely the same entity spelled differently.
Use lowercase-with-hyphens. A tag with no true synonym must be omitted entirely.

For every group set "relation" to "synonym" only if the tags name the same
thing. If the tags are merely related, adjacent, or one is a subtopic of the
other, do not include the group at all.

Return JSON only:
{"groups": [{"canonical": "crypto", "variants": ["cryptocurrency"], "relation": "synonym", "reason": "same concept"}]}`;

    const resp = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
    });

    const parsed = JSON.parse(resp.choices[0].message.content);
    for (const g of parsed.groups || []) {
      if (!g?.canonical || !Array.isArray(g.variants)) continue;
      groups.push({ ...g, relation: g.relation, reason: g.reason });
    }

    console.log(`   batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(sorted.length / batchSize)}`);
    await sleep(1000);
  }

  return groups;
}

// ---------------------------------------------------------------------------
// Metrics (consumed by the randomizer's Classifier panel)
// ---------------------------------------------------------------------------

async function writeMetrics(entry) {
  const history = await readJson(METRICS, []);
  const list = Array.isArray(history) ? history : [];
  list.push(entry);
  await fs.writeFile(METRICS, JSON.stringify(list, null, 2));
}

// ---------------------------------------------------------------------------
// Revert
// ---------------------------------------------------------------------------

async function revert(raindrop, runId) {
  const log = await readJson(MERGE_LOG, { runs: [] });
  const run = log.runs.find(r => r.runId === runId) || (runId ? null : log.runs.at(-1));

  if (!run) {
    console.error(`❌ No run "${runId}" in ${MERGE_LOG}.`);
    console.error(`   Available: ${log.runs.map(r => r.runId).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const plan = plannedReverts(run);
  console.log(`↩️  Reverting run ${run.runId} (${run.appliedAt})`);
  console.log(`   ${run.merges.length} merges across ${plan.length} bookmarks\n`);

  // Undoing a merge needs per-bookmark writes: at the vocabulary level the
  // merged populations are indistinguishable, so only recorded provenance can
  // separate them.
  const bookmarks = await raindrop.allBookmarks();
  const byId = new Map(bookmarks.map(b => [String(b._id), b]));

  let restored = 0;
  for (const op of plan) {
    const current = byId.get(op.id);
    if (!current) continue;
    const next = revertTags(current.tags || [], op);
    await raindrop.setBookmarkTags(op.id, next);
    restored++;
    if (restored % 25 === 0) console.log(`   restored ${restored}/${plan.length}`);
  }

  console.log(`\n✅ Restored ${restored} bookmarks.`);
  if (raindrop.dryRun) console.log('   (dry run — nothing was written)');
}

// ---------------------------------------------------------------------------

async function main() {
  const raindrop = new RaindropClient(process.env.RAINDROP_TOKEN, { dryRun: DRY_RUN });

  if (IS_REVERT) return revert(raindrop, REVERT_ID);

  console.log('🧹 Tag consolidation\n');
  if (DRY_RUN) console.log('   DRY RUN — no writes will be made\n');

  // 1. The whole vocabulary, in one call, across every collection.
  const counts = await raindrop.getTags(0);
  console.log(`📊 ${counts.size} unique tags, ${[...counts.values()].reduce((a, b) => a + b, 0)} applications`);

  const before = {
    unique: counts.size,
    singleUse: [...counts.values()].filter(c => c === 1).length,
  };

  // 2. Deterministic merges — case, punctuation, genuine plurals.
  const lexical = lexicalGroups(counts);
  console.log(`🔤 ${lexical.length} lexical groups (${lexical.reduce((s, g) => s + g.variants.length, 0)} tags absorbed)`);

  // 3. Semantic merges over everything the lexical pass did not claim.
  const claimed = new Set(lexical.flatMap(g => g.variants));
  const remaining = [...counts.keys()].filter(t => !claimed.has(t));
  console.log(`🤖 Analysing ${remaining.length} remaining tags for synonyms…`);
  const { clean: semantic, rejected } = sanitiseGroups(await semanticGroups(remaining, counts), counts);
  console.log(`   ${semantic.length} semantic groups (${semantic.reduce((s, g) => s + g.variants.length, 0)} tags absorbed)`);

  if (rejected.length) {
    console.log(`\n🚫 Rejected ${rejected.length} proposed merges:`);
    for (const r of rejected) {
      console.log(`   ${r.canonical} ← ${(r.variants || []).join(', ')}`);
      console.log(`     ${r.why}`);
    }
  }

  // Lexical wins any conflict: it is provable, the model's answer is not.
  const lexicalClaimed = new Set(lexical.flatMap(g => [g.canonical, ...g.variants]));
  const groups = [
    ...lexical,
    ...semantic.filter(g => !g.variants.some(v => lexicalClaimed.has(v))),
  ];

  // 4. Refuse a run that would flatten the vocabulary. Not a review gate — it
  //    aborts and the next scheduled run tries again.
  const breaker = circuitBreaker(counts.size, groups);
  if (breaker.tripped) {
    console.error(`\n🛑 Circuit breaker: ${breaker.reason}`);
    console.error('   Nothing was applied. Inspect with --dry-run.');
    process.exit(1);
  }

  console.log('\n📋 Merge plan');
  for (const g of groups) {
    console.log(`   ${g.canonical}  ←  ${g.variants.join(', ')}`);
    if (g.reason) console.log(`     ${g.reason}`);
  }
  if (!groups.length) console.log('   (nothing to merge)');

  // 5. Record provenance BEFORE merging, so the run stays reversible.
  const runId = new Date().toISOString().replace(/[:.]/g, '-');
  let provenance = {};
  let categoryOf = new Map();
  if (groups.length) {
    console.log('\n📸 Recording provenance for revert…');
    const bookmarks = await raindrop.allBookmarks({
      onProgress: n => process.stdout.write(`\r   scanned ${n}…`),
    });
    process.stdout.write('\r');
    provenance = await raindrop.tagProvenance(groups.flatMap(g => g.variants), bookmarks);

    // Categories come from where the bookmarks actually live. The old code
    // hardcoded 'general', which made getPopularTagsByCategory() return []
    // for eight of the nine collections.
    for (const b of bookmarks) {
      const name = COLLECTION_NAMES[b.collection?.$id];
      if (!name) continue;
      for (const tag of b.tags || []) {
        if (!categoryOf.has(tag)) categoryOf.set(tag, name);
      }
    }
  }

  // 6. Apply, one call per group.
  console.log('\n🔀 Applying merges…');
  const applied = [];
  for (const g of groups) {
    await raindrop.mergeTags(g.canonical, g.variants);
    applied.push({ replace: g.canonical, tags: g.variants, reason: g.reason });
    console.log(`   ✅ ${g.canonical} ← ${g.variants.join(', ')}`);
  }

  // 7. Persist registry, undo log and metrics.
  const registry = await readJson(REGISTRY, { tags: {}, aliases: {} });
  updateRegistry(registry, groups, counts, categoryOf);

  const after = await raindrop.getTags(0).catch(() => counts);
  const metrics = {
    timestamp: new Date().toISOString(),
    runId,
    previousUniqueTagCount: before.unique,
    uniqueTagCount: DRY_RUN ? before.unique : after.size,
    tagsMerged: applied.reduce((s, a) => s + a.tags.length, 0),
    lexicalGroups: lexical.length,
    semanticGroups: semantic.length,
    singleUseBefore: before.singleUse,
    singleUseAfter: DRY_RUN ? before.singleUse : [...after.values()].filter(c => c === 1).length,
    dryRun: DRY_RUN,
  };

  if (DRY_RUN) {
    console.log(`\n🔎 Dry run complete — ${raindrop.writes.length} writes withheld:`);
    for (const w of raindrop.writes.slice(0, 20)) {
      console.log(`   ${w.method} ${w.path}  ${JSON.stringify(w.body)}`);
    }
    if (raindrop.writes.length > 20) console.log(`   … and ${raindrop.writes.length - 20} more`);
    return;
  }

  await fs.writeFile(REGISTRY, JSON.stringify(registry, null, 2));

  const log = await readJson(MERGE_LOG, { runs: [] });
  log.runs.push({ runId, appliedAt: new Date().toISOString(), merges: applied, provenance });
  await fs.writeFile(MERGE_LOG, JSON.stringify(log, null, 2));

  await writeMetrics(metrics);

  console.log(`\n✨ Cleanup complete`);
  console.log(`   Consolidated ${metrics.tagsMerged} duplicate tags`);
  console.log(`   Current unique tags: ${metrics.uniqueTagCount} (was ${metrics.previousUniqueTagCount})`);
  console.log(`   Revert this run with: node cleanup-existing-tags.js --revert ${runId}`);
}

main().catch(err => { console.error("❌", err.message); process.exit(1); });
