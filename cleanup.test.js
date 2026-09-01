// Tests for the parts of the consolidation engine that need no network:
// how model output is sanitised, and how the registry accumulates.
//   node --test cleanup.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitiseGroups, updateRegistry } from './tag-utils.js';

const counts = new Map(Object.entries({
  crypto: 5, cryptocurrency: 5, 'crypto-industry': 2,
  movies: 8, marvel: 7, ai: 40,
  // Real counts from the live vocabulary audit, not invented ones -- the
  // art/artificial-intelligence margin is genuinely narrow (197 vs 275).
  art: 197, 'artificial-intelligence': 275, ai: 48,
  video: 12, 'video-games': 30,
  security: 9, 'risk-management': 4,
  'software-development': 116, software: 30,
  'data-analytics': 225, 'data-analysis': 12,
}));

const syn = (canonical, variants, reason = 'same concept') =>
  ({ canonical, variants, relation: 'synonym', reason });

test('sanitise drops variants the model invented', () => {
  const { clean } = sanitiseGroups([syn('crypto', ['cryptocurrency', 'dogecoin-hype'])], counts);
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].variants, ['cryptocurrency'], 'dogecoin-hype is not a real tag');
});

test('sanitise rejects self-merges', () => {
  assert.deepEqual(sanitiseGroups([syn('crypto', ['crypto'])], counts).clean, []);
});

test('sanitise requires an explicit synonym relation', () => {
  // The model labelled this one "related medium" and we applied it anyway.
  const { clean, rejected } = sanitiseGroups(
    [{ canonical: 'video', variants: ['video-games'], relation: 'related', reason: 'related medium' }],
    counts
  );
  assert.deepEqual(clean, []);
  assert.match(rejected[0].why, /not "synonym"/);
});

test('sanitise rejects a reason that describes a relationship', () => {
  const { clean, rejected } = sanitiseGroups(
    [syn('security', ['risk-management'], 'related concept')],
    counts
  );
  assert.deepEqual(clean, [], 'a "related concept" is not an equivalence');
  assert.match(rejected[0].why, /relationship, not an equivalence/);
});

test('sanitise refuses to merge a more-used tag into a less-used one', () => {
  // art(197) <- artificial-intelligence(275): a prefix match that would have
  // retagged 275 AI bookmarks as "art". Caught only because the counts run the
  // safe way; a lexical rule cannot separate this from crypto/cryptocurrency.
  const { clean, rejected } = sanitiseGroups(
    [syn('art', ['artificial-intelligence'])],
    counts
  );
  assert.deepEqual(clean, []);
  assert.match(rejected[0].why, /used more than/);
});

test('sanitise rejects a canonical that is not a real tag', () => {
  const { clean, rejected } = sanitiseGroups([syn('ai-and-ml', ['ai'])], counts);
  assert.deepEqual(clean, []);
  assert.match(rejected[0].why, /not an existing tag/);
});

test('sanitise still allows a genuine synonym in the safe direction', () => {
  // data-analytics(18) <- data-analysis(6) was the one good merge proposed.
  const { clean } = sanitiseGroups([syn('data-analytics', ['data-analysis'])], counts);
  assert.equal(clean.length, 1);
  assert.deepEqual(clean[0].variants, ['data-analysis']);
});

test('every merge from the first live dry run is now judged correctly', () => {
  const proposed = [
    { canonical: 'art', variants: ['artificial-intelligence'], relation: 'synonym', reason: 'same concept' },
    { canonical: 'data-analytics', variants: ['data-analysis'], relation: 'synonym', reason: 'same concept' },
    { canonical: 'video', variants: ['video-games'], relation: 'synonym', reason: 'related medium' },
    { canonical: 'security', variants: ['risk-management'], relation: 'synonym', reason: 'related concept' },
    { canonical: 'software-development', variants: ['software'], relation: 'synonym', reason: 'related concept' },
  ];
  const { clean } = sanitiseGroups(proposed, counts);
  assert.deepEqual(
    clean.map(g => `${g.canonical}<-${g.variants.join(',')}`),
    ['data-analytics<-data-analysis'],
    'only the one true synonym survives'
  );
});

test('sanitise normalizes the canonical name', () => {
  const withUpper = new Map([...counts, ['Crypto Currency', 4]]);
  const { clean } = sanitiseGroups([syn('crypto', ['Crypto Currency'])], withUpper);
  assert.equal(clean[0].canonical, 'crypto');
});

test('a tag can only be claimed by one group', () => {
  const { clean } = sanitiseGroups([
    syn('crypto', ['cryptocurrency']),
    syn('movies', ['cryptocurrency']),
  ], counts);
  assert.equal(clean.length, 1);
  assert.equal(clean[0].canonical, 'crypto');
});

test('a canonical already merged away cannot host a new group', () => {
  const { clean } = sanitiseGroups([
    syn('crypto', ['cryptocurrency']),
    syn('cryptocurrency', ['crypto-industry']),
  ], counts);
  assert.equal(clean.length, 1, 'second group would resurrect a merged tag');
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
