import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHistoryTime, pickCommitAt } from './historyAt.js';

const at = (iso) => Date.parse(iso);
const sec = (iso) => Math.floor(Date.parse(iso) / 1000);
// listed newest first, as git log walks them
const COMMITS = [
  { sha: 'c3', ts: sec('2026-10-23T20:47:59Z') },
  { sha: 'c2', ts: sec('2026-10-17T00:38:40Z') },
  { sha: 'c1', ts: sec('2025-05-20T16:37:06Z') },
];

test('before the first commit nothing was published', () => {
  const r = pickCommitAt(COMMITS, at('2025-05-20T16:37:05Z'));
  assert.deepEqual(r, { position: 'before', commit: null });
  assert.equal(pickCommitAt(COMMITS, at('2001-01-01T00:00:00Z')).position, 'before');
});

test('exactly at a commit time is that commit', () => {
  const r = pickCommitAt(COMMITS, at('2025-05-20T16:37:06Z'));
  assert.equal(r.position, 'exact');
  assert.equal(r.commit.sha, 'c1');
  assert.equal(pickCommitAt(COMMITS, at('2026-10-23T20:47:59Z')).commit.sha, 'c3');
  assert.equal(pickCommitAt(COMMITS, at('2026-10-23T20:47:59Z')).position, 'exact');
});

test('between two commits is the older one (still published)', () => {
  const r = pickCommitAt(COMMITS, at('2026-10-20T00:00:00Z'));
  assert.equal(r.position, 'between');
  assert.equal(r.commit.sha, 'c2');
  // one second before the newer commit
  const edge = pickCommitAt(COMMITS, at('2026-10-23T20:47:58.999Z'));
  assert.equal(edge.commit.sha, 'c2');
  assert.equal(edge.position, 'between');
});

test('after the latest commit is the latest edition', () => {
  const r = pickCommitAt(COMMITS, at('2026-10-26T00:00:00Z'));
  assert.equal(r.position, 'after');
  assert.equal(r.commit.sha, 'c3');
  assert.equal(pickCommitAt(COMMITS, at('2099-01-01T00:00:00Z')).commit.sha, 'c3');
});

test('sub-second times floor to the commit second', () => {
  const r = pickCommitAt(COMMITS, at('2025-05-20T16:37:06.999Z'));
  assert.equal(r.position, 'exact');
  assert.equal(r.commit.sha, 'c1');
});

test('commit times out of order: the newest time at or before t wins', () => {
  const skewed = [
    { sha: 'new', ts: sec('2026-10-10T00:00:00Z') },
    // listed older in the walk but stamped later (clock skew)
    { sha: 'skew', ts: sec('2026-10-12T00:00:00Z') },
    { sha: 'old', ts: sec('2026-10-01T00:00:00Z') },
  ];
  assert.equal(pickCommitAt(skewed, at('2026-10-13T00:00:00Z')).commit.sha, 'skew');
  assert.equal(pickCommitAt(skewed, at('2026-10-11T00:00:00Z')).commit.sha, 'new');
  assert.equal(pickCommitAt(skewed, at('2026-10-02T00:00:00Z')).commit.sha, 'old');
});

test('two commits in the same second: the one listed first (nearer the head)', () => {
  const same = [
    { sha: 'head', ts: 100 },
    { sha: 'parent', ts: 100 },
  ];
  assert.equal(pickCommitAt(same, 100_000).commit.sha, 'head');
});

test('no commits, junk entries and a bad time', () => {
  assert.equal(pickCommitAt([], 1).position, 'empty');
  assert.equal(pickCommitAt(null, 1).position, 'empty');
  assert.equal(pickCommitAt([{ sha: 1, ts: 'x' }, null], 1).position, 'empty');
  assert.equal(pickCommitAt(COMMITS, NaN).position, 'empty');
});

test('parseHistoryTime takes zoned ISO and epoch ms, refuses the rest', () => {
  assert.equal(parseHistoryTime('2026-10-23T16:47:59Z'), at('2026-10-23T16:47:59Z'));
  assert.equal(parseHistoryTime('2026-10-23T11:47:59.250-05:00'), at('2026-10-23T16:47:59.250Z'));
  assert.equal(parseHistoryTime('2026-10-23T16:47Z'), at('2026-10-23T16:47:00Z'));
  assert.equal(parseHistoryTime('1792788479000'), 1792788479000);
  for (const bad of [
    '',
    'now',
    '2026-10-23',
    '2026-10-23T16:47:59', // no zone: never guessed
    '2026-13-45T00:00:00Z',
    '1999-12-31T23:59:59Z',
    '2101-01-01T00:00:00Z',
    '-5',
    '1e12',
    '9'.repeat(17),
    'x'.repeat(41),
    null,
    undefined,
    12345,
  ])
    assert.equal(parseHistoryTime(bad), null, String(bad));
});
