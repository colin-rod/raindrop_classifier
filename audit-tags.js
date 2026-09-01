import 'dotenv/config';
import fs from 'fs/promises';
import { RaindropClient } from './raindrop-api.js';
import { normalizeTag, lexicalGroups } from './tag-utils.js';

// Read-only audit of the tag vocabulary across the ENTIRE account.
// No writes to Raindrop, no OpenAI calls, no changes to tag-registry.json.
//
//   node audit-tags.js           vocabulary report (one API call)
//   node audit-tags.js --deep    also walks every bookmark, for the untagged
//                                count and the cleanup blind-spot breakdown
//   node audit-tags.js --json    also writes tag-audit.json

const DEEP = process.argv.includes('--deep');
const WRITE_JSON = process.argv.includes('--json');

// The nine collections classify.js manages. Anything outside them was invisible
// to the old cleanup, which iterated this list instead of scanning the account.
const CLASSIFIER_COLLECTIONS = {
  59437707: "AI & Technology",
  59437708: "Entertainment & Media",
  59437709: "Business & Startups",
  59437710: "Career & Professional Development",
  59437711: "Politics & Current Affairs",
  59437712: "Lifestyle & Practical",
  59437713: "Finance & Economics",
  59437715: "Global & Cultural",
  59437777: "Others"
};

const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';

function summarise(counts) {
  const values = [...counts.values()];
  const unique = counts.size;
  const totalUse = values.reduce((s, c) => s + c, 0);
  const atMost = n => values.filter(c => c <= n).length;

  const entropy = totalUse === 0 ? 0 : -values.reduce((s, c) => {
    const p = c / totalUse;
    return p > 0 ? s + p * Math.log2(p) : s;
  }, 0);

  return { unique, totalUse, atMost, entropy };
}

function reportVocabulary(counts) {
  const { unique, totalUse, atMost, entropy } = summarise(counts);
  const malformed = [...counts.keys()].filter(t => normalizeTag(t) !== t);
  const free = lexicalGroups(counts);
  const freeMerges = free.reduce((s, g) => s + g.variants.length, 0);

  console.log('\n📊 Raindrop tag audit\n');
  console.log(`   Unique tags                ${unique}`);
  console.log(`   Tag applications           ${totalUse}`);
  console.log(`   Avg uses per tag           ${unique ? (totalUse / unique).toFixed(2) : '—'}`);
  console.log(`   Shannon entropy            ${entropy.toFixed(2)}`);

  console.log('\n   The long tail');
  for (const n of [1, 2, 3, 5]) {
    const label = n === 1 ? 'used once' : `used ${n} times or fewer`;
    console.log(`     ${label.padEnd(24)} ${String(atMost(n)).padStart(4)}  (${pct(atMost(n), unique)} of tags)`);
  }

  console.log('\n   Not in canonical form');
  console.log(`     ${String(malformed.length).padStart(4)} tags  (${pct(malformed.length, unique)})`);
  if (malformed.length) {
    console.log(`     e.g. ${malformed.slice(0, 8).map(t => JSON.stringify(t)).join(', ')}`);
  }

  console.log(`\n   Free merges — no judgement required: ${free.length} groups, ${freeMerges} tags absorbed`);
  for (const g of free.slice(0, 15)) {
    console.log(`     ${g.canonical}  ←  ${g.variants.map(v => `${v}(${counts.get(v) || 0})`).join(', ')}`);
  }
  if (free.length > 15) console.log(`     … and ${free.length - 15} more`);

  console.log('\n   Top 25 tags');
  for (const [t, c] of [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`     ${String(c).padStart(5)}  ${t}`);
  }

  return { unique, totalUse, entropy, atMost, malformed, free, freeMerges };
}

function reportBookmarks(bookmarks) {
  let untagged = 0;
  const outside = [];

  for (const b of bookmarks) {
    if (!(b.tags || []).length) untagged++;
    const cid = b.collection?.$id;
    if (!CLASSIFIER_COLLECTIONS[cid]) outside.push(cid);
  }

  const spread = {};
  for (const cid of outside) {
    const key = `unmanaged:${cid}`;
    spread[key] = (spread[key] || 0) + 1;
  }

  console.log('\n   Library');
  console.log(`     bookmarks                ${bookmarks.length}`);
  console.log(`     untagged                 ${untagged}  (${pct(untagged, bookmarks.length)})`);

  console.log('\n   Coverage of the old cleanup (9 hardcoded collections)');
  console.log(`     inside                   ${bookmarks.length - outside.length}`);
  console.log(`     invisible to it          ${outside.length}  (${pct(outside.length, bookmarks.length)})`);
  const unmanaged = Object.entries(spread).sort((a, b) => b[1] - a[1]);
  if (unmanaged.length) {
    console.log('     largest unscanned collections:');
    for (const [k, n] of unmanaged.slice(0, 10)) console.log(`       ${String(n).padStart(5)}  ${k}`);
  }

  return { bookmarks: bookmarks.length, untagged, invisible: outside.length, byCollection: spread };
}

async function main() {
  const client = new RaindropClient(process.env.RAINDROP_TOKEN);

  console.log('📥 Reading the tag vocabulary (GET /tags/0)…');
  const counts = await client.getTags(0);
  const vocabulary = reportVocabulary(counts);

  let library = null;
  if (DEEP) {
    console.log('\n📥 Walking every bookmark (--deep)…');
    const bookmarks = await client.allBookmarks({
      onProgress: n => process.stdout.write(`\r   fetched ${n}…`),
    });
    process.stdout.write('\r');
    library = reportBookmarks(bookmarks);
  } else {
    console.log('\n   (run with --deep for untagged counts and the blind-spot breakdown)');
  }

  if (WRITE_JSON) {
    await fs.writeFile('tag-audit.json', JSON.stringify({
      generatedAt: new Date().toISOString(),
      vocabulary: {
        unique: vocabulary.unique,
        tagApplications: vocabulary.totalUse,
        entropy: vocabulary.entropy,
        usedOnce: vocabulary.atMost(1),
        usedTwiceOrFewer: vocabulary.atMost(2),
        malformed: vocabulary.malformed,
        freeMergeGroups: vocabulary.free.length,
        freeMergeTags: vocabulary.freeMerges,
      },
      library,
      usage: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
    }, null, 2));
    console.log('\n💾 Wrote tag-audit.json');
  }
  console.log('');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
