/**
 * Metric definitions for the owner analytics strip.
 *
 * aggregateOrders is the single source of truth for what "revenue" and
 * "this month" mean; the UI only formats the result.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { aggregateOrders, AWAITING_STATUSES } from '../src/lib/analytics.js';

const order = (over) => ({ total_cents: 10000, status: 'fulfilled', fulfilled_at: '2026-09-10T10:00:00', ...over });
// A fixed "now": 15 Sep 2026, mid-month, in the viewer's local time.
const NOW = new Date(2026, 8, 15, 12, 0, 0);

describe('aggregateOrders', () => {
  test('sums fulfilled revenue and counts, split by local month boundary', () => {
    const rows = [
      order({ total_cents: 5000, fulfilled_at: '2026-09-01T00:00:01' }),   // this month
      order({ total_cents: 7000, fulfilled_at: '2026-09-14T23:59:59' }),   // this month
      order({ total_cents: 9000, fulfilled_at: '2026-08-31T23:59:59' }),   // last month
      order({ total_cents: 3000, fulfilled_at: '2026-01-05T08:00:00' }),   // long ago
    ];
    const a = aggregateOrders(rows, NOW);
    assert.equal(a.revenueMonth, 12000);
    assert.equal(a.ordersMonth, 2);
    assert.equal(a.revenueAll, 24000);
    assert.equal(a.ordersAll, 4);
    assert.equal(a.hasFulfilled, true);
  });

  test('a confirmed order is awaiting action, not revenue', () => {
    const a = aggregateOrders([
      order({ status: 'confirmed' }),
      order({ status: 'ready_for_pickup' }),
      order({ status: 'shipped' }),
    ], NOW);
    assert.equal(a.revenueAll, 0, 'unfulfilled orders leaked into revenue');
    assert.equal(a.revenueMonth, 0);
    assert.equal(a.awaiting, 3);
    assert.equal(a.hasFulfilled, false);
  });

  test('declined and cancelled orders count toward nothing', () => {
    const a = aggregateOrders([
      order({ status: 'declined' }),
      order({ status: 'cancelled' }),
      order({ status: 'awaiting_payment' }),
      order({ status: 'payment_submitted' }),
    ], NOW);
    assert.equal(a.revenueAll, 0);
    assert.equal(a.awaiting, 0);
    assert.equal(a.hasFulfilled, false);
  });

  test('awaiting statuses are exactly the three the queue shows', () => {
    assert.deepEqual(AWAITING_STATUSES, ['confirmed', 'ready_for_pickup', 'shipped']);
  });

  test('the month boundary uses the viewer\'s local month', () => {
    // fulfilled_at on the first of the month local time counts as this month
    const first = new Date(2026, 8, 1, 0, 0, 1);
    const a = aggregateOrders([order({ fulfilled_at: first.toISOString() })], NOW);
    assert.equal(a.ordersMonth, 1);
    // one second before midnight on the last day of the previous month does not
    const prev = new Date(2026, 7, 31, 23, 59, 59);
    const b = aggregateOrders([order({ fulfilled_at: prev.toISOString() })], NOW);
    assert.equal(b.ordersMonth, 0);
    assert.equal(b.ordersAll, 1);
  });

  test('empty input is a clean zero state', () => {
    const a = aggregateOrders([], NOW);
    assert.deepEqual(a, {
      revenueMonth: 0, ordersMonth: 0, revenueAll: 0, ordersAll: 0,
      awaiting: 0, hasFulfilled: false,
    });
    assert.equal(aggregateOrders(undefined, NOW).hasFulfilled, false);
  });
});
