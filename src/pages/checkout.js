import { loadCatalog, bySku } from '../lib/catalog.js';
import { setCurrency, formatCents } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { resolve, clear } from '../lib/cart.js';
import { getUser } from '../lib/auth.js';
import { supabase, isConfigured } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';
import { leadTimeLabel } from '../lib/preorder.js';

/** Bank details the customer transfers to. Shown after the order is placed. */
const BANK = {
  bank: 'Bank of Maldives',
  accountName: 'EshanExpress',
  accountNumber: '7730000000000',
};

export async function checkoutPage() {
  if (!isConfigured) return setView(errorView('Checkout is not available yet.'));
  if (!getUser()) return navigate('/signin?next=/checkout', { replace: true });

  let data;
  try {
    data = await loadCatalog();
  } catch (e) {
    return setView(errorView(e.message));
  }
  setCurrency(data.currency);

  const index = bySku(data.products);
  const { items, subtotalCents } = resolve(index);
  const buyable = items.filter((i) => i.qty > 0);

  if (buyable.length === 0) {
    return setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <p class="font-medium text-neutral-700">Nothing to check out</p>
        <a href="#/" class="btn-primary mt-5">Back to shop</a>
      </div>`);
  }

  // One order per store keeps fulfilment and RLS simple. Mixed-store carts
  // are rejected rather than silently split.
  const stores = [...new Set(buyable.map((i) => index.get(i.sku).storeSlug))];
  if (stores.length > 1) {
    return setView(`
      <div class="card mx-auto max-w-md p-8 text-center">
        <h2 class="font-semibold">Items from different sellers</h2>
        <p class="mt-2 text-sm text-neutral-600">
          Your cart has items from ${stores.length} sellers. Please check out
          from one seller at a time.
        </p>
        <a href="#/cart" class="btn-primary mt-5">Back to cart</a>
      </div>`);
  }

  const longest = buyable.reduce((m, i) => Math.max(m, i.leadTimeDays ?? 0), 0);

  setView(`
    <div class="mx-auto max-w-2xl">
      <h1 class="text-xl font-semibold">Checkout</h1>

      <div class="card mt-4 divide-y divide-neutral-100">
        ${buyable.map((i) => `
          <div class="flex items-center justify-between gap-4 p-4">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">${esc(i.title)}</p>
              <p class="text-xs text-neutral-500">${i.qty} × ${formatCents(i.priceCents)}</p>
            </div>
            <p class="shrink-0 text-sm font-semibold">${formatCents(i.lineTotalCents)}</p>
          </div>`).join('')}
        <div class="flex items-center justify-between p-4">
          <span class="font-semibold">Total to transfer</span>
          <span class="text-lg font-bold text-brand-600">${formatCents(subtotalCents)}</span>
        </div>
      </div>

      ${longest ? `
        <p class="mt-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">
          This order includes preorder items and ships in ${leadTimeLabel(longest)}.
        </p>` : ''}

      <div class="card mt-4 p-5">
        <h2 class="font-semibold">How payment works</h2>
        <ol class="mt-3 space-y-2 text-sm text-neutral-700">
          <li>1. Place the order below to get your order number.</li>
          <li>2. Transfer the total to our bank account.</li>
          <li>3. Upload a photo of the receipt so we can match your payment.</li>
        </ol>
        <p class="mt-3 text-xs text-neutral-500">
          Nothing is charged automatically — you make the transfer yourself.
        </p>
      </div>

      <p id="err" class="mt-4 hidden rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>

      <button id="place" class="btn-primary mt-5 w-full py-3">
        Place order · ${formatCents(subtotalCents)}
      </button>
      <a href="#/cart" class="mt-3 block text-center text-sm text-neutral-500 hover:text-brand-600">
        Back to cart
      </a>
    </div>`);

  document.getElementById('place').addEventListener('click', async () => {
    const btn = document.getElementById('place');
    const err = document.getElementById('err');
    btn.disabled = true;
    btn.textContent = 'Placing order…';
    err.classList.add('hidden');

    const { data: result, error } = await supabase.rpc('place_order', {
      p_items: buyable.map((i) => ({
        sku: i.sku, qty: i.qty, unit_price: i.priceCents, title: i.title,
      })),
      p_total_cents: subtotalCents,
      p_store_slug: stores[0],
    });

    if (error || !result?.ok) {
      // Stock failures name the specific SKU so the message is actionable.
      let message = 'Could not place the order. Please try again.';
      if (result?.reason === 'stock') {
        const f = result.failures?.[0];
        const title = index.get(f?.sku)?.title ?? f?.sku;
        if (f?.reason === 'insufficient_stock') {
          message = `Sorry — only ${f.available} of “${title}” left. Adjust your cart and try again.`;
        } else if (f?.reason === 'exceeds_max_per_order') {
          message = `“${title}” is limited to ${f.max_per_order} per order.`;
        } else {
          message = `“${title}” is no longer available.`;
        }
      } else if (error?.message?.includes('authentication')) {
        message = 'Your session expired. Please sign in again.';
      }
      err.textContent = message;
      err.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = `Place order · ${formatCents(subtotalCents)}`;
      return;
    }

    clear();
    toast('Order placed');
    navigate(`/order/${result.order_id}`, { replace: true });
  });
}

export function bankDetails() {
  return BANK;
}
