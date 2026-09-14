# Product Capture extension

Captures a product from a supplier page **you have open**, saving its details
and images to your local catalog editor for review.

## Install (Chrome / Edge / Brave)

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this `extension/` folder

## Use

1. Start the editor: `npm run admin`
2. Open a supplier product page
3. Click the extension icon
4. Review the title, price and images — deselect anything you do not want
5. **Save to catalog**
6. In the editor, open the **Captured** tab and *Add to catalog*

The editor builds the full cross-product of the options it found, so every
combination gets a row where you set price, stock and image. Images the
extension recognised as belonging to an option value are pre-assigned.

## What it does and does not do

- Runs **only** on the tab where you clicked the icon (`activeTab`). It does
  not crawl, follow links, or run in the background.
- Saves to `127.0.0.1:4321` only. Nothing is published.
- Records each image's source URL in `data/captured.json`, so if a takedown
  ever arrives you can find and replace the image quickly.

## A caution

Product photos belong to the supplier or manufacturer, and marketplace terms
generally prohibit automated extraction. Republishing them on your own
storefront carries real exposure — DMCA notices against your GitHub Pages
site, among others. This tool keeps you in the loop rather than doing it
automatically, but the decision to publish any given image is yours.

Replacing supplier photos with your own once stock arrives removes the risk
entirely.

## When a page stops working

Marketplaces change their markup often. `extract.js` uses best-guess selectors
with generic fallbacks; if a page yields nothing, the popup says so rather
than capturing junk. Fix the selectors in `extract.js`, or enter the product
by hand in the editor.
