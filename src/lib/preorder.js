/**
 * Preorder presentation.
 *
 * A preorder item is ordinary stock with a lead time — you set a soft cap you
 * are willing to order from overseas. The lead time drives the messaging so
 * it cannot be forgotten on an individual product description.
 */

export function isPreorder(p) {
  return Boolean(p?.leadTimeDays);
}

/** "about 5 weeks" — rounded to a unit a shopper actually reasons about. */
export function leadTimeLabel(days) {
  if (!days) return '';
  if (days < 14) return `about ${days} days`;
  const weeks = Math.round(days / 7);
  if (weeks < 9) return `about ${weeks} weeks`;
  const months = Math.round(days / 30);
  return `about ${months} month${months === 1 ? '' : 's'}`;
}

/** Short badge for dense surfaces (cards, cart lines). */
export function preorderBadge(p) {
  if (!isPreorder(p)) return '';
  return `Preorder · ships in ${leadTimeLabel(p.leadTimeDays)}`;
}

/** Explicit sentence for the product page and checkout. */
export function preorderNotice(p) {
  if (!isPreorder(p)) return '';
  return `This item is ordered from overseas and ships in ${leadTimeLabel(p.leadTimeDays)}. `
       + `Your payment is taken now and the order is placed once confirmed.`;
}
