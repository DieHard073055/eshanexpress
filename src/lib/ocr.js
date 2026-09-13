/**
 * Receipt OCR — advisory only.
 *
 * Tesseract on a photographed receipt is unreliable (glare, angle, thermal
 * paper). This exists to PRE-FILL the reference field so the customer types
 * less; the field stays editable, and the bank statement remains the source
 * of truth during reconciliation. Never gate anything on this output.
 *
 * Loaded lazily from a CDN so the ~2MB of WASM never touches first paint.
 */

const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';

let loading = null;

function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = CDN;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => reject(new Error('Could not load the text reader.'));
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Candidate reference strings, best first.
 *
 * Tuned for the local bank's formats seen in real statements:
 *   FT26230F30WR   transaction reference
 *   BLAZ719464188834  transfer id
 * Falls back to any long alphanumeric run.
 */
export function extractReferences(text) {
  const clean = text.replace(/[|]/g, 'I').toUpperCase();
  const found = new Map(); // value -> score

  const add = (v, score) => {
    if (!v || v.length < 6) return;
    found.set(v, Math.max(found.get(v) ?? 0, score));
  };

  // Strongest: the bank's own prefixed formats. BLAZ + 12 digits is what the
  // BML app prints on its transfer receipts; the wider range is a safety net
  // for OCR dropping or doubling a digit.
  for (const m of clean.matchAll(/\bBLAZ\d{12}\b/g)) add(m[0], 100);
  for (const m of clean.matchAll(/\bFT[A-Z0-9]{8,14}\b/g)) add(m[0], 98);
  for (const m of clean.matchAll(/\bBLAZ\d{10,16}\b/g)) add(m[0], 95);

  // A labelled reference line. The label alternatives are ordered longest
  // first so "REFERENCE" cannot match as "REF" and leave "ERENCE" behind.
  for (const m of clean.matchAll(
    /\b(?:REFERENCE|TRANSACTION|REF|TXN)\b\s*(?:NO\.?|NUMBER|#)?\s*:?\s*([A-Z0-9][A-Z0-9\-\/]{5,23})\b/g,
  )) {
    add(m[1], 80);
  }

  // Generic long alphanumeric runs containing at least one digit.
  for (const m of clean.matchAll(/\b(?=[A-Z0-9]*\d)[A-Z0-9]{8,24}\b/g)) add(m[0], 40);

  return [...found.entries()]
    .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)
    .map(([value, score]) => ({ value, confident: score >= 80 }));
}

/**
 * Detect a one-time password visible in the image.
 *
 * Real BML receipts are screenshots, and the notification shade often still
 * shows the OTP SMS ("Your One Time Password is NNNNNN"). Uploading that
 * hands a live credential to anyone who can read the receipt, so we warn the
 * customer and offer to crop before upload.
 */
export function detectsOtp(text) {
  const t = text.toUpperCase();
  return /ONE\s*TIME\s*PASSWORD|OTP\s*IS|\bOTP\b.*\d{4,8}/.test(t);
}

/** Vertical fraction of the image the notification banner occupies. */
export const BANNER_FRACTION = 0.18;

/**
 * Read a receipt image.
 * Resolves to { text, candidates, best } — never throws for a bad scan,
 * only for an infrastructure failure the caller should report.
 */
export async function readReceipt(file, onProgress) {
  const Tesseract = await loadTesseract();

  // Dark-mode screenshots are light-on-dark, which Tesseract reads poorly.
  // Invert when the image is predominantly dark, then OCR both and keep
  // whichever yields a confident reference.
  const prepared = await maybeInvert(file);

  const run = async (input) => {
    const { data } = await Tesseract.recognize(input, 'eng', {
      logger: (m) => {
        if (m.status === 'recognizing text' && onProgress) onProgress(m.progress);
      },
    });
    return data;
  };

  let data = await run(prepared.image);
  let candidates = extractReferences(data.text ?? '');

  // If inversion was applied but found nothing confident, try the original.
  if (prepared.inverted && !candidates.some((c) => c.confident)) {
    const alt = await run(file);
    const altCandidates = extractReferences(alt.text ?? '');
    if (altCandidates.some((c) => c.confident)) {
      data = alt;
      candidates = altCandidates;
    }
  }

  return {
    text: data.text ?? '',
    candidates,
    best: candidates[0]?.value ?? '',
    confidence: data.confidence ?? 0,
    hasOtp: detectsOtp(data.text ?? ''),
  };
}

/** Invert a predominantly dark image so Tesseract sees dark-on-light. */
async function maybeInvert(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return { image: file, inverted: false };

  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);

  // Sample a grid rather than every pixel — enough to judge overall lightness.
  const { data: px } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let sum = 0;
  let n = 0;
  for (let i = 0; i < px.length; i += 4 * 97) {
    sum += (px[i] + px[i + 1] + px[i + 2]) / 3;
    n++;
  }
  const mean = sum / Math.max(n, 1);
  if (mean >= 110) {
    bitmap.close?.();
    return { image: file, inverted: false };
  }

  for (let i = 0; i < px.length; i += 4) {
    px[i] = 255 - px[i];
    px[i + 1] = 255 - px[i + 1];
    px[i + 2] = 255 - px[i + 2];
  }
  ctx.putImageData(new ImageData(px, canvas.width, canvas.height), 0, 0);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return { image: blob ?? file, inverted: true };
}

/** Crop the top banner strip off an image, returning a new File. */
export async function cropTopBanner(file, fraction = BANNER_FRACTION) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const cut = Math.round(bitmap.height * fraction);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height - cut;
  canvas.getContext('2d').drawImage(
    bitmap, 0, cut, bitmap.width, canvas.height, 0, 0, bitmap.width, canvas.height,
  );
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
  if (!blob) return file;
  return new File([blob], file.name.replace(/\.\w+$/, '') + '-cropped.jpg', { type: 'image/jpeg' });
}

/**
 * Downscale before upload. Storage is the binding free-tier limit (1 GB),
 * and a modern phone photo is 3-8 MB; this targets roughly 150 KB while
 * keeping text legible enough for both OCR and human review.
 */
export async function downscaleImage(file, maxDim = 1600, quality = 0.82) {
  if (!file.type.startsWith('image/')) return file; // PDFs pass through

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return file;

  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size < 400_000) return file; // already small enough

  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();

  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
  if (!blob || blob.size >= file.size) return file; // never make it bigger

  return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
}
