import './styles.css';
import { route, setNotFound, start, navigate } from './lib/router.js';
import { mountChrome, setView, errorView } from './components/layout.js';
import { listingPage } from './pages/listing.js';
import { productPage } from './pages/product.js';
import { cartPage } from './pages/cart.js';

mountChrome((q) => {
  navigate(q ? `/?q=${encodeURIComponent(q)}` : '/');
  // Same-route search needs an explicit re-render: the hash may not change.
  if (location.hash.startsWith('#/?q=') || location.hash === '#/') listingPage({}, { q });
});

route('/', listingPage);
route('/product/:sku', productPage);
route('/cart', cartPage);

setNotFound(() => setView(errorView('That page does not exist.')));

start();
