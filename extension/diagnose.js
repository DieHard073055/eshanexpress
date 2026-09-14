/**
 * Diagnostic dump, run from the popup's "Copy page structure" button.
 *
 * Extraction selectors are guesswork until they are checked against a real,
 * JS-rendered page. This reports what a live tab actually contains so the
 * selectors can be written from evidence rather than assumption.
 *
 * It reports STRUCTURE — class names, counts, short text samples — not the
 * page's full content.
 */
(() => {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
  const short = (s, n = 60) => (s.length > n ? `${s.slice(0, n)}…` : s);

  /** Strip a build hash: "sku-item--title--Z0HLO87" -> "sku-item--title". */
  const stem = (cls) => String(cls ?? '')
    .split(/\s+/)
    .map((c) => c.replace(/--[A-Za-z0-9_]{5,}$/, '').replace(/_[A-Za-z0-9]{5,}$/, ''))
    .filter(Boolean)
    .join(' ');

  const out = { url: location.href.split('?')[0], host: location.host };

  // ------------------------------------------------------------------ price
  // Find every element whose own text is just a currency amount, then report
  // its class and ancestry so a stable selector can be chosen.
  const CURRENCY = /(?:S\$|SGD|MVR|Rf\.?|US\s*\$|USD|A\$|₹|£|€|\$)\s*[\d,]+(?:\.\d{1,2})?/;
  out.priceCandidates = [];
  for (const el of document.querySelectorAll('span, div, p, strong, b, h2, h3')) {
    if (el.children.length > 2) continue;            // want leaf-ish nodes
    const t = text(el);
    if (t.length > 40 || !CURRENCY.test(t)) continue;
    out.priceCandidates.push({
      text: short(t, 40),
      cls: short(stem(el.className), 70),
      parentCls: short(stem(el.parentElement?.className), 70),
      tag: el.tagName.toLowerCase(),
    });
    if (out.priceCandidates.length >= 12) break;
  }

  // ---------------------------------------------------------------- options
  // Option pickers are rows of small clickable elements with short labels.
  // Report groups of 3+ siblings that look like that.
  out.optionGroups = [];
  const seenParents = new Set();
  for (const el of document.querySelectorAll(
    'button, [role="button"], [role="option"], li, label, [class*="option"], [class*="sku"], [class*="spec"]')) {
    const parent = el.parentElement;
    if (!parent || seenParents.has(parent)) continue;

    const sibs = [...parent.children];
    if (sibs.length < 3) continue;

    const labels = sibs.map(text).filter((t) => t && t.length < 40);
    if (labels.length < 3) continue;

    seenParents.add(parent);
    out.optionGroups.push({
      count: sibs.length,
      parentCls: short(stem(parent.className), 70),
      childCls: short(stem(sibs[0].className), 70),
      childTag: sibs[0].tagName.toLowerCase(),
      labels: labels.slice(0, 6).map((l) => short(l, 24)),
      // What sits above the group is usually its name ("Compatible Model").
      headingAbove: short(text(parent.previousElementSibling), 40),
      hasImages: sibs.some((s) => s.querySelector('img')),
    });
    if (out.optionGroups.length >= 10) break;
  }

  // ----------------------------------------------------------------- images
  const imgs = [...document.querySelectorAll('img')];
  out.imageCount = imgs.length;
  out.imageSamples = [];
  const seenHosts = new Map();
  for (const img of imgs) {
    const src = img.currentSrc || img.src || img.getAttribute('data-src') || '';
    if (!/^https?:/.test(src)) continue;
    let host;
    try { host = new URL(src).host; } catch { continue; }
    seenHosts.set(host, (seenHosts.get(host) ?? 0) + 1);
    if (out.imageSamples.length < 10) {
      out.imageSamples.push({
        host,
        path: short(new URL(src).pathname, 50),
        w: img.naturalWidth || img.width || 0,
        h: img.naturalHeight || img.height || 0,
        alt: short(img.getAttribute('alt') ?? '', 30),
        cls: short(stem(img.className), 50),
        parentCls: short(stem(img.parentElement?.className), 50),
      });
    }
  }
  out.imageHosts = [...seenHosts.entries()].map(([h, n]) => `${h} (${n})`);

  // Images can also be CSS backgrounds, which querySelectorAll('img') misses.
  out.backgroundImages = 0;
  for (const el of document.querySelectorAll('[style*="background-image"]')) {
    if (/url\(/.test(el.getAttribute('style') ?? '')) out.backgroundImages++;
  }

  // ------------------------------------------------------------------ title
  out.titleCandidates = [...document.querySelectorAll('h1, [class*="title"], [class*="Title"]')]
    .map((el) => ({ tag: el.tagName.toLowerCase(), cls: short(stem(el.className), 50), text: short(text(el), 50) }))
    .filter((t) => t.text)
    .slice(0, 6);

  return out;
})();
