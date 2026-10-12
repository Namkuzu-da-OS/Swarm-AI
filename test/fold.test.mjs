import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fold, parseCommand, parseTask } from '../scripts/lib/fold.mjs';

const OLD = '2020-01-01T00:00:00Z';
const body = (project = 'acme/app', extra = '') =>
  `### Project\n\n${project}\n\n### What and why\n\nDo the thing.\n\n### Done when\n\n- [ ] tests pass\n\n### Priority\n\n1 (first)\n\n### Size\n\nS (one session)\n\n### Depends on\n\n${extra || '_No response_'}`;
let seq = 0;
const c = (login, text, at, assoc = 'NONE', created = OLD) => ({
  id: String(++seq), body: text, createdAt: at, authorAssociation: assoc, author: { login, type: 'User', createdAt: created },
});
const task = (number, comments = [], over = {}) => ({
  number, title: `T${number}`, url: `https://github.com/hub/x/issues/${number}`, body: body(), state: 'OPEN',
  createdAt: '2026-10-11T00:00:00Z', authorAssociation: 'OWNER', author: { login: 'owner' }, comments, ...over,
});
const at = (h) => new Date(Date.UTC(2026, 9, 11) + h * 3600e3).toISOString();
const NOW = { now: at(4) };
const get = (out, n) => out.tasks.find((t) => t.number === n);

test('parses commands and issue-form sections', () => {
  assert.deepEqual(parseCommand('/claim agent=claude machine="atlas box"\nhi').args, { agent: 'claude', machine: 'atlas box' });
  assert.equal(parseCommand('please /claim'), null);
  assert.equal(parseCommand('/rm -rf'), null);
  const m = parseTask({ body: body('https://github.com/acme/app', '#3, #4') });
  assert.equal(m.project, 'acme/app');
  assert.equal(m.priority, 1);
  assert.equal(m.size, 'S');
  assert.deepEqual(m.depends, [3, 4]);
});

test('first claim wins; the second is refused', () => {
  const out = fold([task(1, [c('ann', '/claim agent=claude', at(1)), c('bob', '/claim', at(1.1))])], NOW);
  assert.equal(get(out, 1).status, 'claimed');
  assert.equal(get(out, 1).claim.login, 'ann');
  assert.deepEqual(out.results.map((r) => r.ok), [true, false]);
});

test('a claim lapses without a heartbeat, and progress keeps it alive', () => {
  const lapsed = fold([task(1, [c('ann', '/claim', at(0))])], { now: at(3.5) });
  assert.equal(get(lapsed, 1).status, 'open');
  const alive = fold([task(1, [c('ann', '/claim', at(0)), c('ann', '/progress tests green', at(2))])], { now: at(3.5) });
  assert.equal(get(alive, 1).status, 'claimed');
  assert.equal(get(alive, 1).note, 'tests green');
  const stolen = fold([task(1, [c('ann', '/claim', at(0)), c('bob', '/claim', at(3.5))])], { now: at(4) });
  assert.equal(get(stolen, 1).claim.login, 'bob');
});

test('per-user claim cap', () => {
  const out = fold([1, 2, 3].map((n) => task(n, [c('ann', '/claim', at(1))])), NOW);
  assert.deepEqual(out.tasks.map((t) => t.status), ['claimed', 'claimed', 'open']);
});

test('new accounts cannot claim', () => {
  const out = fold([task(1, [c('fresh', '/claim', at(1), 'NONE', at(0))])], NOW);
  assert.equal(get(out, 1).status, 'open');
  assert.equal(out.results[0].ok, false);
});

test('outside tasks start proposed until a maintainer approves', () => {
  const t = task(1, [c('ann', '/claim', at(1)), c('owner', '/approve', at(2), 'OWNER'), c('ann', '/claim', at(3))], { authorAssociation: 'NONE' });
  const out = fold([t], NOW);
  assert.equal(get(out, 1).status, 'claimed');
  assert.deepEqual(out.results.map((r) => r.ok), [false, true, true]);
});

test('tasks outside the project allowlist stay proposed', () => {
  const out = fold([task(1)], { ...NOW, config: { projects: ['other/repo'] } });
  assert.equal(get(out, 1).status, 'proposed');
});

