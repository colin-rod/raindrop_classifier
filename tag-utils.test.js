// Fixture-based tests for the deterministic tag paths. No network, no model.
//   node --test tag-utils.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeTag, similarity, pluralForms, pickCanonical,
  lexicalGroups, circuitBreaker, plannedReverts, revertTags,
} from './tag-utils.js';

test('normalizeTag produces canonical form', () => {
  assert.equal(normalizeTag('Donald Trump'), 'donald-trump');
  assert.equal(normalizeTag('AI'), 'ai');
  assert.equal(normalizeTag('A.I.'), 'ai');
  assert.equal(normalizeTag('go-to-market strategies'), 'go-to-market-strategies');
  assert.equal(normalizeTag('  --Foo  Bar--  '), 'foo-bar');
  assert.equal(normalizeTag('TV Review'), 'tv-review');
  // idempotent: normalizing twice changes nothing
  for (const t of ['Donald Trump', 'A.I.', '  --Foo  Bar--  ']) {
    assert.equal(normalizeTag(normalizeTag(t)), normalizeTag(t));
  }
});

test('lexical grouping merges case and punctuation variants', () => {
  const groups = lexicalGroups(new Map([['AI', 3], ['ai', 40], ['A.I.', 1]]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonical, 'ai');
  assert.deepEqual(groups[0].variants.sort(), ['A.I.', 'AI']);
  assert.equal(groups[0].totalUses, 44);
});

test('lexical grouping merges genuine singular/plural pairs', () => {
  const groups = lexicalGroups(new Map([['movie', 2], ['movies', 8]]));
  assert.equal(groups.length, 1);
  assert.equal(groups[0].canonical, 'movies');
  assert.deepEqual(groups[0].variants, ['movie']);
});

test('lexical grouping refuses plurals that change meaning', () => {
  // "new" -> "news" is a different concept, and merges apply unattended.
  assert.deepEqual(lexicalGroups(new Map([['new', 1], ['news', 3]])), []);
  // guarded by the stoplist even at length >= 4
  assert.deepEqual(lexicalGroups(new Map([['work', 5], ['works', 2]])), []);
  // guarded by minimum stem length
  assert.deepEqual(pluralForms('cat'), []);
});

test('lexical grouping leaves semantic duplicates alone', () => {
  // crypto/cryptocurrency is a real merge, but it needs judgement --
  // the deterministic pass must not guess at it.
  assert.deepEqual(lexicalGroups(new Map([['crypto', 5], ['cryptocurrency', 5]])), []);
  assert.deepEqual(lexicalGroups(new Map([['marvel', 7], ['movies', 8]])), []);
});

test('canonical is the most-used variant, preferring normalized form', () => {
  const counts = new Map([['Donald Trump', 4], ['donald-trump', 1]]);
  assert.equal(normalizeTag(pickCanonical(['Donald Trump', 'donald-trump'], counts)), 'donald-trump');
  const tie = new Map([['a-b', 2], ['A B', 2]]);
  assert.equal(pickCanonical(['A B', 'a-b'], tie), 'a-b');
});

test('circuit breaker trips only on catastrophic runs', () => {
  assert.equal(circuitBreaker(100, [{ variants: ['a', 'b'] }]).tripped, false);
  const tripped = circuitBreaker(10, [{ variants: ['a', 'b', 'c', 'd', 'e'] }]);
  assert.equal(tripped.tripped, true);
  assert.match(tripped.reason, /above the 40% ceiling/);
  assert.equal(circuitBreaker(0, []).tripped, false);
});

test('a merge round-trips back to the original per-bookmark tags', () => {
  // Bookmark 1 said "AI", bookmark 2 said "ai" all along, bookmark 3 said "A.I.".
  // After merging they all read "ai" and are indistinguishable at the vocabulary
  // level -- only recorded provenance can separate them again.
  const run = {
    merges: [{ replace: 'ai', tags: ['AI', 'A.I.'] }],
    provenance: { 'AI': ['1'], 'A.I.': ['3'] },
  };

  const plan = plannedReverts(run);
  assert.equal(plan.length, 2, 'only bookmarks that actually changed are touched');

  const byId = Object.fromEntries(plan.map(p => [p.id, p]));
  assert.deepEqual(revertTags(['ai', 'llm'], byId['1']), ['llm', 'AI']);
  assert.deepEqual(revertTags(['ai'], byId['3']), ['A.I.']);

  // Bookmark 2 was never in the provenance, so it keeps "ai" untouched --
  // this is the case a naive rename-back would have corrupted.
  assert.equal(byId['2'], undefined);
});

test('revert restores every original a bookmark carried', () => {
  const run = {
    merges: [{ replace: 'ai', tags: ['AI', 'A.I.'] }],
    provenance: { 'AI': ['7'], 'A.I.': ['7'] },
  };
  const [op] = plannedReverts(run);
  assert.deepEqual(revertTags(['ai', 'news'], op).sort(), ['A.I.', 'AI', 'news']);
});

test('revert ignores provenance for tags no merge touched', () => {
  const plan = plannedReverts({ merges: [], provenance: { 'orphan': ['1'] } });
  assert.deepEqual(plan, []);
});

test('similarity is a ratio, not a raw distance', () => {
  assert.equal(similarity('ai', 'ai'), 1);
  assert.ok(similarity('tv-show', 'tv-shows') > 0.8);
  assert.ok(similarity('crypto', 'cryptocurrency') < 0.8);
});
