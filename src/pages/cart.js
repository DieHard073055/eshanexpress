import { loadCatalog, bySku, imgAttrs } from '../lib/catalog.js';
import { setCurrency, formatCents } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { resolve, setQty, remove, clear } from '../lib/cart.js';

export async function cartPage() {
  let data;
  try {
    data = await loadCatalog();
  } catch (e) {
    return setView(errorView(e.message));
  }

  setCurrency(data.currency);
  const index = bySku(data.products);
  const { items, stale, subtotalCents } = resolve(index);

  // Stale SKUs are surfaced, then dropped — silently losing items is worse.
  if (stale.length) {
    for (const sku of stale) remove(sku);
  }

  if (items.length === 0) {
    return setView(`
      ${stale.length ? staleNotice(stale) : ''}
      <div class="card p-12 text-center">
        <p class="text-lg font-medium text-neutral-700">Your cart is empty</p>
        <p class="mt-1 text-sm text-neutral-500">Browse the shop and add something you like.</p>
        <a href="#/" class="btn-primary mt-6">Start shopping</a>
      </div>`);
  }

  const unavailable = items.filter((i) => i.qty === 0);
  const buyable = items.filter((i) => i.qty > 0);

  setView(`
    ${stale.length ? staleNotice(stale) : ''}
    <h1 class="mb-5 text-xl font-semibold">Your cart</h1>

    <div class="grid gap-6 lg:grid-cols-[1fr_320px]">
      <div class="space-y-3">
        ${items.map((i) => row(i)).join('')}
        <button id="clear" class="text-sm text-neutral-500 hover:text-red-600">Clear cart</button>
      </div>

      <aside class="lg:sticky lg:top-20 lg:self-start">
        <div class="card p-5">
          <h2 class="font-semibold">Order summary</h2>
          <dl class="mt-4 space-y-2 text-sm">
            <div class="flex justify-between">
              <dt class="text-neutral-600">Subtotal (${buyable.reduce((n, i) => n + i.qty, 0)} items)</dt>
              <dd class="font-medium">${formatCents(subtotalCents)}</dd>
            </div>
            <div class="flex justify-between">
              <dt class="text-neutral-600">Delivery</dt>
              <dd class="text-neutral-500">Calculated at checkout</dd>
            </div>
          </dl>
          <div class="mt-4 flex justify-between border-t border-neutral-200 pt-4">
            <span class="font-semibold">Total</span>
            <span class="text-lg font-bold text-brand-600">${formatCents(subtotalCents)}</span>
          </div>

          ${unavailable.length ? `
            <p class="mt-3 rounded-lg bg-amber-50 p-2.5 text-xs text-amber-800">
              ${unavailable.length} item${unavailable.length === 1 ? ' is' : 's are'} out of stock and
              will not be ordered.
            </p>` : ''}

          <button id="checkout" class="btn-primary mt-5 w-full" ${buyable.length === 0 ? 'disabled' : ''}>
            Proceed to checkout
          </button>
          <p class="mt-3 text-center text-xs text-neutral-500">
            Pay by bank transfer, then upload your receipt.
          </p>
        </div>
      </aside>
    </div>
  `);

  for (const el of document.querySelectorAll('[data-qty]')) {
    el.addEventListener('change', (e) => {
      const sku = el.dataset.qty;
      const max = Number(el.max) || 1;
      const v = Math.min(Math.max(parseInt(e.target.value, 10) || 1, 1), max);
      setQty(sku, v);
      cartPage();
    });
  }

  for (const el of document.querySelectorAll('[data-remove]')) {
    el.addEventListener('click', () => {
      remove(el.dataset.remove);
      cartPage();
    });
  }

  document.getElementById('clear')?.addEventListener('click', () => {
    clear();
    cartPage();
  });

  document.getElementById('checkout')?.addEventListener('click', () => {
    // Checkout arrives in step 5 (auth + orders + receipt upload).
    toast('Checkout is coming next — cart is ready.');
  });
}

function staleNotice(skus) {
  return `<div class="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
    ${skus.length} item${skus.length === 1 ? '' : 's'} in your cart
    ${skus.length === 1 ? 'is' : 'are'} no longer sold and
    ${skus.length === 1 ? 'has' : 'have'} been removed.
  </div>`;
}

function row(i) {
  const img = imgAttrs(i.thumb, '96px');
  const out = i.qty === 0;
  return `
    <div class="card flex gap-3 p-3 ${out ? 'opacity-60' : ''}">
      <a href="#/product/${encodeURIComponent(i.sku)}" class="shrink-0">
        <img src="${img.src}" alt="${esc(img.alt)}" class="h-24 w-24 rounded-lg object-cover" />
      </a>

      <div class="flex min-w-0 flex-1 flex-col">
        <a href="#/product/${encodeURIComponent(i.sku)}" class="line-clamp-2 text-sm font-medium hover:text-brand-600">
          ${esc(i.title)}
        </a>
        <p class="mt-0.5 text-sm text-neutral-500">${formatCents(i.priceCents)} each</p>

        ${out
          ? `<p class="mt-1 text-xs font-medium text-red-600">Out of stock</p>`
          : i.clamped
            ? `<p class="mt-1 text-xs text-amber-600">Only ${i.stockTotal} available — quantity reduced</p>`
            : ''}

        <div class="mt-auto flex items-center gap-3 pt-2">
          <label class="sr-only" for="q-${i.sku}">Quantity for ${esc(i.title)}</label>
          <input id="q-${i.sku}" data-qty="${esc(i.sku)}" type="number" min="1" max="${Math.max(i.stockTotal, 1)}"
                 value="${Math.max(i.qty, 1)}" ${out ? 'disabled' : ''}
                 class="w-16 rounded-lg border border-neutral-300 px-2 py-1.5 text-sm" />
          <button data-remove="${esc(i.sku)}" class="text-sm text-neutral-500 hover:text-red-600">Remove</button>
        </div>
      </div>

      <div class="shrink-0 text-right">
        <p class="font-semibold">${formatCents(i.lineTotalCents)}</p>
      </div>
    </div>`;
}
