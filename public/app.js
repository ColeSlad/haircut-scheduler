import { $, esc, imageEvents, api } from './shared.js';
import { home, galleryPage } from './pages.js';
import { mountScheduler, mountConfirmation } from './booking.js';
import { mountAdmin } from './admin.js';
import { mountReviews } from './reviews.js';
let data;
let routeId = 0;
const app = $('#app');

function header(path) {
  return `<header class="site-header section-shell">
    <a class="site-brand" href="/" aria-label="${esc(data.settings.name)} home"><img class="site-logo" src="/assets/l2cuts-logo.png" alt="L2 Cuts" width="88" height="88" fetchpriority="high" decoding="async"></a>
    <nav class="site-nav" aria-label="Main navigation">
      <a href="/" ${path === '/' ? 'aria-current="page"' : ''}>Home</a>
      <a href="/schedule" ${path === '/schedule' ? 'aria-current="page"' : ''}>Book a cut</a>
      <a href="/gallery" ${path === '/gallery' ? 'aria-current="page"' : ''}>Gallery</a>
      <a href="/reviews" ${path === '/reviews' ? 'aria-current="page"' : ''}>Reviews</a>
    </nav>
  </header>`;
}
function footer() {
  return `<footer class="site-footer section-shell">
    <span>© ${new Date().getFullYear()} ${esc(data.settings.name)}</span>
    <div>${data.settings.email ? `<a href="mailto:${esc(data.settings.email)}">Contact</a>` : ''}${data.settings.instagram ? `<a href="${esc(data.settings.instagram)}" target="_blank" rel="noreferrer">Instagram</a>` : ''}<a href="/privacy">Privacy Policy</a><a href="/terms">Terms &amp; Conditions</a><a href="/admin">Admin login</a></div>
  </footer>`;
}
export async function refreshData() { data = await api('/api/public'); return data; }
export function navigate(path) { history.pushState({}, '', path); render(); window.scrollTo({ top: 0, behavior: 'instant' }); }
async function render() {
  const id = ++routeId;
  try {
    if (!data) await refreshData();
    if (id !== routeId) return;
    const path = location.pathname;
    document.title = `${({ '/': data.settings.tagline, '/schedule': 'Book a haircut', '/gallery': 'Gallery', '/reviews': 'Reviews', '/admin': 'Admin', '/booking': 'Appointment' })[path] || 'Welcome'} — ${data.settings.name}`;
    let robots = $('meta[name="robots"]');
    if (!robots) { robots = document.createElement('meta'); robots.name = 'robots'; document.head.append(robots); }
    robots.content = ['/admin', '/booking'].includes(path) ? 'noindex, nofollow' : 'index, follow';
    app.innerHTML = `${header(path)}<main id="main" tabindex="-1">${path === '/' ? home(data) : path === '/gallery' ? galleryPage(data) : ''}</main>${footer()}`;
    if (path === '/schedule') mountScheduler(data, navigate);
    if (path === '/booking') await mountConfirmation(data, navigate);
    if (path === '/reviews') await mountReviews(data, { refreshData });
    if (path === '/admin') await mountAdmin(data, { navigate, refreshData });
    imageEvents();
  } catch (error) {
    app.innerHTML = `<main id="main" class="centered-state section-shell"><h1>Unable to load the page</h1><p>${esc(error.message)}</p><button class="button primary" id="retry-page">Try again</button></main>`;
    $('#retry-page').addEventListener('click', render);
  }
}
document.addEventListener('click', (event) => {
  const link = event.target.closest('a');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target || link.download) return;
  const url = new URL(link.href);
  if (url.origin !== location.origin || !['/', '/schedule', '/gallery', '/reviews', '/admin', '/booking'].includes(url.pathname)) return;
  if (url.hash && url.pathname !== '/booking') return;
  event.preventDefault(); navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', render);
render();
