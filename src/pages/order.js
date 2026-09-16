import { setCurrency, formatCents } from '../lib/money.js';
import { setView, errorView, esc, toast } from '../components/layout.js';
import { getUser } from '../lib/auth.js';
import { supabase, isConfigured } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';
import { readReceipt, downscaleImage, cropTopBanner } from '../lib/ocr.js';
import { bankDetails } from './checkout.js';
import { loadCatalog } from '../lib/catalog.js';

const STATUS = {
  awaiting_payment:  { label: 'Awaiting your payment', tone: 'amber' },
  payment_submitted: { label: 'Checking your payment', tone: 'sky' },
  confirmed:         { label: 'Preparing your order',  tone: 'sky' },
  ready_for_pickup:  { label: 'Ready for pickup',      tone: 'green' },
  shipped:           { label: 'Out for delivery',      tone: 'green' },
  completed:         { label: 'Completed',             tone: 'green' },
  declined:          { label: 'Payment not found',     tone: 'red' },
  fulfilled:         { label: 'Shipped',               tone: 'green' }, // legacy
  cancelled:         { label: 'Cancelled',             tone: 'neutral' },
};

/** Statuses where the customer must show their handover code. */
const NEEDS_CODE = new Set(['ready_for_pickup', 'shipped']);

const TONE = {
  amber:   'bg-amber-50 text-amber-800 border-amber-200',
  sky:     'bg-sky-50 text-sky-800 border-sky-200',
  green:   'bg-green-50 text-green-800 border-green-200',
  red:     'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-neutral-100 text-neutral-700 border-neutral-200',
};

