import { setView, esc } from '../components/layout.js';

/**
 * Legal pages (#/terms, #/privacy, #/returns).
 *
 * These are DRAFTS for the owner to review before launch — each carries a
 * REVIEW BEFORE LAUNCH marker in its markup. They are static content with no
 * backend. Do not add a company registration number, physical address, or
 * regulator here without the owner's confirmation; bracketed placeholders
 * mark the spots that need one.
 */

const UPDATED = '15 September 2026';

function legalPage(title, marker, body) {
  setView(`
    <!-- ${marker} -->
    <article class="card mx-auto max-w-2xl px-5 py-8 sm:px-8">
      <h1 class="text-2xl font-semibold">${esc(title)}</h1>
      <p class="mt-1 text-sm text-neutral-500">Last updated: ${UPDATED}</p>
      <div class="mt-6 space-y-6 text-[15px] leading-relaxed text-neutral-700">
        ${body}
      </div>
    </article>`);
}

const h = (t) => `<h2 class="text-lg font-semibold text-neutral-900">${esc(t)}</h2>`;
const p = (t) => `<p>${t}</p>`;
const ul = (items) => `<ul class="list-disc space-y-1.5 pl-5">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

export function termsPage() {
  legalPage('Terms of Service', 'REVIEW BEFORE LAUNCH', `
    ${h('The marketplace')}
    ${p('EshanExpress is an online marketplace that connects buyers in the Maldives with independent stores. Product listings, prices, and stock levels are provided by the individual stores.')}
    ${h('Independent sellers')}
    ${p('Each store on EshanExpress is an independent seller. The store you buy from — not EshanExpress — is responsible for the products it lists, their quality, and fulfilling your order. Store names are shown on every product page.')}
    ${h('Orders and payment')}
    ${ul([
      'You place an order by bank transfer, then upload your payment receipt at checkout.',
      '<strong>An order is accepted only after your payment is verified against a bank statement.</strong> Uploading a receipt does not by itself confirm an order; confirmation follows verification.',
      'If your payment cannot be matched to your order, the order will be declined and you will be told why.',
    ])}
    ${h('Stock and pricing')}
    ${p('Stock shown on a product page is indicative until checkout, because the same items may be sold through other channels. If an item sells out before your payment is verified, you will be offered a refund rather than a partial order. Prices are shown in Maldivian Rufiyaa (MVR) and may change between visits.')}
    ${h('Preorders')}
    ${p('Items marked "Preorder" are sourced after you order. The listed lead time is an estimate, not a guarantee, and the maximum you may order per checkout is set per item.')}
    ${h('Acceptance')}
    ${p('By placing an order on EshanExpress you accept these terms and the terms of the store you are buying from.')}
  `);
}

export function privacyPage() {
  legalPage('Privacy Policy', 'REVIEW BEFORE LAUNCH', `
    ${h('What we collect')}
    ${ul([
      '<strong>Account:</strong> your email address and a password (stored only as a hash by our authentication provider).',
      '<strong>Orders:</strong> the contents of your order, the total, and the delivery details you give us at checkout.',
      '<strong>Payment receipts:</strong> the receipt image or PDF you upload as proof of bank transfer.',
    ])}
    ${h('Receipts and bank data')}
    ${ul([
      'Receipts are stored in Supabase Storage and are used only to match your transfer to your order.',
      'Receipts are deleted after your payment is reconciled against the bank statement and the retention period needed for record-keeping has passed.',
      'Receipt text is read by on-screen character recognition (OCR) <strong>in your browser</strong>. Receipt text is not sent to any third party for recognition.',
    ])}
    ${h('Your cart')}
    ${p('Your cart lives in your browser\'s <code>localStorage</code>. It is never sent to our servers — cart contents reach us only when you place an order at checkout.')}
    ${h('Who can see your data')}
    ${p('Order details are visible to you and to the store fulfilling your order. Administrative staff can access receipts and order records to verify payments and resolve disputes. We do not sell or share your personal data with advertisers.')}
    ${h('Requesting deletion')}
    ${p('You can ask us to delete your account and associated data at any time by contacting us through the support address shown on your order confirmation. We will delete your data within 30 days, except order records we must keep for tax and accounting purposes, which are retained as required by law. [REVIEW: confirm the support contact and any legal retention period before launch.]')}
  `);
}

export function returnsPage() {
  legalPage('Returns & Refunds', 'REVIEW BEFORE LAUNCH', `
    ${h('How refunds work')}
    ${p('Payment on EshanExpress is by bank transfer, so refunds are processed manually back to the same account you paid from. After a return is accepted, the store initiates the transfer; allow up to 7 days for it to reach your account. [REVIEW: confirm the refund SLA before launch.]')}
    ${h('Return window')}
    ${p('You may request a return within <strong>7 days of receiving your order</strong>. Contact the store through the details on your order confirmation to start a return. [REVIEW: confirm the window before launch.]')}
    ${h('Condition requirements')}
    ${ul([
      'Items must be unused, in their original packaging, with all accessories and tags included.',
      'Sealed items (such as earphones) cannot be returned once the seal is broken, unless they are faulty.',
      'The store may inspect the item before approving the return.',
    ])}
    ${h('Who pays return delivery')}
    ${ul([
      'For a change of mind, <strong>you pay</strong> the cost of returning the item to the store.',
      'If the item is faulty, not as described, or arrived damaged, <strong>the store pays</strong> — contact the store with photos before sending anything back.',
    ])}
    ${h('When refunds are not offered')}
    ${p('Preorders accepted against a stated lead time, items damaged through misuse, and sealed items with a broken seal (unless faulty) are not eligible for return. Orders that were never paid or could not be verified are declined rather than refunded.')}
  `);
}
