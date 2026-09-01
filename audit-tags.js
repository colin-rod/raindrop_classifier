import 'dotenv/config';
import fetch from "node-fetch";
import fs from 'fs/promises';

// Read-only audit of the tag vocabulary across the ENTIRE Raindrop account.
// Makes no writes: no PUTs to Raindrop, no OpenAI calls, no changes to
// tag-registry.json. Safe to run at any time.
//
//   node audit-tags.js            # human-readable report
//   node audit-tags.js --json     # also writes tag-audit.json

const RAINDROP_TOKEN = process.env.RAINDROP_TOKEN;
const WRITE_JSON = process.argv.includes('--json');

// The nine collections the classifier manages. Everything outside these is a
// blind spot for cleanup-existing-tags.js, which iterates this list rather
// than scanning the whole account.
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path) {
  const resp = await fetch(`https://api.raindrop.io/rest/v1${path}`, {
    headers: { Authorization: `Bearer ${RAINDROP_TOKEN}` },
  });
  if (!resp.ok) throw new Error(`GET ${path} → ${resp.status} ${await resp.text()}`);
  return resp.json();
}

// Collection 0 means "all bookmarks" in the Raindrop API. Paginate it fully —
// deliberately no page cap, unlike getRandom.js / getFilterStats.js.
async function fetchEveryBookmark() {
  const requested = 50; // Raindrop documents 50 as the max
  const all = [];
  let page = 0;
  let honoured = null;

  while (true) {
    const data = await api(`/raindrops/0?perpage=${requested}&page=${page}`);
    const items = data.items || [];
    if (honoured === null && items.length) honoured = items.length;
    if (!items.length) break;

    all.push(...items);
    process.stdout.write(`\r   fetched ${all.length}…`);
    page++;
    await sleep(400); // stay under the 120 req/min limit
  }

  process.stdout.write('\r');
  return { bookmarks: all, pageSize: honoured, pages: page };
}

