import { count, onCartChange } from '../lib/cart.js';
import { getUser } from '../lib/auth.js';
import { isConfigured } from '../lib/supabase.js';

/** Escape untrusted strings before they touch innerHTML. */
export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

export function header() {
  return `
    <header class="sticky top-0 z-20 border-b border-neutral-200 bg-white/95 backdrop-blur">
      <div class="mx-auto max-w-6xl px-3 py-2.5 sm:px-4 sm:py-3">
        <div class="flex items-center gap-2 sm:gap-3">
          <a href="#/" class="shrink-0 text-base font-bold tracking-tight text-brand-600 sm:text-lg">
            Eshan<span class="text-neutral-900">Express</span>
          </a>

          <!-- Full-width search on its own row below on mobile (order-3); a
               single row on sm+, where there is room for it beside the logo. -->
          <form id="search-form" role="search"
                class="order-3 mt-2 w-full min-w-0 sm:order-none sm:ml-2 sm:mt-0 sm:max-w-none sm:flex-1">
            <label for="q" class="sr-only">Search products</label>
            <input id="q" name="q" type="search" placeholder="Search products…" autocomplete="off"
                   class="w-full min-w-0 rounded-lg border border-neutral-300 bg-neutral-50 px-3 py-2 text-sm
                          placeholder:text-neutral-400 focus:border-brand-500 focus:bg-white" />
          </form>

          <a id="account-link" href="#/signin"
             class="ml-auto shrink-0 rounded-lg p-2 text-neutral-700 hover:bg-neutral-100 sm:ml-0"
             aria-label="Account">
            <svg class="h-6 w-6 sm:hidden" fill="none" stroke="currentColor" stroke-width="1.8"
                 viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                    d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.25a7.5 7.5 0 0 1 15 0" />
            </svg>
            <span id="account-label" class="hidden text-sm font-medium sm:inline">Sign in</span>
          </a>

          <a href="#/cart" class="relative shrink-0 rounded-lg p-2 hover:bg-neutral-100" aria-label="Cart">
            <svg class="h-6 w-6" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
              <path stroke-linecap="round" stroke-linejoin="round"
                    d="M2.25 3h1.4a1.5 1.5 0 0 1 1.47 1.19L5.4 6m0 0 1.6 7.6a1.5 1.5 0 0 0 1.47 1.19h7.8a1.5 1.5 0 0 0 1.46-1.14l1.4-5.6A.75.75 0 0 0 18.4 6H5.4Z" />
              <circle cx="9" cy="19.5" r="1.4" /><circle cx="16.5" cy="19.5" r="1.4" />
            </svg>
            <span id="cart-badge"
                  class="absolute -right-0.5 -top-0.5 hidden min-w-[1.15rem] rounded-full bg-brand-600
                         px-1 text-center text-[11px] font-semibold leading-[1.15rem] text-white"></span>
          </a>
        </div>
      </div>
    </header>`;
}

export function footer() {
  return `
    <footer class="mt-16 border-t border-neutral-200 bg-white">
      <div class="mx-auto max-w-6xl px-4 py-8 text-sm text-neutral-500">
        <p>&copy; ${new Date().getFullYear()} EshanExpress</p>
        <p class="mt-1">Payment by bank transfer. Upload your receipt at checkout.</p>
      </div>
    </footer>`;
}

export function refreshAuthUi() {
  const link = document.getElementById('account-link');
  const label = document.getElementById('account-label');
  if (!link || !label) return;
  // Hidden entirely when Supabase is not configured, so the header never
  // offers sign-in that cannot work.
  link.classList.toggle('hidden', !isConfigured);
  if (!isConfigured) return;
  const user = getUser();
  link.href = user ? '#/account' : '#/signin';
  label.textContent = user ? 'Account' : 'Sign in';
}

export function refreshCartBadge() {
  const badge = document.getElementById('cart-badge');
  if (!badge) return;
  const n = count();
  badge.textContent = n > 99 ? '99+' : String(n);
  badge.classList.toggle('hidden', n === 0);
}

export function mountChrome(onSearch) {
  document.getElementById('app').innerHTML = `
    ${header()}
    <main id="view" class="mx-auto min-h-[60vh] max-w-6xl px-4 py-6"></main>
    ${footer()}`;

  const form = document.getElementById('search-form');
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    onSearch(document.getElementById('q').value.trim());
  });

  refreshCartBadge();
  onCartChange(refreshCartBadge);
}

export function setView(html) {
  document.getElementById('view').innerHTML = html;
}

/** Non-blocking toast; polite so screen readers announce without interrupting. */
export function toast(message) {
  let el = document.getElementById('toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.className =
      'fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-neutral-900 px-4 py-2.5 ' +
      'text-sm font-medium text-white shadow-lg transition-opacity';
    document.body.appendChild(el);
  }
  el.textContent = message;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.style.opacity = '0'), 2200);
}

export function skeletonGrid(n = 8) {
  return `<div class="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
    ${Array.from({ length: n }).map(() => `
      <div class="card overflow-hidden">
        <div class="skeleton aspect-square"></div>
        <div class="space-y-2 p-3">
          <div class="skeleton h-3.5 w-full rounded"></div>
          <div class="skeleton h-3.5 w-2/3 rounded"></div>
          <div class="skeleton h-5 w-1/3 rounded"></div>
        </div>
      </div>`).join('')}
  </div>`;
}

export function errorView(message, retryHash = '#/') {
  return `
    <div class="card mx-auto max-w-md p-8 text-center">
      <h2 class="text-lg font-semibold">Something went wrong</h2>
      <p class="mt-2 text-sm text-neutral-600">${esc(message)}</p>
      <a href="${retryHash}" class="btn-primary mt-5">Back to shop</a>
    </div>`;
}
