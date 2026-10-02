import { test } from 'node:test';
import assert from 'node:assert/strict';
import { usageTotals, formatTokens, formatLimitReset, formatLimitCountdown, headerAllowances } from '../src/usage.js';

const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const bucket = (start, input, output, extra = {}) => ({ start, tokens: input + output, input, output, cached: 0, replies: 1, cost: 0, ...extra });

test('buckets add up into today and the last seven local days', () => {
  const now = new Date(2026, 9, 2, 15, 0);
  const report = { tools: [
    { id: 'claude', limits: [], plan: null, problem: null, buckets: [
      bucket(at(2026, 9, 25, 10), 1, 1),
      bucket(at(2026, 9, 26, 0, 15), 10, 20),
      bucket(at(2026, 10, 1, 23, 45), 100, 200),
      bucket(at(2026, 10, 2, 0, 0), 1000, 2000, { cached: 5000, cost: 0.5 }),
    ] },
    { id: 'codex', limits: [{ label: '5-hour', usedPercent: 33, resetsAt: null }], plan: 'plus', problem: null, buckets: [] },
  ] };
  const [claude, codex] = usageTotals(report, now);
  assert.deepEqual(claude.today, { tokens: 3000, input: 1000, output: 2000, cached: 5000, replies: 1, cost: 0.5 });
  assert.equal(claude.week.input, 1110, 'seven days counts back from midnight six days ago');
  assert.equal(claude.week.replies, 3);
  assert.equal(codex.plan, 'plus');
  assert.equal(codex.today.replies, 0);
});

test('token counts read at a glance', () => {
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(1500), '1.5K');
  assert.equal(formatTokens(2000), '2K');
  assert.equal(formatTokens(1985112), '2M');
  assert.equal(formatTokens(363291930), '363M');
});

test('limit resets show a time today, or a weekday further out', () => {
  const now = at(2026, 10, 2, 15);
  assert.doesNotMatch(formatLimitReset(at(2026, 10, 2, 20, 45), now), /Mon|Tue|Wed|Thu|Fri|Sat|Sun/);
  assert.match(formatLimitReset(at(2026, 10, 5, 9), now), /^Mon/);
});

test('countdowns round up and do not claim an expired allowance is unused', () => {
  const now = at(2026, 10, 2, 15);
  assert.equal(formatLimitCountdown(now + 1, now), '1m');
  assert.equal(formatLimitCountdown(now + 3_600_000, now), '1h');
  assert.equal(formatLimitCountdown(now + 4_800_000, now), '1h 20m');
  assert.equal(formatLimitCountdown(now + 3 * 86_400_000 + 2 * 3_600_000, now), '3d 2h');
  assert.equal(formatLimitCountdown(now, now), 'awaiting refresh');
});

test('header keeps each subscription visible and excludes ended windows', () => {
  const now = at(2026, 10, 2, 15);
  const report = { tools: [
    { id: 'claude', limits: [{ usedPercent: 100, resetsAt: now - 1 }, { usedPercent: 22, resetsAt: now + 1 }], limitsProblem: 'offline' },
    { id: 'codex', limits: [{ usedPercent: 33, resetsAt: null }, { usedPercent: 85, resetsAt: now + 1 }] },
    { id: 'gemini', limits: [] },
  ] };
  assert.deepEqual(headerAllowances(report, now), [
    { id: 'claude', usedPercent: 22, stale: true }, { id: 'codex', usedPercent: 85, stale: false },
  ]);
  assert.deepEqual(headerAllowances(null), []);
});