// Same normalisation classify.js applies, so we can see which "distinct" tags
// are pure formatting noise rather than genuinely different concepts.
function normalizeTag(tag) {
  return tag.toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

function singularise(tag) {
  return tag.replace(/ies$/, 'y').replace(/([^s])s$/, '$1');
}

function report(bookmarks, fetchMeta) {
  const usage = new Map();
  let untagged = 0;
  let taggedBookmarks = 0;
  let tagApplications = 0;
  const outsideClassifier = [];

  for (const b of bookmarks) {
    const tags = b.tags || [];
    if (!tags.length) {
      untagged++;
    } else {
      taggedBookmarks++;
      tagApplications += tags.length;
      for (const t of tags) usage.set(t, (usage.get(t) || 0) + 1);
    }
    const cid = b.collection?.$id;
    if (!CLASSIFIER_COLLECTIONS[cid]) outsideClassifier.push(cid);
  }

  const unique = usage.size;
  const counts = [...usage.values()];
  const totalUse = counts.reduce((s, c) => s + c, 0);
  const atMost = n => counts.filter(c => c <= n).length;

  const entropy = totalUse === 0 ? 0 : -counts.reduce((s, c) => {
    const p = c / totalUse;
    return p > 0 ? s + p * Math.log2(p) : s;
  }, 0);

  // Tags that collapse together under normalizeTag(): free wins, no judgement
  // call and no model needed.
  const byNormal = new Map();
  for (const t of usage.keys()) {
    const k = normalizeTag(t);
    if (!byNormal.has(k)) byNormal.set(k, []);
    byNormal.get(k).push(t);
  }
  const caseVariants = [...byNormal.entries()].filter(([, v]) => v.length > 1);

  // Singular/plural pairs that survive normalisation (tv-show vs tv-shows).
  const bySingular = new Map();
  for (const k of byNormal.keys()) {
    const s = singularise(k);
    if (!bySingular.has(s)) bySingular.set(s, []);
    bySingular.get(s).push(k);
  }
  const pluralPairs = [...bySingular.entries()].filter(([, v]) => v.length > 1);

  const collectionSpread = {};
  for (const cid of outsideClassifier) {
    const key = CLASSIFIER_COLLECTIONS[cid] || `unmanaged:${cid}`;
    collectionSpread[key] = (collectionSpread[key] || 0) + 1;
  }

  const pct = (n, d) => d ? (n / d * 100).toFixed(1) + '%' : '—';

  console.log('\n📊 Raindrop tag audit\n');
  console.log(`   Bookmarks in account       ${bookmarks.length}`);
  console.log(`   Fetched over               ${fetchMeta.pages} pages @ ${fetchMeta.pageSize}/page`);
  console.log(`   Tagged / untagged          ${taggedBookmarks} / ${untagged} (${pct(untagged, bookmarks.length)} untagged)`);
  console.log(`   Unique tags                ${unique}`);
  console.log(`   Tag applications           ${totalUse}`);
  console.log(`   Avg tags per tagged item   ${taggedBookmarks ? (tagApplications / taggedBookmarks).toFixed(2) : '—'}`);
  console.log(`   Avg uses per tag           ${unique ? (totalUse / unique).toFixed(2) : '—'}`);
  console.log(`   Shannon entropy            ${entropy.toFixed(2)}`);

  console.log('\n   The long tail');
  console.log(`     used once                ${atMost(1)}  (${pct(atMost(1), unique)} of tags)`);
  console.log(`     used once or twice       ${atMost(2)}  (${pct(atMost(2), unique)} of tags)`);
  console.log(`     used 3 times or fewer    ${atMost(3)}  (${pct(atMost(3), unique)} of tags)`);
  console.log(`     used 5 times or fewer    ${atMost(5)}  (${pct(atMost(5), unique)} of tags)`);

  const outside = outsideClassifier.length;
  console.log('\n   Coverage of the weekly cleanup');
  console.log(`     inside its 9 collections ${bookmarks.length - outside}`);
  console.log(`     invisible to it          ${outside}  (${pct(outside, bookmarks.length)} of the account)`);
  const unmanaged = Object.entries(collectionSpread)
    .filter(([k]) => k.startsWith('unmanaged:'))
    .sort((a, b) => b[1] - a[1]);
  if (unmanaged.length) {
    console.log('     largest unscanned collections:');
    for (const [k, n] of unmanaged.slice(0, 10)) console.log(`       ${String(n).padStart(5)}  ${k}`);
  }

  console.log(`\n   Free merges — identical after normalisation: ${caseVariants.length} groups`);
  for (const [k, v] of caseVariants.sort((a, b) => b[1].length - a[1].length).slice(0, 15)) {
    console.log(`     ${k}  ←  ${v.map(t => `${t}(${usage.get(t)})`).join(', ')}`);
  }

  console.log(`\n   Likely merges — singular/plural pairs: ${pluralPairs.length} groups`);
  for (const [, v] of pluralPairs.slice(0, 15)) {
    console.log(`     ${v.join('  ↔  ')}`);
  }

  console.log('\n   Top 25 tags');
  const top = [...usage.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25);
  for (const [t, c] of top) console.log(`     ${String(c).padStart(5)}  ${t}`);

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      bookmarks: bookmarks.length,
      tagged: taggedBookmarks,
      untagged,
      uniqueTags: unique,
      tagApplications: totalUse,
      entropy,
    },
    longTail: { usedOnce: atMost(1), usedTwiceOrFewer: atMost(2), usedThriceOrFewer: atMost(3) },
    cleanupBlindSpot: { invisibleBookmarks: outside, byCollection: collectionSpread },
    caseVariantGroups: Object.fromEntries(caseVariants),
    usage: Object.fromEntries([...usage.entries()].sort((a, b) => b[1] - a[1])),
  };
}

async function main() {
  if (!RAINDROP_TOKEN) {
    console.error('❌ RAINDROP_TOKEN is not set. Put it in .env or export it, then re-run.');
    process.exit(1);
  }

  console.log('📥 Fetching every bookmark in the account (read-only)…');
  const { bookmarks, pageSize, pages } = await fetchEveryBookmark();

  if (pageSize && pageSize < 50) {
    console.log(`ℹ️  Raindrop returned ${pageSize} items per page despite perpage=50.`);
    console.log('   getRandom.js and getFilterStats.js cap at 11 pages, so they reach');
    console.log(`   only ~${pageSize * 11} bookmarks.`);
  }

  const result = report(bookmarks, { pageSize, pages });

  if (WRITE_JSON) {
    await fs.writeFile('tag-audit.json', JSON.stringify(result, null, 2));
    console.log('\n💾 Wrote tag-audit.json');
  }
  console.log('');
}

main().catch(err => { console.error('❌', err.message); process.exit(1); });