export async function orderPage({ id }) {
  if (!isConfigured) return setView(errorView('Orders are not available yet.'));
  if (!getUser()) return navigate(`/signin?next=/order/${id}`, { replace: true });

  const { data: order, error } = await supabase
    .from('orders')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) return setView(errorView('Could not load that order.'));
  if (!order) {
    return setView(`
      <div class="card mx-auto max-w-md p-10 text-center">
        <h2 class="font-semibold">Order not found</h2>
        <p class="mt-2 text-sm text-neutral-600">
          It may belong to another account.
        </p>
        <a href="#/orders" class="btn-primary mt-5">Your orders</a>
      </div>`);
  }

  try {
    setCurrency((await loadCatalog()).currency);
  } catch { /* formatting falls back to the code */ }

  const st = STATUS[order.status] ?? STATUS.awaiting_payment;
  const bank = bankDetails();
  const needsReceipt = order.status === 'awaiting_payment';
  const canReplace = order.status === 'payment_submitted';

  setView(`
    <div class="mx-auto max-w-2xl">
      <a href="#/orders" class="text-sm text-neutral-500 hover:text-brand-600">&larr; Your orders</a>

      <div class="mt-3 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 class="text-xl font-semibold">Order ${esc(order.order_number)}</h1>
          <p class="mt-0.5 text-sm text-neutral-500">
            Placed ${new Date(order.created_at).toLocaleDateString()}
          </p>
        </div>
        <span class="rounded-full border px-3 py-1 text-sm font-medium ${TONE[st.tone]}">
          ${esc(st.label)}
        </span>
      </div>

      ${order.status === 'declined' && order.decline_reason ? `
        <p class="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
          ${esc(order.decline_reason)}
        </p>` : ''}

      <div class="card mt-4 divide-y divide-neutral-100">
        ${(order.items ?? []).map((i) => `
          <div class="flex items-center justify-between gap-4 p-4">
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">${esc(i.title ?? i.sku)}</p>
              <p class="text-xs text-neutral-500">${i.qty} × ${formatCents(i.unit_price ?? 0)}</p>
            </div>
            <p class="shrink-0 text-sm font-semibold">${formatCents((i.unit_price ?? 0) * i.qty)}</p>
          </div>`).join('')}
        <div class="flex items-center justify-between p-4">
          <span class="font-semibold">Total</span>
          <span class="text-lg font-bold text-brand-600">${formatCents(order.total_cents)}</span>
        </div>
      </div>

      ${needsReceipt || canReplace ? `
        <div class="card mt-4 p-5">
          <h2 class="font-semibold">1. Transfer ${formatCents(order.total_cents)}</h2>
          <dl class="mt-3 space-y-1.5 text-sm">
            <div class="flex justify-between gap-4">
              <dt class="text-neutral-500">Bank</dt><dd class="font-medium">${esc(bank.bank)}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-neutral-500">Account name</dt><dd class="font-medium">${esc(bank.accountName)}</dd>
            </div>
            <div class="flex justify-between gap-4">
              <dt class="text-neutral-500">Account number</dt>
              <dd class="font-mono font-medium">${esc(bank.accountNumber)}</dd>
            </div>
          </dl>
          <p class="mt-3 rounded-lg bg-neutral-50 p-2.5 text-xs text-neutral-600">
            Transfer the exact amount. Using
            <strong>${esc(order.order_number)}</strong> as the transfer
            reference helps us match your payment faster.
          </p>
        </div>

        <div class="card mt-4 p-5">
          <h2 class="font-semibold">2. Upload your receipt</h2>
          <p class="mt-1 text-sm text-neutral-600">
            A photo or screenshot of the transfer confirmation.
          </p>

          ${order.receipt_path ? `
            <p class="mt-3 rounded-lg bg-green-50 p-2.5 text-sm text-green-800">
              Receipt uploaded. You can replace it while we check your payment.
            </p>` : ''}

          <input id="file" type="file" accept="image/*,application/pdf" class="mt-4 block w-full text-sm
                 file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-4 file:py-2
                 file:text-sm file:font-medium file:text-brand-700 hover:file:bg-brand-100" />

          <div id="preview" class="mt-4 hidden rounded-lg border border-neutral-200 p-3">
            <img id="thumb" alt="Receipt preview"
                 class="mx-auto max-h-56 object-contain" />
            <p id="pdf-name" class="hidden text-sm text-neutral-600"></p>
            <button id="replace" type="button" class="btn-secondary mt-3 w-full text-sm">
              Choose a different image
            </button>
          </div>

          <div id="otp-warn" class="mt-4 hidden rounded-lg border border-amber-300 bg-amber-50 p-3">
            <p class="text-sm font-semibold text-amber-900">
              Your screenshot shows a one-time password
            </p>
            <p class="mt-1 text-xs leading-relaxed text-amber-900">
              The notification at the top contains a banking OTP. Please remove
              it before uploading — we only need the transfer details.
            </p>
            <button id="crop" type="button" class="btn-secondary mt-3 w-full text-sm">
              Remove the top notification
            </button>
          </div>

          <div id="ocr" class="mt-4 hidden">
            <div class="flex items-center gap-2 text-sm text-neutral-600">
              <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-neutral-300 border-t-brand-600"></span>
              <span id="ocr-status">Reading your receipt…</span>
            </div>
          </div>

          <div class="mt-4">
            <label for="ref" class="block text-sm font-medium text-neutral-700">
              Payment reference
            </label>
            <input id="ref" type="text" value="${esc(order.payment_reference ?? '')}"
                   placeholder="e.g. FT26230F30WR"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 font-mono text-sm
                          focus:border-brand-500" />
            <p id="ref-hint" class="mt-1.5 text-xs text-neutral-500">
              We try to read this from your receipt — please check it is right.
            </p>
            <div id="alts" class="mt-2 hidden flex-wrap gap-1.5"></div>
          </div>

          <p id="err" class="mt-4 hidden rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>

          <div id="progress" class="mt-4 hidden" role="status">
            <div class="h-2 overflow-hidden rounded-full bg-neutral-100">
              <div id="progress-bar" class="h-2 rounded-full bg-brand-500 transition-all" style="width:0%"></div>
            </div>
            <p id="progress-label" class="mt-1.5 text-center text-xs text-neutral-500"></p>
          </div>

          <button id="submit" class="btn-primary mt-5 w-full" disabled>
            ${order.receipt_path ? 'Replace receipt' : 'Submit receipt'}
          </button>
        </div>` : ''}

      ${order.status === 'confirmed' ? `
        <p class="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          We matched your payment. Your order is being prepared.
        </p>` : ''}

      ${NEEDS_CODE.has(order.status) ? `
        <div class="card mt-4 border-brand-300 bg-brand-50 p-5">
          <h2 class="font-semibold text-brand-900">
            ${order.status === 'ready_for_pickup' ? 'Ready to collect' : 'Out for delivery'}
          </h2>
          <p class="mt-1 text-sm text-brand-900">
            ${order.status === 'ready_for_pickup'
              ? 'Show this code when you collect your order.'
              : 'Give this code to the delivery driver.'}
          </p>
          <div id="code-box" class="mt-4 rounded-lg border border-brand-300 bg-white p-4 text-center">
            <p id="code" class="font-mono text-3xl font-bold tracking-[0.3em] text-brand-700">••••••</p>
          </div>
          <button id="get-code" class="btn-secondary mt-3 w-full">Show my code</button>
          <p class="mt-2 text-xs text-brand-900/70">
            Only share it at the moment of handover — it confirms you received the order.
          </p>
        </div>` : ''}

      ${order.status === 'completed' ? `
        <p class="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          Order completed${order.completed_at
            ? ` on ${new Date(order.completed_at).toLocaleDateString()}` : ''}. Thank you!
        </p>` : ''}
      ${order.status === 'fulfilled' ? `
        <p class="mt-4 rounded-lg border border-green-200 bg-green-50 p-4 text-sm text-green-800">
          This order has shipped.
        </p>` : ''}
    </div>`);

  // Handover code. The server returns it only at issue time, so it is cached
  // locally for this order; "Show my code" re-issues if the cache is gone
  // (new device, cleared storage), which invalidates any older code.
  if (NEEDS_CODE.has(order.status)) {
    const cacheKey = `ex.handover.${order.id}`;
    const codeEl = document.getElementById('code');
    const btn = document.getElementById('get-code');

    const reveal = (code) => {
      codeEl.textContent = code;
      btn.textContent = 'Regenerate code';
    };

    let cached = null;
    try { cached = localStorage.getItem(cacheKey); } catch { /* private mode */ }
    if (cached) reveal(cached);

    btn.addEventListener('click', async () => {
      if (cached && !confirm('Generate a new code? Your current code will stop working.')) return;
      btn.disabled = true;
      btn.textContent = 'Generating…';
      const { data, error } = await supabase.rpc('issue_handover_code', { p_order_id: order.id });
      btn.disabled = false;
      if (error || !data?.ok) {
        btn.textContent = 'Show my code';
        toast('Could not generate a code. Try again.');
        return;
      }
      cached = data.code;
      try { localStorage.setItem(cacheKey, data.code); } catch { /* ignore */ }
      reveal(data.code);
    });
  }

  if (!needsReceipt && !canReplace) return;

  const fileInput = document.getElementById('file');
  const submit = document.getElementById('submit');
  const refInput = document.getElementById('ref');
  const err = document.getElementById('err');
  const progress = document.getElementById('progress');
  const progressBar = document.getElementById('progress-bar');
  const progressLabel = document.getElementById('progress-label');
  const thumbEl = document.getElementById('thumb');
  const pdfNameEl = document.getElementById('pdf-name');
  let chosen = null;
  let lastUrl = null;

  const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };

  // Preview first, commit later: the replace button just reopens the picker,
  // so nothing uploads until "Submit receipt" is pressed.
  document.getElementById('replace')?.addEventListener('click', () => fileInput.click());

  refInput.addEventListener('input', () => {
    submit.disabled = !(chosen || order.receipt_path) || !refInput.value.trim();
  });

  fileInput.addEventListener('change', async () => {
    err.classList.add('hidden');
    const file = fileInput.files?.[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
      return fail('That file is larger than 10 MB. Try a photo instead of a scan.');
    }

    chosen = await downscaleImage(file);

    const isImage = chosen.type.startsWith('image/');
    thumbEl.classList.toggle('hidden', !isImage);
    pdfNameEl.classList.toggle('hidden', isImage);
    if (isImage) {
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(chosen);
      thumbEl.src = lastUrl;
    } else {
      pdfNameEl.textContent = `Selected: ${chosen.name || 'receipt.pdf'}`;
    }
    document.getElementById('preview').classList.remove('hidden');

    if (isImage) {

      // OCR is advisory: a failure must never block submission.
      const ocrBox = document.getElementById('ocr');
      const ocrStatus = document.getElementById('ocr-status');
      ocrBox.classList.remove('hidden');
      try {
        const { best, candidates, hasOtp } = await readReceipt(chosen, (p) => {
          ocrStatus.textContent = `Reading your receipt… ${Math.round(p * 100)}%`;
        });
        ocrBox.classList.add('hidden');

        // BML receipts are screenshots and often still show the OTP SMS in
        // the notification shade. Never upload a live credential silently.
        document.getElementById('otp-warn').classList.toggle('hidden', !hasOtp);

        if (best && !refInput.value.trim()) {
          refInput.value = best;
          document.getElementById('ref-hint').textContent =
            'We read this from your receipt — please check it is right.';
        }
        const alts = candidates.slice(1, 4);
        if (alts.length) {
          const box = document.getElementById('alts');
          box.className = 'mt-2 flex flex-wrap gap-1.5';
          box.innerHTML = alts.map((c) => `
            <button type="button" data-ref="${esc(c.value)}"
                    class="rounded-full border border-neutral-300 px-2.5 py-1 font-mono text-xs
                           hover:border-brand-500 hover:text-brand-700">${esc(c.value)}</button>`).join('');
          for (const b of box.querySelectorAll('[data-ref]')) {
            b.addEventListener('click', () => {
              refInput.value = b.dataset.ref;
              refInput.dispatchEvent(new Event('input'));
            });
          }
        }
      } catch {
        ocrBox.classList.add('hidden');
        document.getElementById('ref-hint').textContent =
          'Could not read the receipt automatically — please type the reference.';
      }
    }

    submit.disabled = !refInput.value.trim();
  });

  document.getElementById('crop')?.addEventListener('click', async () => {
    if (!chosen) return;
    const btn = document.getElementById('crop');
    btn.disabled = true;
    btn.textContent = 'Removing…';

    chosen = await cropTopBanner(chosen);
    if (lastUrl) URL.revokeObjectURL(lastUrl);
    lastUrl = URL.createObjectURL(chosen);
    thumbEl.src = lastUrl;

    // Re-check: confirm the OTP is actually gone rather than assuming.
    try {
      const { hasOtp, best } = await readReceipt(chosen);
      document.getElementById('otp-warn').classList.toggle('hidden', !hasOtp);
      if (!hasOtp) toast('Notification removed');
      if (best && !refInput.value.trim()) {
        refInput.value = best;
        refInput.dispatchEvent(new Event('input'));
      }
    } catch {
      document.getElementById('otp-warn').classList.add('hidden');
    }

    btn.disabled = false;
    btn.textContent = 'Remove the top notification';
  });

  submit.addEventListener('click', async () => {
    err.classList.add('hidden');
    submit.disabled = true;
    submit.textContent = chosen ? 'Uploading…' : 'Submitting…';
    fileInput.disabled = true;
    document.getElementById('replace')?.setAttribute('disabled', '');

    const showProgress = () => {
      progress.classList.remove('hidden');
      progressBar.style.width = '0%';
      progressLabel.textContent = chosen ? 'Uploading receipt… 0%' : 'Saving your order…';
    };
    const hideProgress = () => {
      progress.classList.add('hidden');
      fileInput.disabled = false;
      document.getElementById('replace')?.removeAttribute('disabled');
    };

    try {
      let path = order.receipt_path;

      if (chosen) {
        showProgress();
        const ext = chosen.type === 'application/pdf' ? 'pdf'
                  : (chosen.name.split('.').pop() || 'jpg').toLowerCase();
        // Path must start with the user id — the storage policy keys off it.
        path = `${getUser().id}/${order.id}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('receipts')
          .upload(path, chosen, {
            upsert: true,
            contentType: chosen.type,
            onUploadProgress: ({ loaded, total }) => {
              const pct = total ? Math.min(100, Math.round((loaded / total) * 100)) : 0;
              progressBar.style.width = `${pct}%`;
              progressLabel.textContent = `Uploading receipt… ${pct}%`;
            },
          });
        if (upErr) throw upErr;
        progressBar.style.width = '100%';
        progressLabel.textContent = 'Saving your order…';
      }

      const { error: updErr } = await supabase
        .from('orders')
        .update({
          receipt_path: path,
          payment_reference: refInput.value.trim(),
          receipt_uploaded_at: new Date().toISOString(),
          status: 'payment_submitted',
        })
        .eq('id', order.id);
      if (updErr) throw updErr;

      toast('Receipt submitted');
      orderPage({ id: order.id });
    } catch (e) {
      hideProgress();
      fail(e?.message?.includes('exceeded')
        ? 'That file is too large. Try a smaller photo.'
        : 'Upload failed. Check your connection and try again.');
      submit.disabled = false;
      submit.textContent = order.receipt_path ? 'Replace receipt' : 'Submit receipt';
    }
  });
}

export async function ordersPage() {
  if (!isConfigured) return setView(errorView('Orders are not available yet.'));
  if (!getUser()) return navigate('/signin?next=/orders', { replace: true });

  const { data: orders, error } = await supabase
    .from('orders')
    .select('id, order_number, status, total_cents, created_at, items')
    .eq('user_id', getUser().id)  // 'Your orders' means purchases, not store orders
    .order('created_at', { ascending: false });

  if (error) return setView(errorView('Could not load your orders.'));

  try {
    setCurrency((await loadCatalog()).currency);
  } catch { /* ignore */ }

  if (!orders.length) {
    return setView(`
      <div class="card mx-auto max-w-md p-12 text-center">
        <p class="font-medium text-neutral-700">No orders yet</p>
        <a href="#/" class="btn-primary mt-5">Start shopping</a>
      </div>`);
  }

  setView(`
    <div class="mx-auto max-w-2xl">
      <h1 class="text-xl font-semibold">Your orders</h1>
      <div class="mt-4 space-y-3">
        ${orders.map((o) => {
          const st = STATUS[o.status] ?? STATUS.awaiting_payment;
          const count = (o.items ?? []).reduce((n, i) => n + (i.qty ?? 0), 0);
          return `
            <a href="#/order/${o.id}" class="card flex items-center justify-between gap-4 p-4 hover:border-brand-500">
              <div class="min-w-0">
                <p class="font-medium">${esc(o.order_number)}</p>
                <p class="mt-0.5 text-xs text-neutral-500">
                  ${new Date(o.created_at).toLocaleDateString()} · ${count} item${count === 1 ? '' : 's'}
                </p>
                <span class="mt-1.5 inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${TONE[st.tone]}">
                  ${esc(st.label)}
                </span>
              </div>
              <p class="shrink-0 font-semibold">${formatCents(o.total_cents)}</p>
            </a>`;
        }).join('')}
      </div>
    </div>`);
}
