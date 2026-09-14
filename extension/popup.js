/**
 * Capture popup.
 *
 * Runs extract.js in the active tab, shows what was found, and posts the
 * reviewed result to the local admin server. Images are fetched here (in the
 * extension, which is not bound by the page's CSP) and sent as data URLs so
 * the server never has to reach out to the supplier itself.
 */
const ADMIN = 'http://127.0.0.1:4321';
const $ = (id) => document.getElementById(id);

let data = null;
let pricing = null;
const selected = new Set();

/**
 * Does the currency on the page match the one we are configured to convert
 * from? Converting an Rf price with an SGD rate silently inflates it ~12x,
 * so this must be checked, not assumed.
 */
const CURRENCY_ALIASES = {
  SGD: ['SGD', 'S$'],
  MVR: ['MVR', 'Rf', 'Rf.', 'ރ'],
  USD: ['USD', 'US $', 'US$', '$'],
  AUD: ['AUD', 'A$'],
  GBP: ['GBP', '£'],
  EUR: ['EUR', '€'],
  INR: ['INR', '₹'],
};

function currencyMatches(pageSymbol, expectedCode) {
  if (!pageSymbol || !expectedCode) return null;   // unknown, do not claim
  const aliases = CURRENCY_ALIASES[expectedCode] ?? [expectedCode];
  const seen = pageSymbol.replace(/\s+/g, '');
  return aliases.some((a) => a.replace(/\s+/g, '').toLowerCase() === seen.toLowerCase());
}

/** Which currency does this page symbol most likely mean? */
function nameCurrency(symbol) {
  if (!symbol) return null;
  const seen = symbol.replace(/\s+/g, '').toLowerCase();
  for (const [code, aliases] of Object.entries(CURRENCY_ALIASES)) {
    if (aliases.some((a) => a.replace(/\s+/g, '').toLowerCase() === seen)) return code;
  }
  return null;
}

/** Mirrors src/lib/pricing.js — the extension cannot import from the repo. */
function toMvrCents(sourceAmount, cfg) {
  const amount = Number(sourceAmount);
  if (!Number.isFinite(amount) || amount < 0 || !cfg) return null;
  const withFlat = amount * cfg.rate * (1 + (cfg.feePercent ?? 0) / 100) + (cfg.flatFeeMvr ?? 0);
  let final = withFlat;
  if (cfg.rounding === 'up') final = Math.ceil(withFlat / cfg.roundToMvr) * cfg.roundToMvr;
  else if (cfg.rounding === 'nearest') final = Math.round(withFlat / cfg.roundToMvr) * cfg.roundToMvr;
  return Math.round(final * 100);
}

const fail = (msg) => {
  $('err').textContent = msg;
  $('err').classList.remove('hide');
  // Extraction failing is exactly when the structure dump is wanted, so keep
  // the button reachable rather than hiding it with the rest of the form.
  $('diagfallback').classList.remove('hide');
};

const status = (msg, kind = 'warn') => {
  // #status lives inside the results block, which stays hidden when
  // extraction fails — fall back to the always-visible box so a message can
  // never be written somewhere invisible.
  const visible = !$('found').classList.contains('hide');
  const el = visible ? $('status') : $('err');
  el.textContent = msg;
  el.className = `note ${visible ? kind : 'warn'}`;
  el.classList.remove('hide');
};

document.getElementById('diag2')?.addEventListener('click', diagnose);

// ------------------------------------------------------------------ extract
(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return fail('No active tab.');

  if (!/^https?:/.test(tab.url ?? '')) {
    return fail('Open a product page first, then click Capture.');
  }

  let result;
  try {
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['extract.js'],
    });
    result = out?.result;
  } catch (e) {
    return fail(`Could not read this page: ${e.message}`);
  }

  if (!result?.title) {
    return fail('No product found on this page. Open the product page itself, not a search result.');
  }

  // Warn when the page rendered but yielded almost nothing — usually means
  // the selectors do not match this site yet.
  if (!result.priceNumber && result.options.length === 0
      && result.swatches.length === 0 && result.gallery.length === 0) {
    status('Only the title was found. Use "Copy page structure" below and send '
      + 'it over so the selectors can be fixed for this site.', 'warn');
  }

  data = result;

  // Pricing config is optional: without the editor running you can still
  // capture, you just enter the MVR price yourself.
  try {
    const r = await fetch(`${ADMIN}/api/pricing`);
    const cfg = await r.json();
    if (cfg.configured) pricing = cfg;
  } catch { /* editor not running */ }

  render();
})();

