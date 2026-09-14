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
const selected = new Set();

const fail = (msg) => {
  $('err').textContent = msg;
  $('err').classList.remove('hide');
};

const status = (msg, kind = 'warn') => {
  const el = $('status');
  el.textContent = msg;
  el.className = `note ${kind}`;
  el.classList.remove('hide');
};

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

  data = result;
  render();
})();

// ------------------------------------------------------------------- render
function render() {
  $('src').textContent = data.host;
  $('found').classList.remove('hide');

  $('title').value = data.title;
  $('price').value = data.priceNumber ?? '';
  $('pricenote').textContent = data.priceText
    ? `Page showed: ${data.priceText}`
    : 'No price found — enter it yourself.';

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
  $('swatchnote').textContent = variantCount
    ? `◆ ${variantCount} look like variant images; the rest are gallery shots.`
    : 'No variant-specific images detected on this page.';

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
  const chosen = [...selected].map((i) => data._images[i]);
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);

  const images = [];
  for (const [n, im] of chosen.entries()) {
    status(`Fetching image ${n + 1} of ${chosen.length}…`);
    try {
      const res = await fetch(im.src);
      if (!res.ok) continue;
      const blob = await res.blob();
      if (blob.size > 8 * 1024 * 1024) continue;

      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      const dataUrl = await new Promise((resolve) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.readAsDataURL(blob);
      });

      images.push({
        name: `${slug}-${n + 1}.${ext}`,
        dataUrl,
        sourceUrl: im.src,
        variantValue: im.label || null,
      });
    } catch {
      // A blocked image is skipped rather than failing the whole capture.
    }
  }

  status('Saving to your catalog…');
  try {
    const res = await fetch(`${ADMIN}/api/capture`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: {
          title,
          priceCents: $('price').value ? Math.round(parseFloat($('price').value) * 100) : null,
          options: data.options,
          specs: data.specs,
          sourceUrl: data.sourceUrl,
          host: data.host,
        },
        images,
      }),
    });
    const out = await res.json();
    if (!res.ok) throw new Error(out.error ?? 'Save failed');

    status(`Saved ${out.savedImages} image(s). ${out.staged} product(s) waiting in the editor.`, 'ok');
    $('save').textContent = 'Saved';
  } catch (e) {
    status(`Could not reach the editor. Is "npm run admin" running? (${e.message})`, 'bad');
    $('save').disabled = false;
  }
}
