import './styles.css';
import { route, setNotFound, start, navigate } from './lib/router.js';
import { mountChrome, setView, errorView, refreshAuthUi } from './components/layout.js';
import { listingPage } from './pages/listing.js';
import { productPage } from './pages/product.js';
import { cartPage } from './pages/cart.js';
import { checkoutPage } from './pages/checkout.js';
import { orderPage, ordersPage } from './pages/order.js';
import { signInPage, signUpPage, forgotPage, accountPage } from './pages/account.js';
import { storePage, storeProductsPage, storeProfilePage } from './pages/store.js';
import { storefrontPage } from './pages/storefront.js';
import { termsPage, privacyPage, returnsPage } from './pages/legal.js';
import { initAuth, onAuthChange } from './lib/auth.js';

mountChrome((q) => {
  navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  if (location.hash.startsWith('#/?q=') || location.hash === '#/') listingPage({}, { q });
});

route('/', listingPage);
route('/product/:sku', productPage);
route('/cart', cartPage);
route('/checkout', checkoutPage);
route('/orders', ordersPage);
route('/order/:id', orderPage);
route('/signin', signInPage);
route('/signup', signUpPage);
route('/forgot', forgotPage);
route('/account', accountPage);
route('/store', storePage);
route('/store/products', storeProductsPage);
// Owner pages — registered BEFORE /store/:slug so first-match routing never
// treats "products" or "profile" as a store slug.
route('/store/profile', storeProfilePage);
// Public per-store page — registered AFTER the static /store routes above so
// the router (first-match, registration order) never treats "products" as a slug.
route('/store/:slug', storefrontPage);
route('/terms', termsPage);
route('/privacy', privacyPage);
route('/returns', returnsPage);

setNotFound(() => setView(errorView('That page does not exist.')));

// Resolve the session before the first render so the header does not flash
// from signed-out to signed-in. Wrapped rather than top-level await, which
// older browser targets do not support.
(async () => {
  onAuthChange(refreshAuthUi);
  await initAuth();
  refreshAuthUi();
  start();
})();
