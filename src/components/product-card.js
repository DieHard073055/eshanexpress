import { formatCents, discountPercent, hasPriceRange } from '../lib/money.js';
import { imgAttrs } from '../lib/catalog.js';
import { esc } from './layout.js';
import { isPreorder, leadTimeLabel } from '../lib/preorder.js';

export function productCard(p) {
  const img = imgAttrs(p.thumb);
  const off = discountPercent(p.priceCents, p.compareAtCents);
  const out = !p.inStock;
  const pre = isPreorder(p);
  const low = p.inStock && !pre && p.stockTotal <= 5;

  const hasRange = hasPriceRange(p);

  return `
    <a href="#/product/${encodeURIComponent(p.sku)}"
       class="card group flex flex-col overflow-hidden transition hover:border-brand-500 hover:shadow-md">
      <div class="relative aspect-square overflow-hidden bg-neutral-100">
        <img src="${img.src}" srcset="${img.srcset}" sizes="${img.sizes}" alt="${esc(img.alt)}"
             loading="lazy" decoding="async"
             class="h-full w-full object-cover transition-transform duration-300 group-hover:scale-105
                    ${out ? 'opacity-50' : ''}" />
        ${off ? `<span class="absolute left-2 top-2 rounded bg-brand-600 px-1.5 py-0.5 text-[11px] font-bold text-white">-${off}%</span>` : ''}
        ${pre && !out ? `<span class="absolute right-2 top-2 rounded bg-sky-600 px-1.5 py-0.5 text-[11px] font-bold text-white">Preorder</span>` : ''}
        ${out ? `<span class="absolute inset-x-0 bottom-0 bg-neutral-900/75 py-1 text-center text-xs font-semibold text-white">Out of stock</span>` : ''}
      </div>

      <div class="flex flex-1 flex-col p-3">
        <h3 class="line-clamp-2 text-sm text-neutral-800 group-hover:text-brand-700">${esc(p.title)}</h3>
        <div class="mt-auto pt-2">
          <div class="flex items-baseline gap-1.5">
            ${hasRange ? `<span class="text-xs text-neutral-500">from</span>` : ''}
            <span class="text-base font-bold text-brand-600">${formatCents(p.priceFrom ?? p.priceCents)}</span>
            ${p.compareAtCents && p.compareAtCents > p.priceCents
              ? `<span class="text-xs text-neutral-400 line-through">${formatCents(p.compareAtCents)}</span>`
              : ''}
          </div>
          ${pre && !out
            ? `<p class="mt-1 text-[11px] font-medium text-sky-700">Ships in ${leadTimeLabel(p.leadTimeDays)}</p>`
            : low
              ? `<p class="mt-1 text-[11px] font-medium text-amber-600">Only ${p.stockTotal} left</p>`
              : ''}
        </div>
      </div>
    </a>`;
}