// ------------------------------------------------------------------- render
function render() {
  const v = chrome.runtime.getManifest().version;
  $('src').textContent = `${data.host} · v${v}`;
  $('found').classList.remove('hide');

  $('title').value = data.title;

  // The capture records the SOURCE price and the currency the page showed.
  // Conversion happens in the editor at import time, where the rate is
  // visible and can be corrected — converting here would bake in whatever
  // rate happened to be stored when the tab was captured.
  const code = nameCurrency(data.priceCurrency);
  $('price').value = data.priceNumber ?? '';

  if (data.priceNumber != null) {
    const known = code && pricing?.rates?.[code];
    $('pricenote').textContent = known
      ? `${code} ${data.priceNumber.toFixed(2)} — converts to about `
        + `MVR ${(toMvrCents(data.priceNumber, { ...pricing, rate: pricing.rates[code] }) / 100).toFixed(2)} at import`
      : code
        ? `${code} ${data.priceNumber.toFixed(2)} — no ${code} rate configured; set one before importing.`
        : `Page showed ${data.priceText} — currency unrecognised, check it at import.`;
  } else if (data.priceText) {
    $('pricenote').textContent = `Page showed ${data.priceText} — could not read a number.`;
  } else {
    $('pricenote').textContent = 'No price found on this page.';
  }

  // Show which currency will be recorded, so a wrong site setting is obvious
  // before saving rather than after importing.
  $('currlabel').textContent = code ? `Price (${code})` : 'Price (currency unknown)';

  // Options, read-only: they are the supplier's, and editing them here would
  // desync from the variants the editor builds.
  $('opts').innerHTML = data.options.length
    ? `<label>Options found</label>` + data.options.map((o) =>
        `<div class="muted">${escapeHtml(o.name)}: ${o.values.length} value(s)</div>`).join('')
    : `<label>Options</label><div class="muted">None detected — imports as a simple product.</div>`;

  // Swatch images first: those are the per-variant ones, which matter most.
  const all = [
    ...data.swatches.map((s) => ({ src: s.src, label: s.value, variant: true })),
    ...data.gallery.map((src) => ({ src, label: '', variant: false })),
  ];
  const seen = new Set();
  const images = all.filter((i) => !seen.has(i.src) && seen.add(i.src));

  $('imgs').innerHTML = images.map((im, i) => `
    <div class="thumb on" data-i="${i}" title="${escapeHtml(im.label || 'Gallery image')}">
      <img src="${im.src}" loading="lazy" />
      <span class="tick">${im.variant ? '◆' : ''}</span>
    </div>`).join('');

  images.forEach((_, i) => selected.add(i));
  data._images = images;
  updateCount();

  const variantCount = images.filter((i) => i.variant).length;
  // Report what extraction actually produced. "0 found" and "found but not
  // fetched" are different failures and were previously indistinguishable.
  $('swatchnote').textContent = images.length === 0
    ? `Extractor found no images on this page (${data.gallery.length} gallery, `
      + `${data.swatches.length} swatch). Use "Copy page structure" below.`
    : variantCount
      ? `${images.length} found · ◆ ${variantCount} look like variant images.`
      : `${images.length} found, all gallery shots.`;

  for (const el of $('imgs').querySelectorAll('.thumb')) {
    el.addEventListener('click', () => {
      const i = Number(el.dataset.i);
      if (selected.has(i)) selected.delete(i); else selected.add(i);
      el.classList.toggle('on', selected.has(i));
      updateCount();
    });
  }

  $('all').addEventListener('click', () => {
    images.forEach((_, i) => selected.add(i));
    for (const el of $('imgs').querySelectorAll('.thumb')) el.classList.add('on');
    updateCount();
  });
  $('none').addEventListener('click', () => {
    selected.clear();
    for (const el of $('imgs').querySelectorAll('.thumb')) el.classList.remove('on');
    updateCount();
  });

  $('save').addEventListener('click', save);
  $('diag').addEventListener('click', diagnose);
}

/**
 * Dump the page's structure to the clipboard.
 *
 * Used when extraction comes back empty: reports class names, element counts
 * and short text samples so selectors can be written from the real DOM.
 */
async function diagnose(ev) {
  // Called both directly and as a click listener, which passes the event.
  // Resolve the button from the event target rather than trusting an id.
  const btn = ev?.currentTarget instanceof HTMLElement ? ev.currentTarget : $('diag');
  if (!btn) return;
  btn.disabled = true;
  btn.textContent = 'Reading…';
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const [out] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['diagnose.js'],
    });
    const report = JSON.stringify(out?.result ?? {}, null, 2);
    await navigator.clipboard.writeText(report);
    status(`Copied ${(report.length / 1024).toFixed(1)} KB of page structure to the clipboard.`, 'ok');
  } catch (e) {
    status(`Could not read the page: ${e.message}`, 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Copy page structure';
  }
}

