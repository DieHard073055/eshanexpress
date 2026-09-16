/**
 * Order analytics for the store-owner portal.
 *
 * Pure aggregation over the order rows RLS already scoped to the owner's
 * store — the query returns only their orders, so no store filtering happens
 * here. Kept free of DOM/Supabase imports so the test suite can attack the
 * metric definitions directly.
 *
 * Only `fulfilled` counts as revenue: `confirmed` means paid but not yet
 * handed over, and counting it would overstate earnings — worse, it would
 * move backwards when the order is later declined or cancelled. The UI
 * states this beside the numbers.
 */

export const AWAITING_STATUSES = ['confirmed', 'ready_for_pickup', 'shipped'];

/**
 * @param orders  rows shaped { total_cents, status, fulfilled_at }
 * @param now     injectable clock; defaults to the viewer's now. The month
 *                boundary is the viewer's LOCAL month, computed client-side.
 */
export function aggregateOrders(orders, now = new Date()) {
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  let revenueMonth = 0;
  let ordersMonth = 0;
  let revenueAll = 0;
  let ordersAll = 0;
  let awaiting = 0;

  for (const o of orders ?? []) {
    if (AWAITING_STATUSES.includes(o.status)) awaiting++;

    if (o.status !== 'fulfilled') continue;
    revenueAll += o.total_cents ?? 0;
    ordersAll++;
    if (o.fulfilled_at && new Date(o.fulfilled_at) >= monthStart) {
      revenueMonth += o.total_cents ?? 0;
      ordersMonth++;
    }
  }

  return {
    revenueMonth,
    ordersMonth,
    revenueAll,
    ordersAll,
    awaiting,
    // Drives the zero state: no fulfilled orders ever → "No completed
    // orders yet", not MVR 0.00 in large type.
    hasFulfilled: ordersAll > 0,
  };
}
