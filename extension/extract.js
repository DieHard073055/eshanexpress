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

  /**
   * Upgrade a thumbnail URL to full size.
   *
   * Real examples seen on AliExpress:
   *   S1cb...h.jpg_220x220q75.jpg_.avif  ->  S1cb...h.jpg
   *   ...祖_640x640.jpg                   ->  ...祖.jpg
   */
  function fullSize(url) {
    if (!url) return null;
    let u = url.startsWith('//') ? `https:${url}` : url;
    u = u.split('?')[0];
    // Strip everything appended after the real extension.
    u = u.replace(/\.(jpg|jpeg|png|webp)_.*$/i, '.$1');
    // Strip a size suffix that precedes the extension.
    u = u.replace(/_\d+x\d+(q\d+)?(xz)?\.(jpg|jpeg|png|webp)$/i, '.$3');
    return u;
  }

  const looksLikeProductImage = (src) =>
    src && /^https?:/.test(src)
    && !/sprite|icon|logo|avatar|placeholder|blank|pixel/i.test(src)
    && /\.(jpg|jpeg|png|webp)/i.test(src);

  // ------------------------------------------------------------------ title
  // A page can carry several h1s (AliExpress has a site-name one), so prefer
  // an explicit product-title container, then the longest h1, then <title>.
  const title = (() => {
    const named = text(document.querySelector(
      '[class*="title--wrap"], [data-pl="product-title"], [class*="ProductTitle"]'));
    if (named && named.length > 3) return named;

    const h1s = [...document.querySelectorAll('h1')]
      .map(text).filter((t) => t.length > 3).sort((a, b) => b.length - a.length);
    if (h1s[0]) return h1s[0];

    return document.title.split(/\s[|\-–]\s/)[0].trim();
  })();

  // ------------------------------------------------------------------ price
  //
  // The price block often bundles promo copy:
  //   "Rf163.30 New shoppers save Rf157.14 Rf320.44"
  // The CURRENT price is the first amount; the others are a discount and the
  // struck-through original. Taking the first is correct, and the raw text is
  // returned too so the popup can show what the page actually said.
  //
  // Currency symbol varies with the site's locale (S$ when browsing in SGD,
  // Rf here), so capture it rather than assuming.
  const CURRENCY = String.raw`(?:S\$|SGD|MVR|Rf\.?|US\s*\$|USD|A\$|₹|£|€|\$)`;

  /**
   * Is this string a real price?
   *
   * Temu ships a "$0123456789.01" placeholder used to size the price element.
   * A leading zero, a sequential run of digits, or an absurd magnitude all
   * mean this is not a price.
   */
  const plausiblePrice = (str) => {
    const m = String(str).replace(/,/g, '').match(/(\d+(?:\.\d{1,2})?)/);
    if (!m) return false;
    if (/0123456789/.test(m[1])) return false;      // the placeholder
    if (/^0\d/.test(m[1])) return false;            // leading zero
    const n = parseFloat(m[1]);
    return Number.isFinite(n) && n > 0 && n < 1000000;
  };

  const priceText = (() => {
    // Most specific first. The AliExpress diagnostic showed
    // price-default--wrap contains "US $37.12 Save US $37.87 …" while
    // price-default--current holds exactly "US $37.12".
    for (const sel of ['[class*="price-default--current"]', '[class*="price--current"]',
                       '[class*="price-default--currentWrap"]',
                       '[class*="product-price-value"]', '[data-pl="product-price"]',
                       '[class*="price-default--wrap"]', '[class*="Price"]']) {
      const t = text(document.querySelector(sel));
      if (new RegExp(CURRENCY + String.raw`\s*[\d,]`).test(t) && plausiblePrice(t)) return t;
    }

    // Sites like Temu split "$2.95" across nested spans, so no single element
    // holds the whole string. Scan leaf-ish nodes for a complete amount and
    // take the first PLAUSIBLE one with a decimal part — a bare integer is
    // usually a badge ("5Pcs", "0") rather than a price.
    const AMOUNT = new RegExp(CURRENCY + String.raw`\s*\d[\d,]*\.\d{2}`);
    for (const el of document.querySelectorAll('span, div, p, strong, b')) {
      if (el.children.length > 3) continue;
      const t = text(el);
      if (t.length > 60) continue;
      const m = t.match(AMOUNT);
      if (m && plausiblePrice(m[0])) return m[0];
    }
    // innerText is undefined when the page has not laid out yet (and in
    // jsdom), so fall back to textContent rather than throwing.
    const body = document.body?.innerText ?? document.body?.textContent ?? '';
    const all = body.match(new RegExp(CURRENCY + String.raw`\s*[\d,]+(?:\.\d{1,2})?`, 'g')) ?? [];
    return all.find(plausiblePrice) ?? '';
  })();

  const priceNumber = (() => {
    // First currency-prefixed amount only.
    const m = priceText.replace(/,/g, '').match(
      new RegExp(CURRENCY + String.raw`\s*([\d]+(?:\.\d{1,2})?)`));
    if (!m) return null;

    if (!plausiblePrice(m[0])) return null;

    const n = parseFloat(m[1]);
    // Nothing sold on these sites costs a hundred million or zero.
    if (!Number.isFinite(n) || n <= 0 || n > 1_000_000) return null;
    return n;
  })();

  const priceCurrency = (() => {
    const m = priceText.match(new RegExp(CURRENCY));
    return m ? m[0].trim() : null;
  })();

  // ---------------------------------------------------------------- options
  // Option groups are usually a label followed by a row of swatches/buttons.
  // Verified against a real AliExpress page. Class names carry a build hash
  // (sku-item--title--Z0HLO87), so match the stable prefix only.
  //
  // Structure there is:
  //   .sku-item--property   > .sku-item--title  "Color: SK-40A"
  //                         > [data-sku-col]    > img[alt="SK-40A"]
  const options = [];
  for (const group of document.querySelectorAll(
    '[class*="sku-item--property"], [class*="SkuProperty"], [class*="sku-property"], [class*="sku-item--wrap"]')) {

    // The title holds "Label: currently selected value" — keep the label.
    const rawTitle = text(group.querySelector(
      '[class*="sku-item--title"], [class*="title"], [class*="label"], dt'));
    const name = rawTitle.split(':')[0].trim();

    const cells = [...group.querySelectorAll(
      '[data-sku-col], [class*="sku-property-item"], li, button, [role="option"]')];

    const values = uniq(cells
      .map((el) => el.querySelector('img')?.getAttribute('alt')
        || el.getAttribute('title')
        || text(el))
      .map((v) => (v ?? '').trim())
      .filter((v) => v && v.length < 60));

    if (name && values.length > 1 && !options.some((o) => o.name === name)) {
      options.push({ name, values });
    }
  }

  // Generic fallback: a heading followed by a row of short-labelled buttons.
  // This is how Temu renders "Compatible Model", and it carries no sku-*
  // class names at all.
  if (options.length === 0) {
    const seenGroup = new Set();
    for (const btn of document.querySelectorAll('button, [role="button"], [role="radio"]')) {
      const parent = btn.parentElement;
      if (!parent || seenGroup.has(parent)) continue;

      const sibs = [...parent.children];
      if (sibs.length < 3) continue;

      const labels = sibs.map(text)
        .map((t) => t.replace(/\s*(HOT|NEW|SALE)\s*$/i, '').trim())
        .filter((t) => t && t.length <= 40);

      // A real option row is mostly short labels, all distinct.
      if (labels.length < 3 || labels.length < sibs.length * 0.7) continue;
      if (new Set(labels).size !== labels.length) continue;

      // Reject page furniture that happens to be a row of buttons: cart
      // summaries, seller badges, nav. A wrong option becomes a real variant
      // in the catalog, so no options beats bad ones.
      const JUNK = /subtotal|checkout|go to cart|select all|free shipping|follow|sold|star seller|sign in|add to|wish|review|share|store|coupon|\$|%|^\d+$/i;
      if (labels.some((l) => JUNK.test(l))) continue;

      // Option values are terse ("iPhone 15 Pro", "Black"). A long average
      // means this is prose, not a picker.
      const avg = labels.reduce((n, l) => n + l.length, 0) / labels.length;
      if (avg > 28) continue;

      seenGroup.add(parent);

      // The name is usually the text immediately above the row.
      let name = text(parent.previousElementSibling);
      if (!name || name.length > 40) name = text(parent.parentElement?.previousElementSibling);
      name = (name ?? '').replace(/:$/, '').trim();

      // Without a real heading this is probably not an option group at all.
      // Guessing a name here is how cart UI ends up as a product option.
      if (!name || name.length > 40 || /\d{3,}|\$/.test(name)) continue;

      if (!options.some((o) => o.name === name)) {
        options.push({ name, values: uniq(labels) });
      }
      if (options.length >= 4) break;
    }
  }

  // ----------------------------------------------------------------- images
  // The gallery plus any swatch thumbnails, which are usually the per-variant
  // images. Swatches are recorded with the value they sit next to so the
  // editor can map image -> variant.
  /** Lazy-loaded images keep the real URL in data-src or srcset. */
  const imgSrc = (img) => {
    const direct = img.currentSrc || img.src;
    if (direct && !/^data:/.test(direct)) return direct;
    const lazy = img.getAttribute('data-src') || img.getAttribute('data-original');
    if (lazy) return lazy;
    const set = img.getAttribute('srcset');
    if (set) return set.split(',').pop().trim().split(/\s+/)[0];
    return direct;
  };

  let gallery = uniq([...document.querySelectorAll(
    '[class*="gallery"] img, [class*="slider"] img, [class*="image-view"] img, main img')]
    .map((img) => fullSize(imgSrc(img)))
    .filter(looksLikeProductImage));

  // Nothing matched the gallery containers: fall back to the largest images
  // on the page, which are the product shots on most layouts.
  if (gallery.length === 0) {
    gallery = uniq([...document.querySelectorAll('img')]
      .filter((img) => (img.naturalWidth || img.width || 0) >= 100)
      .map((img) => fullSize(imgSrc(img)))
      .filter(looksLikeProductImage));
  }

  // Per-variant images. On AliExpress the option value is the img alt, which
  // is what lets the editor map image -> variant.
  const swatches = [];
  for (const el of document.querySelectorAll(
    '[data-sku-col] img, [class*="sku-item--image"] img, [class*="sku-property-image"] img, [class*="sku-item"] img')) {
    const src = fullSize(el.currentSrc || el.src);
    if (!looksLikeProductImage(src)) continue;

    const holder = el.closest('[data-sku-col], [title], li, button, [role="option"]');
    const value = el.getAttribute('alt') || holder?.getAttribute('title') || '';
    if (!swatches.some((s) => s.src === src)) {
      swatches.push({ src, value: value.trim() });
    }
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
    priceCurrency,
    options,
    specs,
    gallery: gallery.slice(0, 12),
    swatches: swatches.slice(0, 40),
    sourceUrl: location.href.split('?')[0],
    host: location.host,
  };
})();
