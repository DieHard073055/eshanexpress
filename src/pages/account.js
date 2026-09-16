import { setView, esc, toast } from '../components/layout.js';
import { signIn, signUp, signOut, resetPassword, getUser, getProfile } from '../lib/auth.js';
import { isConfigured } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';

/** Shared shell for the sign-in / sign-up / reset forms. */
function panel(title, inner, footer = '') {
  return `
    <div class="mx-auto max-w-sm">
      <div class="card p-6">
        <h1 class="text-lg font-semibold">${esc(title)}</h1>
        ${inner}
      </div>
      ${footer ? `<p class="mt-4 text-center text-sm text-neutral-600">${footer}</p>` : ''}
    </div>`;
}

const field = (id, label, type, extra = '') => `
  <div class="mt-4">
    <label for="${id}" class="block text-sm font-medium text-neutral-700">${esc(label)}</label>
    <input id="${id}" type="${type}" ${extra}
           class="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2.5 text-sm
                  focus:border-brand-500" />
  </div>`;

const errorBox = `<p id="err" class="mt-4 hidden rounded-lg bg-red-50 p-3 text-sm text-red-700"></p>`;

function showError(msg) {
  const el = document.getElementById('err');
  el.textContent = msg;
  el.classList.remove('hidden');
}

function unavailable() {
  return setView(panel('Accounts unavailable',
    `<p class="mt-3 text-sm text-neutral-600">
       Sign-in is not configured for this site yet. You can still browse and
       build a cart.
     </p>
     <a href="#/" class="btn-secondary mt-5 w-full">Back to shop</a>`));
}

export async function signInPage(_p, query) {
  if (!isConfigured) return unavailable();
  if (getUser()) return navigate(query.next || '/account', { replace: true });

  setView(panel('Sign in', `
    <form id="form" novalidate>
      ${field('email', 'Email', 'email', 'autocomplete="email" required')}
      ${field('password', 'Password', 'password', 'autocomplete="current-password" required')}
      ${errorBox}
      <button id="submit" class="btn-primary mt-5 w-full">Sign in</button>
    </form>
    <button id="forgot" class="mt-3 w-full text-center text-sm text-neutral-500 hover:text-brand-600">
      Forgot your password?
    </button>`,
    `New here? <a href="#/signup${query.next ? `?next=${encodeURIComponent(query.next)}` : ''}"
       class="font-medium text-brand-600 hover:underline">Create an account</a>`));

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = document.getElementById('submit');
    btn.disabled = true;
    btn.textContent = 'Signing in…';
    const { error } = await signIn(
      document.getElementById('email').value.trim(),
      document.getElementById('password').value,
    );
    if (error) {
      showError(error);
      btn.disabled = false;
      btn.textContent = 'Sign in';
      return;
    }
    toast('Signed in');
    navigate(query.next || '/account', { replace: true });
  });

  document.getElementById('forgot').addEventListener('click', () => navigate('/forgot'));
}

export async function signUpPage(_p, query) {
  if (!isConfigured) return unavailable();
  if (getUser()) return navigate(query.next || '/account', { replace: true });

  setView(panel('Create your account', `
    <form id="form" novalidate>
      ${field('email', 'Email', 'email', 'autocomplete="email" required')}
      ${field('password', 'Password', 'password', 'autocomplete="new-password" required minlength="6"')}
      <p class="mt-1.5 text-xs text-neutral-500">At least 6 characters.</p>
      ${errorBox}
      <button id="submit" class="btn-primary mt-5 w-full">Create account</button>
    </form>`,
    `Already have an account? <a href="#/signin${query.next ? `?next=${encodeURIComponent(query.next)}` : ''}"
       class="font-medium text-brand-600 hover:underline">Sign in</a>`));

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const password = document.getElementById('password').value;

    if (password.length < 6) return showError('Password must be at least 6 characters.');

    const btn = document.getElementById('submit');
    btn.disabled = true;
    btn.textContent = 'Creating…';

    const { error, needsConfirmation } = await signUp(email, password);
    if (error) {
      showError(error);
      btn.disabled = false;
      btn.textContent = 'Create account';
      return;
    }

    if (needsConfirmation) {
      return setView(panel('Check your email', `
        <p class="mt-3 text-sm leading-relaxed text-neutral-600">
          We sent a confirmation link to <strong>${esc(email)}</strong>.
          Click it to activate your account, then sign in.
        </p>
        <a href="#/signin" class="btn-primary mt-5 w-full">Back to sign in</a>`));
    }

    toast('Welcome!');
    navigate(query.next || '/account', { replace: true });
  });
}

