import { loadCatalog, imgAttrs } from '../lib/catalog.js';
import { setCurrency, formatCents, discountPercent } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { productCard } from '../components/product-card.js';
import { add } from '../lib/cart.js';
import { navigate } from '../lib/router.js';
import { isPreorder, leadTimeLabel, preorderNotice } from '../lib/preorder.js';
import {
  hasVariants, findVariant, defaultChoices, valueState, reconcile, describeChoices,
} from '../lib/variants.js';

export async function productPage({ sku }) {
  let data;
  try {
    data = await loadCatalog();
  } catch (e) {
    return setView(errorView(e.message));
  }

  setCurrency(data.currency);
  // The product page addresses the PARENT sku and needs the full product
  // (options and variants intact), so it does not use the orderable index.
  // A variant sku is redirected to its parent.
  let p = data.products.find((x) => x.sku === sku);
  if (!p) {
    const owner = data.products.find(
      (x) => (x.variants ?? []).some((v) => v.sku === sku));
    if (owner) return navigate(`/product/${encodeURIComponent(owner.sku)}`, { replace: true });
  }

  if (!p) {
    return setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <h2 class="text-lg font-semibold">Product not found</h2>
        <p class="mt-2 text-sm text-neutral-600">
          This item may have been removed since you last visited.
        </p>
        <a href="#/" class="btn-primary mt-5">Continue shopping</a>
      </div>`);
  }

  const store = data.stores.find((s) => s.slug === p.storeSlug);
  const pre = isPreorder(p);
  const variantProduct = hasVariants(p);

  // For a variant product the price, stock and cap all follow the current
  // selection, so they are recomputed by refresh() rather than fixed here.
  let choices = variantProduct ? defaultChoices(p) : {};
  let variant = variantProduct ? findVariant(p, choices) : null;

  const priceOf = () => (variant ? variant.priceCents : p.priceCents);
  const stockOf = () => (variant ? variant.stockTotal : p.stockTotal);
  const soldOut = () => stockOf() <= 0;
  const maxOf = () => Math.max(Math.min(stockOf(), p.maxPerOrder ?? Infinity), 1);

  const off = discountPercent(priceOf(), p.compareAtCents);
  const out = soldOut();
  const max = maxOf();

  const related = data.products
    .filter((r) => r.sku !== p.sku && (r.categories ?? []).some((c) => (p.categories ?? []).includes(c)))
    .slice(0, 4)
    .map((r) => ({ ...r, thumb: r.images[0] }));

  const hero = imgAttrs(p.images[0], '(max-width: 768px) 100vw, 480px');

  setView(`
    <nav class="mb-4 text-sm text-neutral-500" aria-label="Breadcrumb">
      <a href="#/" class="hover:text-brand-600">Shop</a>
      ${p.categories?.[0] ? ` <span aria-hidden="true">/</span>
        <a href="#/?cat=${encodeURIComponent(p.categories[0])}" class="hover:text-brand-600">${esc(p.categories[0])}</a>` : ''}
    </nav>

    <div class="grid gap-8 md:grid-cols-2">
      <div>
        <div class="card overflow-hidden">
          <img id="hero" src="${hero.src}" srcset="${hero.srcset}" sizes="${hero.sizes}"
               alt="${esc(hero.alt)}" class="aspect-square w-full object-cover" />
        </div>
        ${p.images.length > 1 ? `
          <div class="mt-3 flex gap-2">
            ${p.images.map((im, i) => {
              const t = imgAttrs(im, '80px');
              return `<button type="button" data-thumb="${i}"
                        class="thumb h-16 w-16 overflow-hidden rounded-lg border-2 ${i === 0 ? 'border-brand-500' : 'border-transparent'}"
                        aria-label="View image ${i + 1}">
                        <img src="${t.src}" alt="" class="h-full w-full object-cover" />
                      </button>`;
            }).join('')}
          </div>` : ''}
      </div>

      <div class="min-w-0">
        <h1 class="min-w-0 break-words text-xl font-semibold leading-snug sm:text-2xl">${esc(p.title)}</h1>
        ${store ? `<p class="mt-1.5 text-sm text-neutral-500">Sold by
          <a href="#/?store=${encodeURIComponent(store.slug)}" class="text-brand-600 hover:underline">${esc(store.name)}</a></p>` : ''}

        <div class="mt-4 flex items-baseline gap-2.5">
          <span id="price" class="text-2xl font-bold text-brand-600">${formatCents(priceOf())}</span>
          ${p.compareAtCents && p.compareAtCents > priceOf()
            ? `<span class="text-neutral-400 line-through">${formatCents(p.compareAtCents)}</span>
               <span class="rounded bg-brand-50 px-1.5 py-0.5 text-xs font-bold text-brand-700">-${off}%</span>` : ''}
        </div>

        ${variantProduct ? `
          <div class="mt-5 space-y-4">
            ${p.options.map((o) => `
              <fieldset data-option="${esc(o.name)}">
                <legend class="text-sm font-medium text-neutral-700">
                  ${esc(o.name)}:
                  <span data-chosen="${esc(o.name)}" class="font-normal text-neutral-500"></span>
                </legend>
                <div class="mt-2 flex flex-wrap gap-2">
                  ${o.values.map((v) => `
                    <button type="button" data-value="${esc(v)}" data-for="${esc(o.name)}"
                            class="opt rounded-lg border px-3 py-1.5 text-sm transition">
                      ${esc(v)}
                    </button>`).join('')}
                </div>
              </fieldset>`).join('')}
          </div>` : ''}

        ${pre && !out
          ? `<div class="mt-4 rounded-lg border border-sky-200 bg-sky-50 p-3">
               <p class="flex items-center gap-1.5 text-sm font-semibold text-sky-800">
                 <svg class="h-4 w-4" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true">
                   <circle cx="12" cy="12" r="9" /><path stroke-linecap="round" d="M12 7v5l3 2" />
                 </svg>
                 Preorder — ships in ${leadTimeLabel(p.leadTimeDays)}
               </p>
               <p class="mt-1 text-xs leading-relaxed text-sky-900">${esc(preorderNotice(p))}</p>
             </div>`
          : `<p id="stockline" class="mt-3 text-sm"></p>`}

        <div class="mt-6 flex items-center gap-3">
          <label for="qty" class="text-sm text-neutral-600">Qty</label>
          <input id="qty" type="number" min="1" max="${max}" value="1" ${out ? 'disabled' : ''}
                 class="w-20 rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          ${p.maxPerOrder ? `<span class="text-xs text-neutral-500">Max ${p.maxPerOrder} per order</span>` : ''}
        </div>

        <button id="add" class="btn-primary mt-4 w-full sm:w-auto sm:px-10" ${out ? 'disabled' : ''}>
          ${out ? 'Out of stock' : pre ? 'Preorder now' : 'Add to cart'}
        </button>

        <p class="mt-3 text-xs text-neutral-500">
          Stock shown was set at the last site update. Availability is confirmed at checkout.
        </p>

        ${p.description ? `
          <div class="mt-8 border-t border-neutral-200 pt-6">
            <h2 class="font-semibold">Description</h2>
            <p class="mt-2 whitespace-pre-line text-sm leading-relaxed text-neutral-700">${esc(p.description)}</p>
          </div>` : ''}

        ${p.specs && Object.keys(p.specs).length ? `
          <div class="mt-6">
            <h2 class="font-semibold">Specifications</h2>
            <dl class="mt-2 divide-y divide-neutral-100 text-sm">
              ${Object.entries(p.specs).map(([k, v]) => `
                <div class="flex flex-col gap-0.5 py-2 sm:flex-row sm:gap-4">
                  <dt class="text-neutral-500 sm:w-40 sm:shrink-0">${esc(k)}</dt>
                  <dd class="min-w-0 break-words text-neutral-800">${esc(v)}</dd>
                </div>`).join('')}
            </dl>
          </div>` : ''}
      </div>
    </div>

    ${related.length ? `
      <section class="mt-14">
        <h2 class="mb-4 text-lg font-semibold">You might also like</h2>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
          ${related.map(productCard).join('')}
        </div>
      </section>` : ''}
  `);

  // Keeps price, stock, quantity cap and the add button in step with the
  // current selection. Called once on load and after every picker change.
  function refresh() {
    variant = variantProduct ? findVariant(p, choices) : null;

    const price = priceOf();
    const stock = stockOf();
    const gone = stock <= 0;
    const cap = maxOf();

    const priceEl = document.getElementById('price');
    if (priceEl) priceEl.textContent = formatCents(price);

    const stockEl = document.getElementById('stockline');
    if (stockEl) {
      stockEl.textContent = gone ? 'Out of stock' : stock <= 5 ? `Only ${stock} left` : 'In stock';
      stockEl.className = `mt-3 text-sm ${
        gone ? 'text-red-600' : stock <= 5 ? 'text-amber-600' : 'text-green-700'}`;
    }

    const qty = document.getElementById('qty');
    if (qty) {
      qty.max = String(cap);
      qty.disabled = gone;
      if (Number(qty.value) > cap) qty.value = String(cap);
    }

    const addBtn = document.getElementById('add');
    if (addBtn) {
      addBtn.disabled = gone;
      addBtn.textContent = gone ? 'Out of stock' : pre ? 'Preorder now' : 'Add to cart';
    }

    // Reflect the selection on the pickers: current value highlighted,
    // impossible or sold-out values disabled rather than hidden.
    for (const btn of document.querySelectorAll('.opt')) {
      const name = btn.dataset.for;
      const value = btn.dataset.value;
      const state = valueState(p, name, value, choices);
      const active = choices[name] === value;

      btn.disabled = !state.exists;
      btn.className = `opt rounded-lg border px-3 py-1.5 text-sm transition ${
        active ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
        : !state.exists ? 'cursor-not-allowed border-neutral-200 text-neutral-300'
        : !state.inStock ? 'border-neutral-200 text-neutral-400 line-through'
        : 'border-neutral-300 text-neutral-700 hover:border-neutral-400'}`;
      btn.title = !state.exists ? 'Not available'
                : !state.inStock ? 'Sold out' : '';
    }

    for (const el of document.querySelectorAll('[data-chosen]')) {
      el.textContent = choices[el.dataset.chosen] ?? '';
    }

    // A variant image swaps the hero so the shopper sees what they picked.
    if (variant?.image) {
      const im = imgAttrs(variant.image, '(max-width: 768px) 100vw, 480px');
      const heroEl2 = document.getElementById('hero');
      if (heroEl2) { heroEl2.src = im.src; heroEl2.srcset = im.srcset; heroEl2.alt = im.alt; }
    }
  }

  for (const btn of document.querySelectorAll('.opt')) {
    btn.addEventListener('click', () => {
      const name = btn.dataset.for;
      // reconcile guarantees the result points at a real variant.
      choices = reconcile(p, { ...choices, [name]: btn.dataset.value }, name);
      refresh();
    });
  }

  if (variantProduct) refresh();

  // Thumbnail switching
  const heroEl = document.getElementById('hero');
  for (const btn of document.querySelectorAll('.thumb')) {
    btn.addEventListener('click', () => {
      const im = imgAttrs(p.images[Number(btn.dataset.thumb)], '(max-width: 768px) 100vw, 480px');
      heroEl.src = im.src;
      heroEl.srcset = im.srcset;
      heroEl.alt = im.alt;
      for (const b of document.querySelectorAll('.thumb')) {
        b.classList.toggle('border-brand-500', b === btn);
        b.classList.toggle('border-transparent', b !== btn);
      }
    });
  }

  document.getElementById('add')?.addEventListener('click', () => {
    // The VARIANT sku is what the cart and the server know about; the parent
    // sku has no stock row and could never be reserved.
    const orderSku = variant ? variant.sku : p.sku;
    const cap = maxOf();

    const input = document.getElementById('qty');
    const qty = Math.min(Math.max(parseInt(input.value, 10) || 1, 1), cap);
    input.value = String(qty);
    add(orderSku, qty, stockOf());
    toast(`Added ${qty} × ${p.title}${variant ? ` (${describeChoices(choices)})` : ''}`);
  });
}