function updateCount() {
  $('imgcount').textContent = `${selected.size} selected`;
  $('save').disabled = selected.size === 0 && !$('title').value.trim();
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// --------------------------------------------------------------------- save
async function save() {
  const title = $('title').value.trim();
  if (!title) return status('Give the product a title first.', 'bad');

  $('save').disabled = true;
  try {
    await doSave(title);
  } catch (e) {
    // An unexpected throw previously vanished into the finally block, leaving
    // a misleading success message on screen. Always surface it.
    status(`Capture failed: ${e.message}`, 'bad');
    console.error('[EshanExpress] capture failed', e);
  } finally {
    // Several paths below return early; without this the button stays
    // disabled and the popup looks dead.
    if ($('save').textContent !== 'Saved') $('save').disabled = false;
  }
}

async function doSave(title) {
  const chosen = [...selected].map((i) => data._images[i]);
  if (chosen.length === 0) {
    return status('No images selected. Pick at least one, or use "All".', 'bad');
  }
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  // Optional pre-flight: chrome.permissions exists only when the
  // "permissions" API is declared in the manifest. Accessing it otherwise
  // throws SYNCHRONOUSLY, which .catch() cannot intercept — that skipped the
  // whole fetch loop and reported "Saved 0 image(s)" with no explanation.
  const hosts = [...new Set(chosen.map((im) => {
    try { return new URL(im.src).origin; } catch { return null; }
  }).filter(Boolean))];

  if (typeof chrome !== 'undefined' && chrome.permissions?.contains) {
    const missing = [];
    for (const origin of hosts) {
      let ok = true;
      try {
        ok = await chrome.permissions.contains({ origins: [`${origin}/*`] });
      } catch { ok = true; }   // cannot tell: proceed and let fetch decide
      if (!ok) missing.push(origin);
    }
    if (hosts.length > 0 && missing.length === hosts.length) {
      return status(
        `No permission to fetch from ${missing.join(', ')}. `
        + 'Remove and re-add the extension at chrome://extensions.', 'bad');
    }
  }

  const images = [];
  const failures = [];
  // Logged so a failure can be read off the popup console instead of guessed
  // at. Right-click the popup -> Inspect to see it.
  console.log(`[EshanExpress] fetching ${chosen.length} image(s)`, chosen.map((c) => c.src));

  for (const [n, im] of chosen.entries()) {
    status(`Fetching image ${n + 1} of ${chosen.length}…`);
    try {
      const res = await fetch(im.src);
      console.log(`[EshanExpress] #${n + 1} ${res.status} ${res.headers.get('content-type')} ${im.src}`);
      if (!res.ok) { failures.push(`${res.status} on ${new URL(im.src).host}`); continue; }
      const blob = await res.blob();
      console.log(`[EshanExpress] #${n + 1} blob ${blob.size} bytes, type "${blob.type}"`);
      if (blob.size > 8 * 1024 * 1024) { failures.push('too large'); continue; }
      if (blob.size === 0) { failures.push('empty response'); continue; }

      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      });

      const name = `${slug}-${n + 1}.${ext}`;
      console.log(`[EshanExpress] #${n + 1} -> ${name} (${dataUrl.length} chars)`);
      images.push({ name, dataUrl, sourceUrl: im.src, variantValue: im.label || null });
    } catch (e) {
      // Usually a missing host permission, which silently yields zero images
      // if not surfaced. Record the host so the cause is obvious.
      let host = '?';
      try { host = new URL(im.src).host; } catch { /* malformed url */ }
      console.error(`[EshanExpress] #${n + 1} FAILED`, im.src, e);
      failures.push(`blocked: ${host} (${e.message})`);
    }
  }

  if (images.length === 0 && chosen.length > 0) {
    // Group by reason so the actual cause is obvious rather than a sample.
    const byReason = {};
    for (const f of failures) byReason[f] = (byReason[f] ?? 0) + 1;
    const summary = Object.entries(byReason)
      .map(([r, n]) => `${n}× ${r}`).join(', ');

    return status(
      `None of the ${chosen.length} images could be fetched. ${summary}. `
      + 'If it says "blocked", that host needs adding to host_permissions in '
      + 'manifest.json — then reload the extension at chrome://extensions.',
      'bad');
  }

  console.log(`[EshanExpress] sending ${images.length} image(s) to the editor`);
  status('Saving to your catalog…');
  try {
    const res = await fetch(`${ADMIN}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: {
          title,
          // Stored in the SOURCE currency; the editor converts at import.
          sourceAmount: $('price').value ? parseFloat($('price').value) : null,
          sourceCurrency: nameCurrency(data.priceCurrency) ?? data.priceCurrency ?? null,
          priceText: data.priceText ?? null,
          options: data.options,
          specs: data.specs,
          sourceUrl: data.sourceUrl,
          host: data.host,
        },
        images,
      }),
    });
    const out = await res.json();
    console.log('[EshanExpress] server replied', out);
    if (!res.ok) throw new Error(out.error ?? 'Save failed');

    const skipped = chosen.length - images.length;
    const none = out.savedImages === 0 && chosen.length > 0;
    status(
      none
        ? `Saved the product but NO images (${chosen.length} were selected). `
          + (out.rejected?.length ? out.rejected[0] : 'Check the popup console.')
        : `Saved ${out.savedImages} image(s)`
          + (skipped ? ` (${skipped} could not be fetched)` : '')
          + `. ${out.staged} product(s) waiting in the editor.`,
      none ? 'bad' : skipped ? 'warn' : 'ok');
    $('save').textContent = 'Saved';
  } catch (e) {
    status(`Could not reach the editor. Is "npm run admin" running? (${e.message})`, 'bad');
  }
}
