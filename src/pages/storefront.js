import { loadCatalog, imgAttrs } from '../lib/catalog.js';
import { setCurrency } from '../lib/money.js';
import { setView, errorView, esc } from '../components/layout.js';
import { productCard } from '../components/product-card.js';

/**
 * Public storefront page for one store (#/store/:slug).
 *
 * The owner portal lives at #/store and #/store/products (src/pages/store.js)
 * — this is a different, customer-facing page, deliberately in its own file.
 *
 * Everything renders from the baked catalog. Decoration (banner/logo) is
 * optional: a store without them gets neutral placeholders, never a broken
 * image.
 */
export async function storefrontPage({ slug }) {
  let data;
  try {
    data = await loadCatalog();
  } catch (e) {
    return setView(errorView(e.message));
  }

  setCurrency(data.currency);

  const store = (data.stores ?? []).find((s) => s.slug === slug);
  if (!store) {
    return setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <h2 class="text-lg font-semibold">Store not found</h2>
        <p class="mt-2 text-sm text-neutral-600">
          This store may have been removed since you last visited.
        </p>
        <a href="#/" class="btn-primary mt-5">Continue shopping</a>
      </div>`);
  }

  const items = data.products
    .filter((p) => p.storeSlug === slug)
    // Cards take the trimmed "thumb" shape from the index payload; full
    // catalog products only have "images", so derive it here.
    .map((p) => ({ ...p, thumb: p.images?.[0] ?? null }));

  // Banner: 16:9 on a phone, wider cinemascope on desktop. Placeholder is a
  // flat brand-tinted panel with the store initial — never a broken <img>.
  const banner = store.banner
    ? (() => {
        const b = imgAttrs(store.banner, '(max-width: 640px) 100vw, 1152px');
        return `<img src="${b.src}" srcset="${b.srcset}" sizes="${b.sizes}" alt="${esc(store.name)} banner"
                      class="absolute inset-0 h-full w-full object-cover" />`;
      })()
    : `<div class="absolute inset-0 flex items-center justify-center bg-gradient-to-br from-brand-100 to-brand-50">
         <span class="text-5xl font-bold text-brand-300">${esc(store.name.trim().charAt(0).toUpperCase())}</span>
       </div>`;

  // Logo sits overlapping the banner's bottom-left corner.
  const logo = store.logo
    ? (() => {
        const l = imgAttrs(store.logo, '96px');
        return `<img src="${l.src}" srcset="${l.srcset}" sizes="${l.sizes}"
                    alt="${esc(store.name)} logo"
                    class="h-16 w-16 rounded-2xl border-4 border-white object-cover sm:h-20 sm:w-20" />`;
      })()
    : `<div class="flex h-16 w-16 items-center justify-center rounded-2xl border-4 border-white bg-brand-600
                  text-2xl font-bold text-white sm:h-20 sm:w-20">
         ${esc(store.name.trim().charAt(0).toUpperCase())}
       </div>`;

  setView(`
    <nav class="mb-4 text-sm text-neutral-500" aria-label="Breadcrumb">
      <a href="#/" class="hover:text-brand-600">Shop</a>
      <span aria-hidden="true"> / </span>
      <span class="text-neutral-700">${esc(store.name)}</span>
    </nav>

    <div class="card relative mb-10 overflow-hidden">
      <div class="relative aspect-video w-full sm:aspect-[21/9]">${banner}</div>
      <div class="flex items-end gap-4 px-4 pb-4 sm:px-6 sm:pb-5">
        <div class="-mt-8 shrink-0 sm:-mt-10">${logo}</div>
        <div class="min-w-0 flex-1 pt-3">
          <h1 class="truncate text-xl font-semibold sm:text-2xl">${esc(store.name)}</h1>
          <p class="mt-0.5 text-sm text-neutral-500">
            ${items.length} product${items.length === 1 ? '' : 's'}
          </p>
        </div>
      </div>
      ${store.blurb ? `<p class="border-t border-neutral-100 px-4 py-3 text-sm text-neutral-600 sm:px-6">${esc(store.blurb)}</p>` : ''}
    </div>

    ${items.length === 0
      ? `<div class="card p-12 text-center">
           <p class="font-medium text-neutral-700">No products right now</p>
           <p class="mt-1 text-sm text-neutral-500">Check back soon — new items are added regularly.</p>
           <a href="#/" class="btn-secondary mt-5">Back to all products</a>
         </div>`
      : `<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
           ${items.map(productCard).join('')}
         </div>`}
  `);
}