export async function forgotPage() {
  if (!isConfigured) return unavailable();

  setView(panel('Reset your password', `
    <p class="mt-2 text-sm text-neutral-600">
      We will email you a link to choose a new password.
    </p>
    <form id="form" novalidate>
      ${field('email', 'Email', 'email', 'autocomplete="email" required')}
      ${errorBox}
      <button id="submit" class="btn-primary mt-5 w-full">Send reset link</button>
    </form>`,
    `<a href="#/signin" class="font-medium text-brand-600 hover:underline">Back to sign in</a>`));

  document.getElementById('form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = document.getElementById('email').value.trim();
    const btn = document.getElementById('submit');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    const { error } = await resetPassword(email);
    if (error) {
      showError(error);
      btn.disabled = false;
      btn.textContent = 'Send reset link';
      return;
    }
    // Deliberately identical whether or not the address exists, so this
    // cannot be used to discover which emails have accounts.
    setView(panel('Check your email', `
      <p class="mt-3 text-sm leading-relaxed text-neutral-600">
        If an account exists for <strong>${esc(email)}</strong>, a reset link
        is on its way.
      </p>
      <a href="#/signin" class="btn-primary mt-5 w-full">Back to sign in</a>`));
  });
}

export async function accountPage() {
  if (!isConfigured) return unavailable();
  const user = getUser();
  if (!user) return navigate('/signin?next=/account', { replace: true });

  setView(`
    <div class="mx-auto max-w-lg">
      <h1 class="text-xl font-semibold">Your account</h1>
      <div class="card mt-4 p-5">
        <dl class="text-sm">
          <dt class="text-neutral-500">Email</dt>
          <dd class="mt-0.5 font-medium">${esc(user.email)}</dd>
        </dl>
      </div>

      <div id="staff-link" class="mt-4 hidden"></div>

      <div class="mt-4 grid gap-3 sm:grid-cols-2">
        <a href="#/orders" class="card flex items-center justify-between p-4 hover:border-brand-500">
          <span class="font-medium">Your orders</span>
          <span aria-hidden="true" class="text-neutral-400">&rarr;</span>
        </a>
        <a href="#/" class="card flex items-center justify-between p-4 hover:border-brand-500">
          <span class="font-medium">Continue shopping</span>
          <span aria-hidden="true" class="text-neutral-400">&rarr;</span>
        </a>
      </div>

      <button id="signout" class="btn-secondary mt-6 w-full">Sign out</button>
    </div>`);

  // Sellers get a link to their portal; regular customers never see it.
  // Customers instead get the seller-application entry (release plan §5).
  const profile = await getProfile();
  if (profile?.role === 'store_owner' || profile?.role === 'admin') {
    const box = document.getElementById('staff-link');
    box.className = 'mt-4';
    box.innerHTML = `
      <a href="#/store" class="card flex items-center justify-between border-brand-300 bg-brand-50 p-4
                               hover:border-brand-500">
        <span>
          <span class="font-medium text-brand-900">Store portal</span>
          <span class="mt-0.5 block text-xs text-brand-900/70">
            ${esc(profile.stores?.name ?? 'Manage orders and products')}
          </span>
        </span>
        <span aria-hidden="true" class="text-brand-500">&rarr;</span>
      </a>`;
  } else if (profile?.role === 'customer') {
    const box = document.getElementById('staff-link');
    box.className = 'mt-4';
    box.innerHTML = `
      <a href="#/sell" class="card flex items-center justify-between p-4 hover:border-brand-500">
        <span>
          <span class="font-medium">Sell on EshanExpress</span>
          <span class="mt-0.5 block text-xs text-neutral-500">
            Open your own store on the marketplace
          </span>
        </span>
        <span aria-hidden="true" class="text-neutral-400">&rarr;</span>
      </a>`;
  }

  document.getElementById('signout').addEventListener('click', async () => {
    await signOut();
    toast('Signed out');
    navigate('/');
  });
}
