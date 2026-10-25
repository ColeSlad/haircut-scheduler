import { $, $$, esc, money, timeLabel, dateLabel, todayIn, addDays, api, arrow, chevron, smallIcon, toast, loadingButton, fieldError } from './shared.js';

export function mountScheduler(data, navigate) {
  const root = $('#main');
  if (!data.services.length) { root.innerHTML = '<section class="section-shell centered-state"><h1>Booking unavailable</h1><p>Please contact the studio to book a haircut.</p></section>'; return; }
  const today = todayIn(data.settings.timezone);
  const last = addDays(today, data.settings.bookingDays);
  const state = { step: 1, service: data.services[0], date: '', time: '', slots: [], loading: false, month: today.slice(0, 7), details: {}, request: 0 };
  function summary() {
    return `<aside class="booking-summary"><h2>Appointment summary</h2><div class="summary-service"><strong>${esc(state.service?.name || 'Haircut')}</strong><p>${state.service?.duration || 0} minutes · ${money(state.service?.price || 0)}</p></div><p class="summary-line">${state.date ? dateLabel(state.date, { weekday: 'short', month: 'short' }) : 'Date not selected'}</p><p class="summary-line">${state.time ? timeLabel(state.time) : 'Time not selected'}</p><p class="summary-line">${esc(data.settings.location)}</p><div class="summary-total"><span>Total</span><strong>${money(state.service?.price || 0)}</strong></div><p class="fine-print">Pay online to confirm. Refunds are handled by the barber.<br>All times in ${esc(data.settings.timezone.replaceAll('_', ' '))}.</p></aside>`;
  }
  function calendar() {
    const [year, month] = state.month.split('-').map(Number);
    const first = new Date(year, month - 1, 1).getDay();
    const days = new Date(year, month, 0).getDate();
    const title = new Date(year, month - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    return `<div class="calendar"><div class="calendar-heading"><h3>${title}</h3><div><button class="icon-button prev" aria-label="Previous month" data-month="-1" ${state.month <= today.slice(0, 7) ? 'disabled' : ''}>${chevron}</button><button class="icon-button" aria-label="Next month" data-month="1" ${state.month >= last.slice(0, 7) ? 'disabled' : ''}>${chevron}</button></div></div><div class="calendar-grid"><span class="weekday">Su</span><span class="weekday">Mo</span><span class="weekday">Tu</span><span class="weekday">We</span><span class="weekday">Th</span><span class="weekday">Fr</span><span class="weekday">Sa</span>${'<span></span>'.repeat(first)}${Array.from({ length: days }, (_, i) => {
      const date = `${state.month}-${String(i + 1).padStart(2, '0')}`;
      const day = new Date(`${date}T12:00:00`).getDay();
      const disabled = date < today || date > last || !data.hours.find((h) => h.day === day)?.enabled;
      return `<button class="calendar-day ${date === state.date ? 'selected' : ''} ${date === today ? 'today' : ''}" data-date="${date}" aria-label="${dateLabel(date)}" aria-pressed="${date === state.date}" ${disabled ? 'disabled' : ''}>${i + 1}</button>`;
    }).join('')}</div></div>`;
  }
  function slots() {
    if (!state.date) return `<div class="times-empty"><p>Select a date to see available times.</p></div>`;
    if (state.loading) return '<div class="times-empty" role="status"><p>Loading available times…</p></div>';
    if (state.slotError) return `<div class="times-empty"><p>${esc(state.slotError)}</p><button class="text-link" data-retry>Try again ${arrow}</button></div>`;
    if (!state.slots.length) return `<div class="times-empty"><p>No available times. Choose another date.</p></div>`;
    return `<div class="time-grid">${state.slots.map((slot) => `<button class="time-slot ${state.time === slot.time ? 'selected' : ''}" data-time="${slot.time}" aria-pressed="${state.time === slot.time}">${timeLabel(slot.time)}</button>`).join('')}</div>`;
  }
  function render() {
    root.innerHTML = `<section class="section-shell booking-intro"><h1>Book a cut</h1><p>Choose a date and time. No account required.</p></section><section class="section-shell booking-layout"><div class="booking-main"><ol class="booking-steps" aria-label="Booking progress">${['Date & time', 'Details'].map((label, i) => `<li class="${state.step === i + 1 ? 'current' : ''} ${state.step > i + 1 ? 'done' : ''}" ${state.step === i + 1 ? 'aria-current="step"' : ''}><span>${state.step > i + 1 ? '✓' : i + 1}</span>${label}</li>`).join('')}</ol><div id="booking-step"><h2 class="step-title" tabindex="-1">${['Choose a date and time', 'Your details'][state.step - 1]}</h2>${state.step === 1 ? `<p class="step-description">Your appointment is ${state.service.duration} minutes. All times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}.</p><div class="date-time-layout">${calendar()}<div class="available-times"><h3>${state.date ? dateLabel(state.date, { weekday: 'short', month: 'short' }) : 'Available times'}</h3><div id="time-options" aria-live="polite">${slots()}</div></div></div><div class="booking-actions"><a class="text-link" href="/">← Home</a><button class="button primary" data-next ${!state.time ? 'disabled' : ''}>Continue</button></div>` : `<p class="step-description">Enter your contact information.</p><form id="details-form"><div class="form-grid"><label class="full">First name<input name="firstName" autocomplete="given-name" maxlength="50" required value="${esc(state.details.firstName || '')}" placeholder="First name"></label><label class="full">Last name<input name="lastName" autocomplete="family-name" maxlength="50" required value="${esc(state.details.lastName || '')}" placeholder="Last name"></label><label class="full">Phone number<input name="phone" type="tel" autocomplete="tel" maxlength="40" required value="${esc(state.details.phone || '')}" placeholder="(555) 000-0000"></label><label class="honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label></div><div class="booking-policy">${smallIcon('calendar')}<p>${esc(data.settings.bookingNotice)}</p></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><div class="booking-actions"><button class="text-link" type="button" data-back>← Back</button><button class="button primary" type="submit">Continue to payment</button></div><p class="privacy-note">${smallIcon('lock')} Payment is handled by Stripe. Cancelling does not automatically issue a refund.</p></form>`}</div></div>${summary()}</section>`;
    bind();
  }
  async function loadSlots() {
    const request = ++state.request;
    state.loading = true; state.time = ''; state.slotError = '';
    render();
    try {
      const result = await api(`/api/availability?date=${state.date}`);
      if (request !== state.request || location.pathname !== '/schedule') return;
      state.slots = result.slots;
    } catch (error) { if (request !== state.request) return; state.slotError = error.message; }
    state.loading = false;
    if (location.pathname === '/schedule') render();
  }
  function bind() {
    $('[data-next]', root)?.addEventListener('click', () => { state.step++; render(); $('.step-title', root).focus(); });
    $('[data-back]', root)?.addEventListener('click', () => { state.step--; render(); $('.step-title', root).focus(); });
    $$('[data-month]', root).forEach((button) => button.addEventListener('click', () => { const [y, m] = state.month.split('-').map(Number); const date = new Date(Date.UTC(y, m - 1 + Number(button.dataset.month), 1)); state.month = date.toISOString().slice(0, 7); render(); }));
    $$('[data-date]', root).forEach((button) => button.addEventListener('click', () => { state.date = button.dataset.date; loadSlots(); }));
    $('[data-retry]', root)?.addEventListener('click', loadSlots);
    $$('[data-time]', root).forEach((button) => button.addEventListener('click', () => { state.time = button.dataset.time; render(); $(`[data-time="${state.time}"]`, root)?.focus(); }));
    const form = $('#details-form', root);
    form?.addEventListener('input', () => { state.details = Object.fromEntries(new FormData(form)); });
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const restore = loadingButton($('button[type="submit"]', form), 'Opening checkout…');
      $('[data-error]', form).hidden = true;
      try {
        const details = { ...Object.fromEntries(new FormData(form)), date: state.date, time: state.time };
        const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(details))))).map((byte) => byte.toString(16).padStart(2, '0')).join('');
        let saved;
        try { saved = JSON.parse(sessionStorage.getItem('haircut-checkout') || 'null'); } catch { /* Storage may be unavailable. */ }
        if (!saved || saved.fingerprint !== fingerprint) saved = { fingerprint, requestId: crypto.randomUUID() };
        try { sessionStorage.setItem('haircut-checkout', JSON.stringify(saved)); } catch { /* In-memory retries still work. */ }
        state.requestId = saved.requestId;
        const checkout = await api('/api/bookings', { method: 'POST', body: { ...details, requestId: state.requestId } });
        location.assign(checkout.checkoutUrl);
      } catch (error) {
        if (error.status === 409) { state.step = 1; await loadSlots(); toast(error.message); }
        else fieldError(form, error);
      } finally { restore(); }
    });
  }
  render();
}