test('submit checks the repo and the claimant; done needs a different maintainer', () => {
  const pr = 'https://github.com/acme/app/pull/7';
  const prs = { [pr]: { author: 'ann' } };
  const out = fold([task(1, [
    c('ann', '/claim', at(1)),
    c('bob', `/submit ${pr}`, at(1.5)),
    c('ann', '/submit https://github.com/evil/app/pull/1', at(1.6)),
    c('ann', `/submit ${pr}`, at(2)),
    c('ann', '/done', at(2.5), 'COLLABORATOR'),
    c('owner', '/done', at(3), 'OWNER'),
  ])], { ...NOW, prs });
  assert.deepEqual(out.results.map((r) => r.ok), [true, false, false, true, false, true]);
  const t = get(out, 1);
  assert.equal(t.status, 'done');
  assert.equal(t.credit.login, 'ann');
  assert.equal(t.approvedBy, 'owner');
});

test('a PR merged by someone else ships the task; a self-merge does not', () => {
  const pr = 'https://github.com/acme/app/pull/7';
  const hist = [c('ann', '/claim', at(1)), c('ann', `/submit ${pr}`, at(2))];
  const shipped = fold([task(1, hist)], { ...NOW, prs: { [pr]: { author: 'ann', merged: true, mergedAt: at(3), mergedBy: 'owner' } } });
  assert.equal(get(shipped, 1).status, 'done');
  const self = fold([task(1, hist)], { ...NOW, prs: { [pr]: { author: 'ann', merged: true, mergedAt: at(3), mergedBy: 'ann' } } });
  assert.equal(get(self, 1).status, 'review');
  const closed = fold([task(1, hist)], { ...NOW, prs: { [pr]: { author: 'ann', closed: true, closedAt: at(3) } } });
  assert.equal(get(closed, 1).status, 'open');
});

test('a PR opened by someone else is refused', () => {
  const pr = 'https://github.com/acme/app/pull/7';
  const out = fold([task(1, [c('ann', '/claim', at(1)), c('ann', `/submit ${pr}`, at(2))])], { ...NOW, prs: { [pr]: { author: 'mallory' } } });
  assert.equal(get(out, 1).status, 'claimed');
});

test('dependencies must ship first', () => {
  const t2 = task(2, [c('ann', '/claim', at(1))], { body: body('acme/app', '#1') });
  const out = fold([task(1), t2], NOW);
  assert.equal(get(out, 2).status, 'open');
});

test('bot comments are ignored; manual close then /reopen', () => {
  const bot = { id: 'b', body: '/done', createdAt: at(1), authorAssociation: 'NONE', author: { login: 'github-actions', type: 'Bot' } };
  assert.equal(get(fold([task(1, [bot])], NOW), 1).status, 'open');
  const closed = task(1, [c('owner', '/reopen', at(3), 'OWNER')], { state: 'CLOSED', closedAt: at(2), stateReason: 'NOT_PLANNED' });
  assert.equal(get(fold([closed], NOW), 1).status, 'open');
  const stillClosed = task(1, [], { state: 'CLOSED', closedAt: at(2), stateReason: 'NOT_PLANNED' });
  assert.equal(get(fold([stillClosed], NOW), 1).status, 'closed');
});

test('max lease lifetime and fleet caps', () => {
  const beats = [c('ann', '/claim', at(0)), ...[2, 4, 6, 8].map((h) => c('ann', '/progress', at(h)))];
  assert.equal(get(fold([task(1, beats)], { now: at(8.5) }), 1).status, 'open');
  const many = [1, 2, 3, 4].map((n) => task(n, [c('fleet', '/claim', at(1))]));
  assert.equal(fold(many, { ...NOW, config: { fleet: { fleet: 10 } } }).tasks.filter((t) => t.status === 'claimed').length, 4);
});

test('submit needs a verifiable PR', () => {
  const pr = 'https://github.com/acme/app/pull/7';
  const out = fold([task(1, [c('ann', '/claim', at(1)), c('ann', `/submit ${pr}`, at(2))])], NOW);
  assert.equal(get(out, 1).status, 'claimed');
  assert.equal(out.results[1].code, 'INVALID_PR');
});
