import fs from 'fs/promises';
import { normalizeTag } from './tag-utils.js';

// One-off, idempotent repair of tag-registry.json.
//
// Three defects accumulated because cleanup-existing-tags.js wrote raw model
// output as canonical keys and rebuilt the file from scratch each run:
//
//   1. keys not in canonical form ("Donald Trump", "TV Review", "AI")
//   2. tags that are canonical AND an alias of a different tag, so each week
//      one pass renamed them and the next re-created them
//   3. entries missing the `variants` field
//
// Run with --write to apply; prints a diff otherwise.

const WRITE = process.argv.includes('--write');
const PATH = 'tag-registry.json';

const registry = JSON.parse(await fs.readFile(PATH, 'utf8'));
const tags = registry.tags || {};
const aliases = registry.aliases || {};

const notes = [];
const repaired = {};
const newAliases = { ...aliases };

function absorb(target, key, entry) {
  const existing = target[key];
  if (!existing) {
    target[key] = {
      category: entry.category || 'general',
      usageCount: entry.usageCount || 0,
      firstUsed: entry.firstUsed || new Date().toISOString(),
      variants: [...new Set(entry.variants || [])],
    };
    return;
  }
  existing.usageCount += entry.usageCount || 0;
  existing.firstUsed = [existing.firstUsed, entry.firstUsed].filter(Boolean).sort()[0];
  existing.variants = [...new Set([...existing.variants, ...(entry.variants || [])])];
  // A real collection name always beats the placeholder 'general'.
  if (existing.category === 'general' && entry.category && entry.category !== 'general') {
    existing.category = entry.category;
  }
}

// 1 + 3: normalize keys, backfill missing variants.
for (const [key, entry] of Object.entries(tags)) {
  const canonical = normalizeTag(key);
  if (!canonical) {
    notes.push(`dropped empty key ${JSON.stringify(key)}`);
    continue;
  }
  if (canonical !== key) {
    notes.push(`renamed ${JSON.stringify(key)} → "${canonical}"`);
    // The old spelling becomes an alias so live bookmarks still resolve.
    newAliases[key] = canonical;
  }
  if (!entry.variants) notes.push(`backfilled variants: [] on "${canonical}"`);
  absorb(repaired, canonical, entry);
}

// 2: a tag cannot be both canonical and an alias of something else — that
// contradiction is what made these tags churn, renamed by one pass and
// re-created by the next.
//
// Which side wins depends on evidence. A canonical entry that has collected its
// own variants is a real group head, so we keep it and drop the stray alias:
// folding "investigation" (which owns "Crypto Scam", "Money Laundering",
// "Tether") into "workers" would drag all of those with it. A bare canonical
// with no variants of its own has nothing to lose, so the alias wins.
for (const key of Object.keys(repaired)) {
  const target = newAliases[key];
  if (!target || target === key) continue;

  const canonicalTarget = normalizeTag(target);
  if (canonicalTarget === key) continue;

  const entry = repaired[key];
  const ownVariants = (entry.variants || []).length;

  if (ownVariants > 0) {
    notes.push(`"${key}" kept canonical (owns ${ownVariants} variants); dropped stray alias → "${canonicalTarget}"`);
    delete newAliases[key];
    continue;
  }

  notes.push(`"${key}" was a bare canonical and an alias of "${canonicalTarget}" — folded in`);
  delete repaired[key];
  absorb(repaired, canonicalTarget, { ...entry, variants: [...(entry.variants || []), key] });
}

// Aliases must never point at something that is itself an alias, or at a tag
// that no longer exists as a canonical.
for (const [variant, target] of Object.entries(newAliases)) {
  let resolved = normalizeTag(target);
  const seen = new Set();
  while (newAliases[resolved] && !seen.has(resolved)) {
    seen.add(resolved);
    resolved = normalizeTag(newAliases[resolved]);
  }
  if (resolved !== normalizeTag(target)) notes.push(`alias "${variant}" now points at "${resolved}"`);
  newAliases[variant] = resolved;
  if (repaired[variant]) delete repaired[variant];
}

const out = {
  tags: Object.fromEntries(Object.entries(repaired).sort(([a], [b]) => a.localeCompare(b))),
  aliases: Object.fromEntries(Object.entries(newAliases).sort(([a], [b]) => a.localeCompare(b))),
  lastUpdated: new Date().toISOString(),
};

const contradictions = Object.keys(out.tags).filter(t => out.aliases[t]);
const malformed = Object.keys(out.tags).filter(t => normalizeTag(t) !== t);
const noVariants = Object.entries(out.tags).filter(([, v]) => !v.variants).length;

console.log(`Canonical tags : ${Object.keys(tags).length} → ${Object.keys(out.tags).length}`);
console.log(`Aliases        : ${Object.keys(aliases).length} → ${Object.keys(out.aliases).length}`);
console.log(`Usage retained : ${Object.values(tags).reduce((s, v) => s + (v.usageCount || 0), 0)} → ${Object.values(out.tags).reduce((s, v) => s + v.usageCount, 0)}`);
console.log(`\nChanges (${notes.length}):`);
for (const n of notes) console.log('  ' + n);

console.log(`\nPost-conditions:`);
console.log(`  malformed keys remaining      ${malformed.length}`);
console.log(`  canonical/alias contradictions ${contradictions.length}`);
console.log(`  entries missing variants       ${noVariants}`);

if (malformed.length || contradictions.length || noVariants) {
  console.error('\n❌ Repair did not reach a clean state.');
  process.exit(1);
}

if (WRITE) {
  await fs.writeFile(PATH, JSON.stringify(out, null, 2));
  console.log(`\n💾 Wrote ${PATH}`);
} else {
  console.log('\n(run with --write to apply)');
}
