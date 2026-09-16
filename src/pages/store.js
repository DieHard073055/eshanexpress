import { setCurrency, formatCents } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { getUser, getProfile } from '../lib/auth.js';
import { supabase, isConfigured } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';
import { loadCatalog } from '../lib/catalog.js';
import { aggregateOrders } from '../lib/analytics.js';

/**
 * Store-owner portal.
 *
 * Everything here is enforced server-side by RLS and the order guard trigger:
 * the UI only decides what to *show*. An owner who bypassed this page could
 * still do nothing beyond marking their own store's confirmed orders ready or
 * shipped, and completing them with the customer's handover code.
 */

const QUEUES = {
  confirmed:        { label: 'To prepare',   tone: 'sky'   },
  ready_for_pickup: { label: 'Awaiting collection', tone: 'green' },
  shipped:          { label: 'Out for delivery',    tone: 'green' },
};

const TONE = {
  sky:   'bg-sky-50 text-sky-800 border-sky-200',
  green: 'bg-green-50 text-green-800 border-green-200',
};

/** Guard: signed in, and holds a store. Returns the profile or null. */
async function requireStore() {
  if (!isConfigured) {
    setView(errorView('Store tools are not available yet.'));
    return null;
  }
  if (!getUser()) {
    navigate('/signin?next=/store', { replace: true });
    return null;
  }
  const profile = await getProfile();
  if (!profile || (profile.role !== 'store_owner' && profile.role !== 'admin')) {
    setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <h2 class="font-semibold">Not a store account</h2>
        <p class="mt-2 text-sm text-neutral-600">
          This area is for sellers. If you should have access, ask the
          administrator to set up your store.
        </p>
        <a href="#/" class="btn-primary mt-5">Back to shop</a>
      </div>`);
    return null;
  }
  return profile;
}

export async function storePage(_p, query) {
  const profile = await requireStore();
  if (!profile) return;

  try {
    setCurrency((await loadCatalog()).currency);
  } catch { /* falls back to the currency code */ }

  const tab = QUEUES[query.tab] ? query.tab : 'confirmed';

  setView(`
    <div class="mx-auto max-w-3xl">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">${esc(profile.stores?.name ?? 'Your store')}</h1>
          <p class="mt-0.5 text-sm text-neutral-500">Order queue</p>
        </div>
        <div class="flex gap-2">
          <a href="#/store/profile" class="btn-secondary text-sm">Store profile</a>
          <a href="#/store/products" class="btn-secondary text-sm">Product drafts</a>
        </div>
      </div>

      <div class="mt-5 flex gap-2 overflow-x-auto pb-1" role="tablist">
        ${Object.entries(QUEUES).map(([key, q]) => `
          <a role="tab" href="#/store?tab=${key}"
             aria-selected="${key === tab}"
             class="shrink-0 rounded-full border px-3.5 py-1.5 text-sm transition
                    ${key === tab
                      ? 'border-brand-600 bg-brand-50 font-medium text-brand-700'
                      : 'border-neutral-300 bg-white text-neutral-700 hover:border-neutral-400'}">
            ${esc(q.label)} <span data-count="${key}" class="ml-1 text-xs opacity-60"></span>
          </a>`).join('')}
      </div>

      <div id="stats" class="mt-4" aria-live="polite">
        <div class="card h-[4.5rem] animate-pulse bg-neutral-50"></div>
      </div>

      <div id="queue" class="mt-4">
        <div class="card p-10 text-center text-sm text-neutral-500">Loading…</div>
      </div>
    </div>`);

  // Counts for every tab in one round trip, so the badges are accurate
  // without three separate queries. The analytics strip runs alongside:
  // one minimal query, RLS-scoped to this store, aggregated by the shared
  // metric definitions.
  const [{ data: all, error }, { data: statRows, error: statErr }] = await Promise.all([
    supabase
      .from('orders')
      .select('id, order_number, status, total_cents, created_at, items, receipt_path, fulfilled_at, handover_locked')
      .in('status', Object.keys(QUEUES))
      .order('created_at', { ascending: true }), // oldest first: FIFO fulfilment
    supabase
      .from('orders')
      .select('total_cents, status, fulfilled_at, created_at'),
  ]);

  if (error) {
    return setView(errorView('Could not load your orders.'));
  }

  renderStats(statRows, statErr);

  for (const key of Object.keys(QUEUES)) {
    const el = document.querySelector(`[data-count="${key}"]`);
    const n = all.filter((o) => o.status === key).length;
    if (el) el.textContent = n ? String(n) : '';
  }

  const rows = all.filter((o) => o.status === tab);
  const box = document.getElementById('queue');

  if (rows.length === 0) {
    box.innerHTML = `
      <div class="card p-12 text-center">
        <p class="font-medium text-neutral-700">Nothing here</p>
        <p class="mt-1 text-sm text-neutral-500">
          ${tab === 'confirmed'
            ? 'Orders appear once payment is confirmed.'
            : 'No orders are waiting at this stage.'}
        </p>
      </div>`;
    return;
  }

  box.innerHTML = rows.map((o) => orderCard(o, tab)).join('');
  wireActions(rows, tab);
}

/** Analytics strip above the queue. Fails soft: a stats error never blocks orders. */
function renderStats(rows, err) {
  const box = document.getElementById('stats');
  if (!box) return;
  if (err || !Array.isArray(rows)) {
    box.innerHTML = '';
    return;
  }

  const a = aggregateOrders(rows);
  const explainer = `
    <p class="mt-2 text-xs text-neutral-500">
      Revenue counts <strong>fulfilled</strong> orders only — paid but not yet
      handed over is not counted.
    </p>`;

  if (!a.hasFulfilled) {
    box.innerHTML = `
      <div class="card p-5">
        <p class="font-medium text-neutral-700">No completed orders yet</p>
        ${a.awaiting ? `
          <p class="mt-1 text-sm text-neutral-500">
            ${a.awaiting} order${a.awaiting === 1 ? '' : 's'} awaiting action — revenue
            appears once an order is handed over.
          </p>` : `
          <p class="mt-1 text-sm text-neutral-500">Revenue appears here once orders are fulfilled.</p>`}
      </div>
      ${explainer}`;
    return;
  }

  const cell = (label, value, big = false) => `
    <div class="card p-4">
      <p class="text-xs text-neutral-500">${esc(label)}</p>
      <p class="${big ? 'text-xl font-bold text-brand-600' : 'mt-0.5 text-lg font-semibold'}">${esc(value)}</p>
    </div>`;

  box.innerHTML = `
    <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
      ${cell('Revenue this month', formatCents(a.revenueMonth), true)}
      ${cell('Orders this month', String(a.ordersMonth))}
      ${cell('Revenue all time', formatCents(a.revenueAll))}
      ${cell('Orders all time', String(a.ordersAll))}
    </div>
    ${a.awaiting ? `
      <p class="mt-2 text-sm text-neutral-600">
        <span class="font-semibold">${a.awaiting}</span>
        order${a.awaiting === 1 ? '' : 's'} awaiting action
      </p>` : ''}
    ${explainer}`;
}

function orderCard(o, tab) {  const count = (o.items ?? []).reduce((n, i) => n + (i.qty ?? 0), 0);
  const age = Math.floor((Date.now() - new Date(o.created_at)) / 86400000);

  return `
    <div class="card mb-3 p-4" data-order="${esc(o.id)}">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-medium">${esc(o.order_number)}</p>
          <p class="mt-0.5 text-xs text-neutral-500">
            ${count} item${count === 1 ? '' : 's'} ·
            ${new Date(o.created_at).toLocaleDateString()}
            ${age >= 3 ? `<span class="ml-1 font-medium text-amber-600">${age} days old</span>` : ''}
          </p>
        </div>
        <p class="shrink-0 font-semibold">${formatCents(o.total_cents)}</p>
      </div>

      <ul class="mt-3 space-y-1 border-t border-neutral-100 pt-3 text-sm text-neutral-700">
        ${(o.items ?? []).map((i) => `
          <li class="flex justify-between gap-3">
            <span class="truncate">${esc(i.title ?? i.sku)}</span>
            <span class="shrink-0 text-neutral-500">× ${i.qty}</span>
          </li>`).join('')}
      </ul>

      ${tab === 'confirmed' ? `
        <div class="mt-4 flex flex-wrap gap-2">
          <button data-act="ready" class="btn-secondary flex-1 text-sm">Ready for pickup</button>
          <button data-act="shipped" class="btn-secondary flex-1 text-sm">Out for delivery</button>
        </div>` : `
        <div class="mt-4">
          ${o.handover_locked ? `
            <p class="rounded-lg bg-red-50 p-2.5 text-xs text-red-700">
              Too many wrong codes. Ask the administrator to complete this order.
            </p>` : `
            <label class="block text-sm font-medium text-neutral-700" for="code-${esc(o.id)}">
              Handover code from the customer
            </label>
            <div class="mt-1 flex gap-2">
              <input id="code-${esc(o.id)}" data-code maxlength="6" autocomplete="off"
                     placeholder="ABC123"
                     class="w-32 rounded-lg border border-neutral-300 px-3 py-2 text-center
                            font-mono text-sm uppercase tracking-widest focus:border-brand-500" />
              <button data-act="complete" class="btn-primary flex-1 text-sm">Complete order</button>
            </div>
            <p data-msg class="mt-2 hidden text-xs"></p>`}
        </div>`}
    </div>`;
}

function wireActions(rows, tab) {
  for (const card of document.querySelectorAll('[data-order]')) {
    const id = card.dataset.order;

    for (const btn of card.querySelectorAll('[data-act]')) {
      btn.addEventListener('click', async () => {
        const act = btn.dataset.act;
        const msg = card.querySelector('[data-msg]');
        const show = (text, ok) => {
          if (!msg) return;
          msg.textContent = text;
          msg.className = `mt-2 text-xs ${ok ? 'text-green-700' : 'text-red-600'}`;
        };

        if (act === 'ready' || act === 'shipped') {
          btn.disabled = true;
          btn.textContent = 'Saving…';
          const status = act === 'ready' ? 'ready_for_pickup' : 'shipped';
          const { error } = await supabase.from('orders').update({ status }).eq('id', id);
          if (error) {
            btn.disabled = false;
            btn.textContent = act === 'ready' ? 'Ready for pickup' : 'Out for delivery';
            toast('Could not update that order.');
            return;
          }
          toast(act === 'ready' ? 'Marked ready for pickup' : 'Marked out for delivery');
          storePage({}, { tab });
          return;
        }

        if (act === 'complete') {
          const input = card.querySelector('[data-code]');
          const code = (input?.value ?? '').trim().toUpperCase();
          if (code.length !== 6) return show('Enter the 6-character code.', false);

          btn.disabled = true;
          btn.textContent = 'Checking…';
          const { data, error } = await supabase.rpc('complete_with_code', {
            p_order_id: id, p_code: code,
          });
          btn.disabled = false;
          btn.textContent = 'Complete order';

          if (error) return show('Something went wrong. Try again.', false);

          if (!data?.ok) {
            if (data?.reason === 'wrong_code') {
              return show(
                data.locked
                  ? 'Locked after too many attempts. Ask the administrator.'
                  : `That code is not right. ${data.attempts_left} attempt${data.attempts_left === 1 ? '' : 's'} left.`,
                false,
              );
            }
            if (data?.reason === 'locked') return show('Locked. Ask the administrator.', false);
            return show('Could not complete this order.', false);
          }

          toast(`${rows.find((r) => r.id === id)?.order_number ?? 'Order'} completed`);
          storePage({}, { tab });
        }
      });
    }

    // Enter submits the code, as at a counter.
    card.querySelector('[data-code]')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') card.querySelector('[data-act="complete"]')?.click();
    });
  }
}

// ---------------------------------------------------------------- profile
/**
 * Store profile: banner, logo, blurb (release plan §2).
 *
 * Owners upload two images and a short blurb; RLS + the
 * guard_store_owner_update trigger confine them to their own store's
 * banner_path/logo_path/blurb columns. The values reach the storefront at
 * the next build, which merges them from Supabase into the baked catalog.
 *
 * Images are downscaled in the browser before upload (the same canvas
 * approach as receipts) and overwrite a stable path per store, so replacing
 * an image never accumulates storage.
 */
const ASSET_LIMITS = {
  banner: { label: 'Banner', maxBytes: 2 * 1024 * 1024, maxDim: 1600 },
  logo:   { label: 'Logo',   maxBytes: 1 * 1024 * 1024, maxDim: 512 },
};
const ACCEPTED = ['image/jpeg', 'image/png', 'image/webp'];
const BLURB_MAX = 200;

/** Canvas downscale to WebP, mirroring downscaleImage in lib/ocr.js. */
async function shrinkToWebp(file, maxDim) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file; // give the server-side validation a chance to complain

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/webp', 0.85));
  if (!blob || blob.size >= file.size) return file; // never make it bigger
  return new File([blob], file.name.replace(/\.\w+$/, '') + '.webp', { type: 'image/webp' });
}

export async function storeProfilePage() {
  const profile = await requireStore();
  if (!profile) return;
  if (!profile.store_id) {
    return setView(errorView('This account has no store attached.'));
  }

  const storeId = profile.store_id;
  const { data: store, error } = await supabase
    .from('stores')
    .select('id, slug, name, banner_path, logo_path, blurb')
    .eq('id', storeId)
    .maybeSingle();

  if (error || !store) {
    return setView(errorView('Could not load your store.'));
  }

  const publicUrl = (path) => path
    ? `${supabase.supabaseUrl}/storage/v1/object/public/store-assets/${encodeURI(path)}`
    : null;

  const bannerUrl = publicUrl(store.banner_path);
  const logoUrl = publicUrl(store.logo_path);

  setView(`
    <div class="mx-auto max-w-3xl">
      <a href="#/store" class="text-sm text-neutral-500 hover:text-brand-600">&larr; Order queue</a>
      <h1 class="mt-3 text-xl font-semibold">Store profile</h1>
      <p class="mt-1 text-sm text-neutral-500">
        Shown on your public store page at the next site update.
        ${esc(store.name)}
      </p>

      <div class="card mt-4 p-5">
        <h2 class="font-semibold">Banner</h2>
        <p class="mt-1 text-xs text-neutral-500">
          Wide image across the top of your store page. JPEG, PNG or WebP, up to 2&nbsp;MB
          (larger images are resized to 1600&nbsp;px wide).
        </p>
        ${bannerUrl ? `
          <img src="${esc(bannerUrl)}" alt="Current banner"
               class="mt-3 aspect-video w-full rounded-lg object-cover sm:aspect-[21/9]" />` : `
          <div class="mt-3 flex aspect-video w-full items-center justify-center rounded-lg bg-neutral-100
                      text-sm text-neutral-400 sm:aspect-[21/9]">No banner yet</div>`}
        <input id="pick-banner" type="file" accept="${ACCEPTED.join(',')}" class="mt-3 block w-full text-sm
               file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2
               file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100" />
      </div>

      <div class="card mt-4 p-5">
        <h2 class="font-semibold">Logo</h2>
        <p class="mt-1 text-xs text-neutral-500">
          Shown beside your store name. JPEG, PNG or WebP, up to 1&nbsp;MB
          (larger images are resized to 512&nbsp;px).
        </p>
        ${logoUrl ? `
          <img src="${esc(logoUrl)}" alt="Current logo"
               class="mt-3 h-20 w-20 rounded-2xl border border-neutral-200 object-cover" />` : `
          <div class="mt-3 flex h-20 w-20 items-center justify-center rounded-2xl bg-neutral-100
                      text-sm text-neutral-400">No logo</div>`}
        <input id="pick-logo" type="file" accept="${ACCEPTED.join(',')}" class="mt-3 block w-full text-sm
               file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2
               file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100" />
      </div>

      <div class="card mt-4 p-5">
        <label for="blurb" class="font-semibold">Blurb</label>
        <p class="mt-1 text-xs text-neutral-500">One or two sentences about your store.</p>
        <textarea id="blurb" rows="3" maxlength="${BLURB_MAX}"
                  class="mt-3 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"
                  >${esc(store.blurb ?? '')}</textarea>
        <p id="blurb-count" class="mt-1 text-right text-xs text-neutral-400">0 / ${BLURB_MAX}</p>
      </div>

      <p id="save-msg" class="mt-4 hidden rounded-lg p-3 text-sm"></p>
      <button id="save" class="btn-primary mt-4 w-full">Save profile</button>
    </div>`);

  const picks = { banner: null, logo: null };
  for (const kind of ['banner', 'logo']) {
    document.getElementById(`pick-${kind}`).addEventListener('change', async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const limits = ASSET_LIMITS[kind];
      if (!ACCEPTED.includes(file.type)) {
        e.target.value = '';
        return inline(`${limits.label}: use a JPEG, PNG or WebP image.`, false);
      }
      if (file.size > limits.maxBytes) {
        e.target.value = '';
        return inline(`${limits.label} is over the ${limits.maxBytes / 1024 / 1024} MB limit.`, false);
      }
      picks[kind] = await shrinkToWebp(file, limits.maxDim);
      inline(`${limits.label} ready — remember to save.`, true);
    });
  }

  const blurbEl = document.getElementById('blurb');
  const counter = document.getElementById('blurb-count');
  const syncCount = () => (counter.textContent = `${blurbEl.value.length} / ${BLURB_MAX}`);
  blurbEl.addEventListener('input', syncCount);
  syncCount();

  const msg = document.getElementById('save-msg');
  function inline(text, ok) {
    msg.textContent = text;
    msg.className = `mt-4 rounded-lg p-3 text-sm ${ok
      ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-700'}`;
  }

  document.getElementById('save').addEventListener('click', async () => {
    const btn = document.getElementById('save');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      // Overwrite the stable path so replacement is idempotent — the old
      // object is replaced, never accumulated.
      const patch = {};
      for (const kind of ['banner', 'logo']) {
        if (!picks[kind]) continue;
        // shrinkToWebp returns the ORIGINAL file when the browser cannot
        // decode it, or when webp came out larger — so the bytes are not
        // always webp. Take the extension from the blob's real type, or the
        // path would claim .webp over png/jpeg bytes.
        const ext = { 'image/webp': 'webp', 'image/png': 'png',
                      'image/jpeg': 'jpg' }[picks[kind].type] ?? 'webp';
        const path = `${storeId}/${kind}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('store-assets')
          .upload(path, picks[kind], { upsert: true, contentType: picks[kind].type });
        if (upErr) throw new Error(`${ASSET_LIMITS[kind].label} upload failed: ${upErr.message}`);

        // Upsert only overwrites the SAME path. Switching format (png -> webp)
        // would otherwise strand the old object against the store's quota, so
        // drop any sibling with a different extension. Best-effort: a failure
        // here must not lose the upload that just succeeded.
        const stale = ['webp', 'png', 'jpg']
          .filter((x) => x !== ext)
          .map((x) => `${storeId}/${kind}.${x}`);
        await supabase.storage.from('store-assets').remove(stale).catch(() => {});

        patch[`${kind}_path`] = path;
      }
      patch.blurb = blurbEl.value.trim() || null;

      const { error: dbErr } = await supabase.from('stores').update(patch).eq('id', storeId);
      if (dbErr) throw new Error(`Could not save: ${dbErr.message}`);

      inline('Saved. Your store page updates at the next site update.', true);
      picks.banner = picks.logo = null;
    } catch (e) {
      inline(e.message, false);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Save profile';
    }
  });
}

// ---------------------------------------------------------------- drafts
export async function storeProductsPage() {
  const profile = await requireStore();
  if (!profile) return;

  setView(`
    <div class="mx-auto max-w-3xl">
      <a href="#/store" class="text-sm text-neutral-500 hover:text-brand-600">&larr; Order queue</a>
      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <h1 class="text-xl font-semibold">Product drafts</h1>
        <button id="new" class="btn-primary text-sm">Submit a product</button>
      </div>
      <p class="mt-1 text-sm text-neutral-500">
        Drafts are reviewed by the administrator. Approved products appear on
        the shop at the next site update.
      </p>

      <h2 class="mt-6 font-semibold">Your products</h2>
      <p class="mt-1 text-sm text-neutral-500">
        Request a change to price, stock, description, or visibility. Requests
        are reviewed before they go live.
      </p>
      <div id="mine" class="mt-3">
        <div class="card p-6 text-sm text-neutral-500">Loading…</div>
      </div>

      <div id="edit-form" class="card mt-4 hidden p-5">
        <h2 class="font-semibold">Request a change</h2>
        <p id="ef-title" class="mt-1 text-sm text-neutral-500"></p>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Price (MVR)</span>
            <input id="ef-price" type="number" min="0" step="0.01"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Quantity available</span>
            <input id="ef-stock" type="number" min="0" step="1"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block sm:col-span-2">
            <span class="text-sm font-medium text-neutral-700">Description</span>
            <textarea id="ef-desc" rows="3"
                      class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"></textarea>
          </label>
          <label class="flex items-center gap-2 text-sm text-neutral-700 sm:col-span-2">
            <input id="ef-hidden" type="checkbox" class="rounded border-neutral-300" />
            Hide this product (removes it from the shop)
          </label>
        </div>
        <p id="ef-err" class="mt-3 hidden rounded-lg bg-red-50 p-2.5 text-sm text-red-700"></p>
        <div class="mt-4 flex gap-2">
          <button id="ef-save" class="btn-primary flex-1 text-sm">Submit request</button>
          <button id="ef-cancel" class="btn-secondary text-sm">Cancel</button>
        </div>
      </div>

      <div id="form" class="card mt-4 hidden p-5">
        <h2 class="font-semibold">New product</h2>
        <div class="mt-4 grid gap-3 sm:grid-cols-2">
          <label class="block sm:col-span-2">
            <span class="text-sm font-medium text-neutral-700">Title</span>
            <input id="f-title" class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Price (MVR)</span>
            <input id="f-price" type="number" min="0" step="0.01"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Quantity available</span>
            <input id="f-stock" type="number" min="0" step="1"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block sm:col-span-2">
            <span class="text-sm font-medium text-neutral-700">Description</span>
            <textarea id="f-desc" rows="3"
                      class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"></textarea>
          </label>
        </div>
        <p id="f-err" class="mt-3 hidden rounded-lg bg-red-50 p-2.5 text-sm text-red-700"></p>
        <div class="mt-4 flex gap-2">
          <button id="save" class="btn-primary flex-1 text-sm">Submit for review</button>
          <button id="cancel" class="btn-secondary text-sm">Cancel</button>
        </div>
        <p class="mt-3 text-xs text-neutral-500">
          Images are added by the administrator during review.
        </p>
      </div>

      <div id="list" class="mt-4">
        <div class="card p-10 text-center text-sm text-neutral-500">Loading…</div>
      </div>
    </div>`);

  const form = document.getElementById('form');
  document.getElementById('new').addEventListener('click', () => form.classList.toggle('hidden'));
  document.getElementById('cancel').addEventListener('click', () => form.classList.add('hidden'));

  document.getElementById('save').addEventListener('click', async () => {
    const err = document.getElementById('f-err');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    err.classList.add('hidden');

    const title = document.getElementById('f-title').value.trim();
    const price = parseFloat(document.getElementById('f-price').value);
    const stock = parseInt(document.getElementById('f-stock').value, 10);
    const description = document.getElementById('f-desc').value.trim();

    if (!title) return fail('Give the product a title.');
    if (!Number.isFinite(price) || price < 0) return fail('Enter a valid price.');
    if (!Number.isInteger(stock) || stock < 0) return fail('Enter a whole number for quantity.');

    const btn = document.getElementById('save');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const { error } = await supabase.from('product_drafts').insert({
      store_id: profile.store_id,
      submitted_by: getUser().id,
      // Money as integer cents, matching the catalog.
      payload: { title, priceCents: Math.round(price * 100), stockTotal: stock, description },
    });

    btn.disabled = false;
    btn.textContent = 'Submit for review';
    if (error) return fail('Could not submit that draft.');

    toast('Draft submitted for review');
    storeProductsPage();
  });

  // ---------------------------------------------------------- own products
  // The portal already loads the catalog; filter to this store. Owners see
  // exactly what shoppers see — which is also the limit: hidden products are
  // absent from the baked catalog, so un-hiding goes through the admin.
  let own = [];
  try {
    const cat = await loadCatalog();
    own = (cat.products ?? []).filter((p) => p.storeSlug === profile.stores?.slug);
  } catch {
    document.getElementById('mine').innerHTML =
      `<div class="card p-6 text-sm text-red-600">Could not load the catalog.</div>`;
  }

  const mine = document.getElementById('mine');
  if (own.length) {
    mine.innerHTML = own.map((p, i) => `
      <div class="card mb-2 flex flex-wrap items-center justify-between gap-2 p-3">
        <div class="min-w-0">
          <p class="truncate text-sm font-medium">${esc(p.title)}</p>
          <p class="text-xs text-neutral-500">
            ${esc(p.sku)} · ${formatCents(p.priceCents)} · ${p.stockTotal} in stock
          </p>
        </div>
        ${p.variants?.length
          ? `<span class="text-xs text-neutral-400">Variant product — ask the administrator to change these</span>`
          : `<button data-edit="${i}" class="btn-secondary shrink-0 text-sm">Request change</button>`}
      </div>`).join('');
  } else if (!mine.querySelector('.text-red-600')) {
    mine.innerHTML = `<div class="card p-6 text-sm text-neutral-500">No live products yet.</div>`;
  }

  const editForm = document.getElementById('edit-form');
  let editing = null;

  document.querySelectorAll('[data-edit]').forEach((btn) => {
    btn.addEventListener('click', () => {
      editing = own[Number(btn.dataset.edit)];
      document.getElementById('ef-title').textContent = `${editing.title} (${editing.sku})`;
      document.getElementById('ef-price').value = (editing.priceCents / 100).toFixed(2);
      document.getElementById('ef-stock').value = editing.stockTotal;
      document.getElementById('ef-desc').value = editing.description ?? '';
      document.getElementById('ef-hidden').checked = false;
      document.getElementById('ef-err').classList.add('hidden');
      editForm.classList.remove('hidden');
      editForm.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    });
  });

  document.getElementById('ef-cancel').addEventListener('click', () => {
    editing = null;
    editForm.classList.add('hidden');
  });

  document.getElementById('ef-save').addEventListener('click', async () => {
    if (!editing) return;
    const errEl = document.getElementById('ef-err');
    const fail = (m) => { errEl.textContent = m; errEl.classList.remove('hidden'); };
    errEl.classList.add('hidden');

    const price = parseFloat(document.getElementById('ef-price').value);
    const stock = parseInt(document.getElementById('ef-stock').value, 10);
    const description = document.getElementById('ef-desc').value.trim();
    const hidden = document.getElementById('ef-hidden').checked;

    if (!Number.isFinite(price) || price < 0) return fail('Enter a valid price.');
    if (!Number.isInteger(stock) || stock < 0) return fail('Enter a whole number for quantity.');

    // The payload is a diff — only fields that actually change, plus the
    // discriminator. The admin approval flow honours nothing outside the
    // editable set {priceCents, stockTotal, description, hidden}.
    const payload = { kind: 'edit' };
    const priceCents = Math.round(price * 100);
    if (priceCents !== editing.priceCents) payload.priceCents = priceCents;
    if (stock !== editing.stockTotal) payload.stockTotal = stock;
    if (description !== (editing.description ?? '')) payload.description = description;
    if (hidden) payload.hidden = true;

    if (Object.keys(payload).length === 1) return fail('Nothing changed — adjust a field first.');

    const btn = document.getElementById('ef-save');
    btn.disabled = true;
    btn.textContent = 'Submitting…';
    const { error } = await supabase.from('product_drafts').insert({
      store_id: profile.store_id,
      submitted_by: getUser().id,
      target_sku: editing.sku,
      payload,
    });
    btn.disabled = false;
    btn.textContent = 'Submit request';
    if (error) return fail('Could not submit that request.');

    toast('Change request submitted for review');
    editing = null;
    editForm.classList.add('hidden');
    storeProductsPage();
  });

  const { data: drafts, error } = await supabase
    .from('product_drafts')
    .select('id, payload, status, review_note, created_at')
    .order('created_at', { ascending: false });

  const list = document.getElementById('list');
  if (error) {
    list.innerHTML = `<div class="card p-6 text-sm text-red-600">Could not load your drafts.</div>`;
    return;
  }
  if (!drafts.length) {
    list.innerHTML = `
      <div class="card p-12 text-center">
        <p class="font-medium text-neutral-700">No drafts yet</p>
        <p class="mt-1 text-sm text-neutral-500">Submit a product to get started.</p>
      </div>`;
    return;
  }

  const badge = {
    pending:  'bg-amber-50 text-amber-800 border-amber-200',
    approved: 'bg-green-50 text-green-800 border-green-200',
    rejected: 'bg-red-50 text-red-700 border-red-200',
  };

  list.innerHTML = drafts.map((d) => `
    <div class="card mb-3 p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0">
          <p class="font-medium">${esc(d.payload?.title ?? 'Untitled')}</p>
          <p class="mt-0.5 text-xs text-neutral-500">
            ${formatCents(d.payload?.priceCents ?? 0)} ·
            ${d.payload?.stockTotal ?? 0} in stock ·
            ${new Date(d.created_at).toLocaleDateString()}
          </p>
        </div>
        <span class="shrink-0 rounded-full border px-2.5 py-0.5 text-xs font-medium ${badge[d.status] ?? ''}">
          ${esc(d.status)}
        </span>
      </div>
      ${d.review_note ? `
        <p class="mt-3 rounded-lg bg-neutral-50 p-2.5 text-xs text-neutral-700">
          ${esc(d.review_note)}
        </p>` : ''}
      ${d.status === 'approved' ? `
        <p class="mt-2 text-xs text-neutral-500">
          Live on the shop at the next site update.
        </p>` : ''}
    </div>`).join('');
}
