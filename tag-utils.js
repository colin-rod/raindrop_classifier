// Shared tag vocabulary helpers.
//
// normalizeTag lived only in classify.js, which is why cleanup-existing-tags.js
// wrote raw model output straight into the registry and left us with "AI" and
// "ai" as separate canonical tags. Both entry points import from here now so
// there is exactly one definition of what a canonical tag looks like.

export function normalizeTag(tag) {
  return String(tag)
    .toLowerCase()
    .replace(/[^a-z0-9\s&-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 50);
}

export function levenshteinDistance(str1, str2) {
  const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }

  return matrix[str2.length][str1.length];
}

export function similarity(a, b) {
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - (levenshteinDistance(a, b) / maxLen);
}

// Singular forms whose plural is a different concept. Appending "s" is not a
// safe operation on these, and because merges apply unattended a false merge
// is worse than a missed one.
const PLURAL_MEANING_SHIFT = new Set([
  'new', 'good', 'custom', 'arm', 'glass', 'draft', 'saving', 'right', 'work',
]);

const MIN_PLURAL_STEM = 4;

// The plural forms a tag could take. We test pairs directly rather than
// stemming: stemming "movies" gives "movy", which would never meet "movie".
// Only pairs where both forms genuinely exist in the vocabulary are merged.
export function pluralForms(tag) {
  if (tag.length < MIN_PLURAL_STEM || PLURAL_MEANING_SHIFT.has(tag)) return [];
  const forms = [`${tag}s`, `${tag}es`];
  if (tag.endsWith('y')) forms.push(`${tag.slice(0, -1)}ies`);
  return forms;
}

// Pick the variant that should represent a group. Prefer the most-used tag, and
// break ties on the already-normalized form so we never promote "Donald Trump"
// over "donald-trump".
export function pickCanonical(variants, counts = new Map()) {
  return [...variants].sort((a, b) => {
    const byCount = (counts.get(b) || 0) - (counts.get(a) || 0);
    if (byCount !== 0) return byCount;

    const aNormal = normalizeTag(a) === a ? 0 : 1;
    const bNormal = normalizeTag(b) === b ? 0 : 1;
    if (aNormal !== bNormal) return aNormal - bNormal;

    return a.length - b.length || a.localeCompare(b);
  })[0];
}

/**
 * Deterministic grouping — no model, no judgement calls.
 *
 * Catches the two classes of duplicate that are provably safe to merge:
 *   1. tags identical once normalized  ("AI", "ai", "A.I." -> ai)
 *   2. singular/plural pairs of those  ("tv-show" / "tv-shows")
 *
 * Returns groups of two or more raw tags, each with the canonical to keep.
 * Anything genuinely requiring judgement is left for the semantic pass.
 */
export function lexicalGroups(tagCounts) {
  const counts = tagCounts instanceof Map ? tagCounts : new Map(Object.entries(tagCounts));

  const byNormal = new Map();
  for (const tag of counts.keys()) {
    const key = normalizeTag(tag);
    if (!key) continue;
    if (!byNormal.has(key)) byNormal.set(key, []);
    byNormal.get(key).push(tag);
  }

  // Fold singular/plural pairs together, but only when both forms actually
  // exist in the vocabulary. Union-find so "movie"/"movies"/"movi-es" chains
  // land in one group rather than several overlapping ones.
  const parent = new Map([...byNormal.keys()].map(k => [k, k]));
  const find = k => {
    while (parent.get(k) !== k) {
      parent.set(k, parent.get(parent.get(k)));
      k = parent.get(k);
    }
    return k;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const key of byNormal.keys()) {
    for (const plural of pluralForms(key)) {
      if (byNormal.has(plural)) union(key, plural);
    }
  }

  const clusters = new Map();
  for (const key of byNormal.keys()) {
    const root = find(key);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(key);
  }

  const groups = [];
  for (const normalKeys of clusters.values()) {
    const variants = normalKeys.flatMap(k => byNormal.get(k));
    if (variants.length < 2) continue;

    const canonical = normalizeTag(pickCanonical(variants, counts));
    const merged = variants.filter(v => v !== canonical);
    if (!merged.length) continue;

    groups.push({
      canonical,
      variants: merged,
      totalUses: variants.reduce((sum, v) => sum + (counts.get(v) || 0), 0),
      reason: 'identical after normalization',
    });
  }

  return groups.sort((a, b) => b.totalUses - a.totalUses);
}

/**
 * Guard against a run that would flatten the vocabulary. This is not a review
 * gate — it never asks anyone anything — it just refuses a single catastrophic
 * batch and lets the next scheduled run try again.
 */
export function circuitBreaker(vocabularySize, groups, maxShare = 0.4) {
  const merged = groups.reduce((sum, g) => sum + g.variants.length, 0);
  const share = vocabularySize > 0 ? merged / vocabularySize : 0;
  return {
    merged,
    share,
    tripped: share > maxShare,
    reason: share > maxShare
      ? `would merge ${merged}/${vocabularySize} tags (${(share * 100).toFixed(1)}%), above the ${(maxShare * 100).toFixed(0)}% ceiling`
      : null,
  };
}

/**
 * Plan the per-bookmark writes that undo a recorded run.
 *
 * A merge is lossy at the vocabulary level: once "AI" and "ai" are both "ai",
 * the tags API cannot tell the two populations apart, so a rename back would
 * also rewrite bookmarks that always said "ai". The only true inverse needs
 * per-bookmark provenance, which is why a run records which bookmark ids
 * carried each original tag before it merged them.
 *
 * Returns one operation per affected bookmark: drop the canonical, restore the
 * originals that bookmark actually had.
 */
export function plannedReverts(run) {
  const { merges = [], provenance = {} } = run;

  const canonicalOf = new Map();
  for (const { replace, tags } of merges) {
    for (const tag of tags) canonicalOf.set(tag, replace);
  }

  // bookmark id -> { remove: Set<canonical>, restore: Set<original> }
  const byBookmark = new Map();
  for (const [original, ids] of Object.entries(provenance)) {
    const canonical = canonicalOf.get(original);
    if (!canonical) continue;
    for (const id of ids) {
      if (!byBookmark.has(id)) byBookmark.set(id, { remove: new Set(), restore: new Set() });
      const entry = byBookmark.get(id);
      entry.remove.add(canonical);
      entry.restore.add(original);
    }
  }

  return [...byBookmark.entries()].map(([id, { remove, restore }]) => ({
    id,
    remove: [...remove],
    restore: [...restore],
  }));
}

/** Apply a planned revert to one bookmark's current tag list. */
export function revertTags(currentTags, { remove, restore }) {
  const kept = currentTags.filter(t => !remove.includes(t));
  return [...new Set([...kept, ...restore])];
}
