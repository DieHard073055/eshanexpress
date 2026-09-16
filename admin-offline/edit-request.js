/**
 * Owner edit requests — the pure logic shared by the admin editor and the
 * test suite.
 *
 * An owner asks to change fields on one of their live products by submitting
 * a product_draft whose payload is a diff ({ kind: 'edit', ...fields }) and
 * whose target_sku names the catalog product. Approval is deliberately
 * guarded here, NOT left to the admin's attention:
 *
 *   - target_sku must exist in the catalog
 *   - the product must belong to the submitting store (cross-store requests
 *     are refused — RLS cannot check this against a static catalog)
 *   - only the editable fields are honoured; anything else in the payload is
 *     reported in `ignored`, never applied
 *
 * Loaded as an ES module by admin-offline/products.html (which exposes it as
 * window.EditDrafts) and imported directly by tests/edit-request.test.mjs.
 */

export const EDITABLE_FIELDS = ['priceCents', 'stockTotal', 'description', 'hidden'];

const VALIDATORS = {
  priceCents: (v) => Number.isInteger(v) && v >= 0,
  stockTotal: (v) => Number.isInteger(v) && v >= 0,
  description: (v) => typeof v === 'string',
  hidden: (v) => typeof v === 'boolean',
};

export const EDITABLE_LABELS = {
  priceCents: 'Price',
  stockTotal: 'Stock',
  description: 'Description',
  hidden: 'Hidden',
};

/**
 * Human-readable diff rows for the admin UI: one per editable field the
 * payload actually carries. Non-editable keys are ignored here too — the
 * approval handler re-checks independently.
 */
export function buildEditDiff(payload, current) {
  const rows = [];
  for (const field of EDITABLE_FIELDS) {
    if (payload?.[field] === undefined) continue;
    rows.push({ field, from: current?.[field] ?? null, to: payload[field] });
  }
  return rows;
}

/**
 * Apply an edit request to the products array (mutates the matching product).
 *
 * Returns { ok: true, product, changes, ignored } or
 *         { ok: false, reason }.
 */
export function applyEditRequest({ targetSku, payload, storeSlug }, products) {
  if (!targetSku || !payload || typeof payload !== 'object') {
    return { ok: false, reason: 'malformed request' };
  }

  const product = products.find((p) => p.sku === targetSku);
  if (!product) return { ok: false, reason: `sku ${targetSku} is not in the catalog` };
  if (product.storeSlug !== storeSlug) {
    return { ok: false, reason: `${targetSku} belongs to ${product.storeSlug}, not ${storeSlug}` };
  }
  // Price and stock live on each variant for variant products; a flat edit
  // would be meaningless, so those stay admin-only (like the portal UI).
  if (Array.isArray(product.variants) && product.variants.length) {
    return { ok: false, reason: 'variant products are changed by the administrator' };
  }

  const changes = {};
  const ignored = Object.keys(payload).filter((k) => k !== 'kind' && !EDITABLE_FIELDS.includes(k));

  for (const field of EDITABLE_FIELDS) {
    const value = payload[field];
    if (value === undefined) continue;
    if (!VALIDATORS[field](value)) {
      return { ok: false, reason: `invalid ${field} value` };
    }
    changes[field] = value;
  }

  if (!Object.keys(changes).length) {
    return { ok: false, reason: 'request changes nothing editable' };
  }

  Object.assign(product, changes);
  return { ok: true, product, changes, ignored };
}

// Browser hook: the admin editor is a classic inline script, so the module
// exposes itself on window. Node tests import the exports directly.
if (typeof window !== 'undefined') {
  window.EditDrafts = { EDITABLE_FIELDS, EDITABLE_LABELS, buildEditDiff, applyEditRequest };
}
