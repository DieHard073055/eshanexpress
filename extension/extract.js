/**
 * Runs in the page the user clicked Capture on, via activeTab.
 *
 * Reads what is already rendered — title, price, options and the images the
 * page has loaded. It does not crawl, follow links, or run anywhere the user
 * has not explicitly invoked it.
 *
 * Marketplace markup changes often. Every selector below is a best guess with
 * a generic fallback, and the popup shows exactly what was found so nothing
 * is captured blind.
 */
(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const uniq = (a) => [...new Set(a)];

  /** Upgrade marketplace thumbnail URLs to a usable size. */
  function fullSize(url) {
    if (!url) return null;
    let u = url.startsWith('//') ? `https:${url}` : url;
    // AliExpress/Temu append size suffixes like _220x220.jpg or _.webp
    u = u.replace(/_\d+x\d+(xz)?\.(jpg|jpeg|png|webp)/i, '.$2')
         .replace(/_\d+x\d+q\d+\.(jpg|jpeg|png|webp)/i, '.$1')
         .replace(/\.(jpg|jpeg|png|webp)_\d+x\d+.*$/i, '.$1');
    return u.split('?')[0];
  }

  const looksLikeProductImage = (src) =>
    src && /^https?:/.test(src)
    && !/sprite|icon|logo|avatar|placeholder|blank|pixel/i.test(src)
    && /\.(jpg|jpeg|png|webp)/i.test(src);

  // ------------------------------------------------------------------ title
  const title =
    text(document.querySelector('h1'))
    || text(document.querySelector('[data-pl="product-title"]'))
    || document.title.split(/[|\-–]/)[0].trim();

  // ------------------------------------------------------------------ price
  // Prefer a currency-prefixed number in the page's own markup.
  const priceText = (() => {
    const candidates = [
      '[class*="price--current"]', '[class*="product-price-value"]',
      '[class*="Price"]', '[data-pl="product-price"]',
    ];
    for (const sel of candidates) {
      const t = text(document.querySelector(sel));
      if (/\d/.test(t)) return t;
    }
    const m = document.body.innerText.match(/(?:MVR|USD|US\s*\$|\$|£|€)\s*[\d,]+(?:\.\d{2})?/);
    return m ? m[0] : '';
  })();

  const priceNumber = (() => {
    const m = priceText.replace(/,/g, '').match(/[\d.]+/);
    return m ? parseFloat(m[0]) : null;
  })();

  // ---------------------------------------------------------------- options
  // Option groups are usually a label followed by a row of swatches/buttons.
  const options = [];
  for (const group of document.querySelectorAll(
    '[class*="sku-item"], [class*="SkuProperty"], [class*="sku-property"]')) {
    const name = text(group.querySelector(
      '[class*="title"], [class*="label"], dt, .sku-title')).replace(/:$/, '');
    const values = uniq([...group.querySelectorAll(
      '[data-sku-col], [class*="sku-property-item"], [class*="value"] li, button, [role="option"]')]
      .map((el) => el.getAttribute('title')
        || el.querySelector('img')?.getAttribute('alt')
        || text(el))
      .filter((v) => v && v.length < 60));

    if (name && values.length > 1) options.push({ name, values });
  }

  // ----------------------------------------------------------------- images
  // The gallery plus any swatch thumbnails, which are usually the per-variant
  // images. Swatches are recorded with the value they sit next to so the
  // editor can map image -> variant.
  const gallery = uniq([...document.querySelectorAll(
    '[class*="gallery"] img, [class*="slider"] img, [class*="image-view"] img, main img')]
    .map((img) => fullSize(img.currentSrc || img.src))
    .filter(looksLikeProductImage));

  const swatches = [];
  for (const el of document.querySelectorAll(
    '[data-sku-col] img, [class*="sku-property-image"] img, [class*="sku-item"] img')) {
    const src = fullSize(el.currentSrc || el.src);
    if (!looksLikeProductImage(src)) continue;
    const holder = el.closest('[title], li, button, [role="option"]');
    const value = holder?.getAttribute('title') || el.getAttribute('alt') || '';
    swatches.push({ src, value: value.trim() });
  }

  // ------------------------------------------------------------------ specs
  const specs = {};
  for (const row of document.querySelectorAll(
    '[class*="specification"] li, [class*="spec"] tr, [class*="attributes"] li')) {
    const cells = row.querySelectorAll('td, th, span, div');
    if (cells.length >= 2) {
      const k = text(cells[0]).replace(/:$/, '');
      const v = text(cells[1]);
      if (k && v && k.length < 40 && v.length < 120 && k !== v) specs[k] = v;
    }
    if (Object.keys(specs).length >= 12) break;
  }

  return {
    title,
    priceText,
    priceNumber,
    options,
    specs,
    gallery: gallery.slice(0, 12),
    swatches: swatches.slice(0, 40),
    sourceUrl: location.href.split('?')[0],
    host: location.host,
  };
})();
