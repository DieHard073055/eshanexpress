/**
 * Hash router.
 *
 * Hash routing (not history API) is deliberate: GitHub Pages serves 404 for
 * unknown paths, so /product/EX-1001 would break on refresh or direct link.
 * Hash routes always resolve to index.html.
 */

const routes = [];
let notFound = () => {};

export function route(pattern, handler) {
  const names = [];
  const regex = new RegExp(
    '^' + pattern.replace(/:(\w+)/g, (_, n) => (names.push(n), '([^/]+)')) + '$',
  );
  routes.push({ regex, names, handler });
}

export function setNotFound(fn) {
  notFound = fn;
}

export function currentPath() {
  return (location.hash.slice(1) || '/').split('?')[0];
}

export function currentQuery() {
  const q = location.hash.slice(1).split('?')[1] ?? '';
  return Object.fromEntries(new URLSearchParams(q));
}

export function navigate(path, { replace = false } = {}) {
  if (replace) location.replace(`#${path}`);
  else location.hash = path;
}

export function resolve() {
  const path = currentPath();
  for (const { regex, names, handler } of routes) {
    const m = regex.exec(path);
    if (m) {
      const params = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
      return handler(params, currentQuery());
    }
  }
  return notFound();
}

export function start() {
  addEventListener('hashchange', () => {
    resolve();
    // Restore top-of-page on navigation, as a real page load would.
    scrollTo({ top: 0 });
  });
  resolve();
}
