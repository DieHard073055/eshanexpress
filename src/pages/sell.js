import { setView, errorView, esc, toast } from '../components/layout.js';
import { getUser } from '../lib/auth.js';
import { supabase, isConfigured } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';

/**
 * "Sell on EshanExpress" — a signed-in customer applies to become a seller
 * (release plan §5).
 *
 * The form writes one store_applications row; an admin reviews it. Becoming
 * a seller (creating the store row, elevating the profile) is deliberately
 * manual SQL on the admin side — this page never touches roles.
 */

const STATUS_COPY = {
  pending: {
    title: 'Application under review',
    body: 'The administrator reviews applications by hand. You will see the outcome here.',
  },
  approved: {
    title: 'Application approved',
    body: 'The administrator is setting up your store. Once your account is elevated, the store portal appears on this page.',
  },
  rejected: {
    title: 'Application not accepted',
    body: null, // review_note carries the reason
  },
};

export async function sellPage() {
  if (!isConfigured) return setView(errorView('Accounts are unavailable right now.'));
  if (!getUser()) return navigate('/signin?next=/sell', { replace: true });

  const { data: app, error } = await supabase
    .from('store_applications')
    .select('id, store_name, contact, note, status, review_note, created_at')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) return setView(errorView('Could not load your application.'));

  if (app) {
    const copy = STATUS_COPY[app.status] ?? STATUS_COPY.pending;
    const tone = {
      pending: 'border-amber-200 bg-amber-50 text-amber-900',
      approved: 'border-green-200 bg-green-50 text-green-900',
      rejected: 'border-red-200 bg-red-50 text-red-800',
    }[app.status] ?? '';

    setView(`
      <div class="mx-auto max-w-lg">
        <h1 class="text-xl font-semibold">Sell on EshanExpress</h1>
        <div class="card mt-4 border ${tone} p-5">
          <p class="font-semibold">${esc(copy.title)}</p>
          <p class="mt-1 text-sm">${esc(copy.body ?? '')}</p>
          ${app.review_note ? `
            <p class="mt-3 rounded-lg bg-white/70 p-3 text-sm">${esc(app.review_note)}</p>` : ''}
        </div>
        <dl class="card mt-4 space-y-2 p-5 text-sm">
          <div>
            <dt class="text-neutral-500">Store name</dt>
            <dd class="font-medium">${esc(app.store_name)}</dd>
          </div>
          <div>
            <dt class="text-neutral-500">Contact</dt>
            <dd class="font-medium">${esc(app.contact)}</dd>
          </div>
          ${app.note ? `
            <div>
              <dt class="text-neutral-500">Your note</dt>
              <dd class="font-medium">${esc(app.note)}</dd>
            </div>` : ''}
          <div>
            <dt class="text-neutral-500">Submitted</dt>
            <dd class="font-medium">${new Date(app.created_at).toLocaleDateString()}</dd>
          </div>
        </dl>
        <a href="#/account" class="btn-secondary mt-5 w-full">Back to account</a>
      </div>`);
    return;
  }

  setView(`
    <div class="mx-auto max-w-lg">
      <h1 class="text-xl font-semibold">Sell on EshanExpress</h1>
      <p class="mt-1 text-sm text-neutral-500">
        Tell us about your store. Applications are reviewed by hand, usually
        within a few days.
      </p>

      <div class="card mt-4 p-5">
        <div class="space-y-3">
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Store name</span>
            <input id="s-name" maxlength="80"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">Contact</span>
            <input id="s-contact" maxlength="120" placeholder="Phone or email"
                   class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" />
          </label>
          <label class="block">
            <span class="text-sm font-medium text-neutral-700">What will you sell? <span class="font-normal text-neutral-400">(optional)</span></span>
            <textarea id="s-note" rows="3" maxlength="500"
                      class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm"></textarea>
          </label>
        </div>
        <p id="s-err" class="mt-3 hidden rounded-lg bg-red-50 p-2.5 text-sm text-red-700"></p>
        <button id="s-submit" class="btn-primary mt-4 w-full">Submit application</button>
      </div>
    </div>`);

  document.getElementById('s-submit').addEventListener('click', async () => {
    const err = document.getElementById('s-err');
    const fail = (m) => { err.textContent = m; err.classList.remove('hidden'); };
    err.classList.add('hidden');

    const store_name = document.getElementById('s-name').value.trim();
    const contact = document.getElementById('s-contact').value.trim();
    const note = document.getElementById('s-note').value.trim() || null;

    if (!store_name) return fail('Give your store a name.');
    if (!contact) return fail('Add a phone number or email we can reach you on.');

    const btn = document.getElementById('s-submit');
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const { error: upErr } = await supabase
      .from('store_applications')
      .insert({ user_id: getUser().id, store_name, contact, note });

    btn.disabled = false;
    btn.textContent = 'Submit application';

    if (upErr) {
      // 23505 = the one-pending-per-user index; anything else is reported as-is.
      if (upErr.code === '23505') return fail('You already have a pending application.');
      return fail('Could not submit that application. Try again.');
    }

    toast('Application submitted');
    sellPage();
  });
}
