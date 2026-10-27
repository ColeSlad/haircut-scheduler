export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const esc = (value = '') => String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
export const money = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);
export const servicePrice = (service) => `${money(service.price)}${service.priceMax > service.price ? `–${money(service.priceMax)}` : ''}`;
export const timeLabel = (time) => { const [h, m] = time.split(':').map(Number); return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h >= 12 ? 'PM' : 'AM'}`; };
export const dateLabel = (date, options = {}) => new Intl.DateTimeFormat('en-US', { weekday: 'long', month: 'long', day: 'numeric', ...options }).format(new Date(`${date}T12:00:00`));
export const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const categories = ['Short cuts', 'Texture', 'Beards', 'Long cuts'];
export function todayIn(timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts().map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function addDays(date, amount) { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + amount); return d.toISOString().slice(0, 10); }
export async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json', ...options.headers }, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  let result;
  try { result = await response.json(); } catch { throw new Error('Could not connect. Please try again.'); }
  if (!response.ok) { const error = new Error(result.error || 'Something went wrong.'); error.status = response.status; throw error; }
  return result;
}
let toastTimer;
export function toast(message) { const el = $('#toast'); el.textContent = message; el.classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('visible'), 4500); }
export const arrow = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';
export const chevron = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7"/></svg>';
export const scissors = '<svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="35" r="6"/><circle cx="12" cy="13" r="6"/><path d="m17 31 24-23M17 17l24 23M22 24l-7-7"/></svg>';
export const spark = '<svg viewBox="0 0 64 64" fill="currentColor" aria-hidden="true"><path d="m32 0 5 23 20-14-14 20 21 3-21 5 14 20-20-14-5 21-5-21-20 14 14-20-21-5 23-3L9 9l20 14z"/></svg>';
export const icon = (name) => ({ clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/>', pin: '<path d="M19 10c0 5-7 11-7 11S5 15 5 10a7 7 0 1 1 14 0Z"/><circle cx="12" cy="10" r="2.5"/>', check: '<path d="m5 12 4 4L19 6"/>', calendar: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M7 3v4m10-4v4M3 11h18"/>', lock: '<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 4v3"/>', mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>' })[name];
export const smallIcon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icon(name) || ''}</svg>`;
export function imageEvents(root = document) { $$('img', root).forEach((img) => img.addEventListener('error', () => { img.src = '/assets/photo-fallback.svg'; }, { once: true })); }
export function fieldError(form, error) { const node = $('[data-error]', form); if (node) { node.textContent = error.message; node.hidden = false; node.focus(); } else toast(error.message); }
export function loadingButton(button, text) { const old = button.innerHTML; button.disabled = true; button.textContent = text; return () => { if (button.isConnected) { button.disabled = false; button.innerHTML = old; } }; }