let confirmationTimer;
export async function mountConfirmation(data, navigate, attempt = 0) {
  clearTimeout(confirmationTimer);
  const root = $('#main');
  const token = location.hash.slice(1);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) {
    root.innerHTML = '<section class="section-shell centered-state"><h1>Open your appointment link</h1><p>Use the complete private link saved after checkout, or contact the barber for help.</p><a class="button outline" href="/">Home</a></section>';
    return;
  }
  const headers = { Authorization: `Bearer ${token}` };
  root.innerHTML = '<div class="section-shell centered-state" role="status">Loading appointment…</div>';
  try {
    const booking = await api('/api/booking', { headers });
    if (location.pathname !== '/booking' || location.hash.slice(1) !== token) return;
    const pending = booking.status === 'pending';
    const ended = ['cancelled', 'expired'].includes(booking.status);
    const past = booking.startsAt <= Date.now();
    const title = pending ? 'Payment pending' : booking.status === 'expired' ? 'Checkout ended' : ended ? 'Appointment cancelled' : 'Your appointment';
    const payment = ({ paid: 'Paid', unpaid: 'Awaiting payment', refunded: 'Refunded', partially_refunded: 'Partially refunded', legacy_unpaid: 'Payment not recorded' })[booking.paymentStatus];
    root.innerHTML = `<section class="confirmation section-shell"><div class="confirmation-heading"><h1>${!pending && !ended && !past ? 'Appointment confirmed' : title}</h1><p>${pending ? 'Your appointment is confirmed after payment. If you just paid, checking may take a moment.' : ended ? 'This time is no longer reserved.' : `Appointment for ${esc(booking.name)}.`}</p></div>
      <div class="confirmation-card"><div class="confirmation-card-top"><h2>${esc(booking.serviceName)}</h2><span class="status-badge ${ended ? 'cancelled' : ''}">${esc(booking.status)}</span></div>
      <div class="confirmation-grid"><div>${smallIcon('calendar')}<span>Date<strong>${dateLabel(booking.date)}</strong></span></div><div>${smallIcon('clock')}<span>Time<strong>${timeLabel(booking.time)} · ${booking.duration} min</strong></span></div><div><span class="dollar-icon">$</span><span>Price<strong>${money(booking.price)}</strong></span></div><div><span>Payment<strong>${esc(payment || '')}</strong>${booking.amountRefunded ? `<small>${money(booking.amountRefunded)} refunded</small>` : ''}</span></div></div>
      <p class="fine-print">${esc(booking.timezone.replaceAll('_', ' '))} · ${esc(data.settings.bookingNotice)}</p>
      ${pending ? `<div class="booking-actions">${booking.checkoutUrl ? `<a class="button primary" href="${esc(booking.checkoutUrl)}">Continue payment</a>` : ''}<button class="button outline" id="refresh-payment">Check payment</button></div>` : ''}
      ${!ended && !pending && !past && booking.status === 'confirmed' ? '<button class="button outline full-width" id="add-calendar">Add to my calendar</button>' : ''}</div>
      ${!ended ? `<div class="save-link"><h3>Save your appointment link</h3><p>Stripe sends a payment receipt. Save this private link to view or cancel your appointment. Anyone with the link can manage it.</p><div class="copy-row"><input id="booking-link" aria-label="Private appointment link" readonly value="${esc(location.href)}"><button class="button primary" id="copy-link">Copy link</button></div></div>` : ''}
      <p class="fine-print">Refunds are handled by the barber. Cancelling does not automatically issue a refund.</p>
      <div class="confirmation-actions"><a class="text-link" href="/">Home</a>${!ended && !past && ['pending', 'confirmed'].includes(booking.status) ? `<button class="subtle-button danger" id="cancel-booking">${pending ? 'Cancel checkout' : 'Cancel appointment'}</button>` : '<a class="button primary" href="/schedule">Book a haircut</a>'}</div></section>
      <dialog id="cancel-dialog"><form method="dialog"><button class="dialog-close" aria-label="Close">×</button><h2>${pending ? 'Cancel checkout?' : 'Cancel your appointment?'}</h2><p>This will release your time. Refunds are handled separately by the barber.</p><p data-error class="form-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" value="keep">Keep appointment</button><button class="button danger-button" id="confirm-cancel" type="button">Yes, cancel</button></div></form></dialog>`;
    $('#copy-link')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Link copied.'); } catch { $('#booking-link').select(); }
    });
    $('#add-calendar')?.addEventListener('click', () => {
      const stamp = (timestamp) => new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const safe = (text) => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&');
      const content = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haircut Scheduler//EN', 'BEGIN:VEVENT', `UID:${booking.id}@haircut-scheduler`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(booking.startsAt)}`, `DTEND:${stamp(booking.endsAt)}`, `SUMMARY:${safe(`${booking.serviceName} at ${data.settings.name}`)}`, `LOCATION:${safe(data.settings.address || data.settings.location)}`, `DESCRIPTION:${safe(`Manage this appointment: ${location.href}`)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
      const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar' }));
      const link = document.createElement('a'); link.href = url; link.download = 'my-haircut.ics'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const reload = () => mountConfirmation(data, navigate, attempt + 1);
    $('#refresh-payment')?.addEventListener('click', reload);
    const dialog = $('#cancel-dialog');
    $('#cancel-booking')?.addEventListener('click', () => dialog.showModal());
    $('#confirm-cancel')?.addEventListener('click', async (event) => {
      const restore = loadingButton(event.currentTarget, 'Cancelling…');
      try { await api('/api/booking', { method: 'POST', headers, body: { action: 'cancel' } }); dialog.close(); navigate(location.pathname + location.hash); }
      catch (error) { fieldError(dialog, error); } finally { restore(); }
    });
    if (pending && attempt < 10) confirmationTimer = setTimeout(() => {
      if (location.pathname === '/booking' && location.hash.slice(1) === token && !dialog.open) reload();
    }, 6000);
  } catch (error) {
    root.innerHTML = `<section class="section-shell centered-state"><h1>Could not load appointment</h1><p>${esc(error.message)}</p><button class="button outline" id="retry-confirmation">Try again</button></section>`;
    $('#retry-confirmation').addEventListener('click', () => mountConfirmation(data, navigate));
  }
}
