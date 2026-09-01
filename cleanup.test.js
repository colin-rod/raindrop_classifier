// Tests for the parts of the consolidation engine that need no network:
// how model output is sanitised, and how the registry accumulates.
//   node --test cleanup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The engine imports OpenAI at module load, so exercise the two pure functions
// by evaluating them out of the source rather than importing the whole module.
const src = readFileSync(new URL('./cleanup-existing-tags.js', import.meta.url), 'utf8');
const extract = name => {
  const start = src.indexOf(`function ${name}(`);
  const from = src.indexOf('{', start);
  let depth = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
};

const { normalizeTag } = await import('./tag-utils.js');
const sanitiseGroups = eval(`(${extract('sanitiseGroups')})`);
const updateRegistry = eval(`(${extract('updateRegistry')})`);

const counts = new Map(Object.entries({
  crypto: 5, cryptocurrency: 5, 'crypto-industry': 2,
  movies: 8, marvel: 7, ai: 40,
}));

test('sanitise drops variants the model invented', () => {
  const out = sanitiseGroups(
    [{ canonical: 'crypto', variants: ['cryptocurrency', 'dogecoin-hype'] }],
    counts
  );
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].variants, ['cryptocurrency'], 'dogecoin-hype is not a real tag');
});

test('sanitise rejects self-merges', () => {
  assert.deepEqual(sanitiseGroups([{ canonical: 'crypto', variants: ['crypto'] }], counts), []);
});

test('sanitise normalizes the canonical name', () => {
  const out = sanitiseGroups([{ canonical: 'Crypto Currency', variants: ['cryptocurrency'] }], counts);
  assert.equal(out[0].canonical, 'crypto-currency');
});

test('a tag can only be claimed by one group', () => {
  const out = sanitiseGroups([
    { canonical: 'crypto', variants: ['cryptocurrency'] },
    { canonical: 'movies', variants: ['cryptocurrency'] },
  ], counts);
  assert.equal(out.length, 1);
  assert.equal(out[0].canonical, 'crypto');
});

test('a canonical already merged away cannot host a new group', () => {
  const out = sanitiseGroups([
    { canonical: 'crypto', variants: ['cryptocurrency'] },
    { canonical: 'cryptocurrency', variants: ['crypto-industry'] },
  ], counts);
  assert.equal(out.length, 1, 'second group would resurrect a merged tag');
});

test('registry accumulates instead of resetting', () => {
  const registry = {
    tags: { crypto: { category: 'Finance & Economics', usageCount: 5, firstUsed: '2024-01-01T00:00:00Z', variants: ['Crypto'] } },
    aliases: { Crypto: 'crypto' },
  };
  updateRegistry(registry, [{ canonical: 'crypto', variants: ['cryptocurrency'] }], counts, new Map());

  assert.equal(registry.tags.crypto.firstUsed, '2024-01-01T00:00:00Z', 'firstUsed is preserved');
  assert.equal(registry.tags.crypto.usageCount, 10, 'counts are summed across merged tags');
  assert.deepEqual(registry.tags.crypto.variants.sort(), ['Crypto', 'cryptocurrency']);
  assert.equal(registry.tags.crypto.category, 'Finance & Economics', 'existing category survives');
});

test('a merged tag never remains canonical', () => {
  // This is the bug that left film canonical AND an alias of movies.
  const registry = {
    tags: { movies: { usageCount: 8 }, film: { usageCount: 4 } },
    aliases: {},
  };
  updateRegistry(registry, [{ canonical: 'movies', variants: ['film'] }], counts, new Map());

  assert.equal(registry.tags.film, undefined, 'film is gone from canonical tags');
  assert.equal(registry.aliases.film, 'movies');
  const contradictions = Object.keys(registry.tags).filter(t => registry.aliases[t]);
  assert.deepEqual(contradictions, [], 'no tag is both canonical and an alias');
});

test('real collection names replace the hardcoded "general"', () => {
  const registry = { tags: {}, aliases: {} };
  const categoryOf = new Map([['crypto', 'Finance & Economics']]);
  updateRegistry(registry, [{ canonical: 'crypto', variants: ['cryptocurrency'] }], counts, categoryOf);
  assert.equal(registry.tags.crypto.category, 'Finance & Economics');
});
