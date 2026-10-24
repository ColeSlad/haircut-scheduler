import { $, $$, esc, money, timeLabel, dateLabel, todayIn, addDays, api, arrow, chevron, smallIcon, toast, loadingButton, fieldError } from './shared.js?v=2';

export function mountScheduler(data, navigate) {
  const root = $('#main');
  if (!data.services.length) { root.innerHTML = '<section class="section-shell centered-state"><h1>Booking unavailable</h1><p>Please contact the studio to book a haircut.</p></section>'; return; }
  const today = todayIn(data.settings.timezone);
  const last = addDays(today, data.settings.bookingDays);
  const state = { step: 1, service: data.services[0], date: '', time: '', slots: [], loading: false, month: today.slice(0, 7), details: {}, request: 0 };
  function summary() {
    return `<aside class="booking-summary"><h2>Appointment summary</h2><div class="summary-service"><strong>${esc(state.service?.name || 'Haircut')}</strong><p>${state.service?.duration || 0} minutes · ${money(state.service?.price || 0)}</p></div><p class="summary-line">${state.date ? dateLabel(state.date, { weekday: 'short', month: 'short' }) : 'Date not selected'}</p><p class="summary-line">${state.time ? timeLabel(state.time) : 'Time not selected'}</p><p class="summary-line">${esc(data.settings.location)}</p><div class="summary-total"><span>Total</span><strong>${money(state.service?.price || 0)}</strong></div><p class="fine-print">Pay at your appointment.<br>All times in ${esc(data.settings.timezone.replaceAll('_', ' '))}.</p></aside>`;
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
    root.innerHTML = `<section class="section-shell booking-intro"><h1>Book a cut</h1><p>Choose a date and time. No account required.</p></section><section class="section-shell booking-layout"><div class="booking-main"><ol class="booking-steps" aria-label="Booking progress">${['Date & time', 'Details'].map((label, i) => `<li class="${state.step === i + 1 ? 'current' : ''} ${state.step > i + 1 ? 'done' : ''}" ${state.step === i + 1 ? 'aria-current="step"' : ''}><span>${state.step > i + 1 ? '✓' : i + 1}</span>${label}</li>`).join('')}</ol><div id="booking-step"><h2 class="step-title" tabindex="-1">${['Choose a date and time', 'Your details'][state.step - 1]}</h2>${state.step === 1 ? `<p class="step-description">Your appointment is ${state.service.duration} minutes. All times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}.</p><div class="date-time-layout">${calendar()}<div class="available-times"><h3>${state.date ? dateLabel(state.date, { weekday: 'short', month: 'short' }) : 'Available times'}</h3><div id="time-options" aria-live="polite">${slots()}</div></div></div><div class="booking-actions"><a class="text-link" href="/">← Home</a><button class="button primary" data-next ${!state.time ? 'disabled' : ''}>Continue</button></div>` : `<p class="step-description">Enter your contact information.</p><form id="details-form"><div class="form-grid"><label class="full">First name<input name="firstName" autocomplete="given-name" maxlength="50" required value="${esc(state.details.firstName || '')}" placeholder="First name"></label><label class="full">Last name<input name="lastName" autocomplete="family-name" maxlength="50" required value="${esc(state.details.lastName || '')}" placeholder="Last name"></label><label class="full">Phone number<input name="phone" type="tel" autocomplete="tel" maxlength="40" required value="${esc(state.details.phone || '')}" placeholder="(555) 000-0000"></label><label class="honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label></div><div class="booking-policy">${smallIcon('calendar')}<p>${esc(data.settings.bookingNotice)}</p></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><div class="booking-actions"><button class="text-link" type="button" data-back>← Back</button><button class="button primary" type="submit">Book appointment</button></div><p class="privacy-note">${smallIcon('lock')} Your details are only shared with the studio.</p></form>`}</div></div>${summary()}</section>`;
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
      const restore = loadingButton($('button[type="submit"]', form), 'Booking…');
      $('[data-error]', form).hidden = true;
      try {
        const booking = await api('/api/bookings', { method: 'POST', body: { ...Object.fromEntries(new FormData(form)), date: state.date, time: state.time } });
        navigate(`/booking#${booking.token}`);
      } catch (error) {
        if (error.status === 409) { state.step = 1; await loadSlots(); toast(error.message); }
        else fieldError(form, error);
      } finally { restore(); }
    });
  }
  render();
}

export async function mountConfirmation(data, navigate) {
  const root = $('#main');
  const token = location.hash.slice(1);
  root.innerHTML = '<div class="section-shell centered-state" role="status">Loading appointment…</div>';
  try {
    const booking = await api(`/api/booking/${encodeURIComponent(token)}`);
    if (location.pathname !== '/booking' || location.hash.slice(1) !== token) return;
    const isCancelled = booking.status === 'cancelled';
    const past = booking.startsAt <= Date.now();
    root.innerHTML = `<section class="confirmation section-shell"><div class="confirmation-heading"><h1>${isCancelled ? 'Appointment cancelled' : past ? 'Your appointment' : 'Appointment confirmed'}</h1><p>${isCancelled ? 'Your appointment has been cancelled.' : `Appointment for ${esc(booking.name)}.`}</p></div><div class="confirmation-card"><div class="confirmation-card-top"><div><p class="eyebrow">${esc(data.settings.name)}</p><h2>${esc(booking.serviceName)}</h2></div><span class="status-badge ${isCancelled ? 'cancelled' : ''}">${esc(booking.status)}</span></div><div class="confirmation-grid"><div>${smallIcon('calendar')}<span>Date<strong>${dateLabel(booking.date)}</strong></span></div><div>${smallIcon('clock')}<span>Time<strong>${timeLabel(booking.time)} · ${booking.duration} min</strong></span></div><div>${smallIcon('pin')}<span>Location<strong>${esc(data.settings.location)}</strong>${data.settings.address ? `<small>${esc(data.settings.address)}</small>` : ''}</span></div><div><span class="dollar-icon">$</span><span>Price<strong>${money(booking.price)}</strong></span></div></div><p class="fine-print">${esc(booking.timezone.replaceAll('_', ' '))} · ${esc(data.settings.bookingNotice)}</p>${!isCancelled && !past && booking.status === 'confirmed' ? `<button class="button outline full-width" id="add-calendar">${smallIcon('calendar')} Add to my calendar</button>` : ''}</div>${!isCancelled ? `<div class="save-link"><h3>Keep your appointment link.</h3><p>No automatic emails are sent. Save this private link to view or cancel your appointment. Anyone with the link can manage this booking.</p><div class="copy-row"><input id="booking-link" aria-label="Private appointment link" readonly value="${esc(location.href)}"><button class="button primary" id="copy-link">Copy link</button></div></div>` : ''}<div class="confirmation-actions"><a class="text-link" href="/">Back to home</a>${!isCancelled && !past && booking.status === 'confirmed' ? '<button class="subtle-button danger" id="cancel-booking">Cancel appointment</button>' : '<a class="button primary" href="/schedule">Book another appointment</a>'}</div></section><dialog id="cancel-dialog"><form method="dialog"><button class="dialog-close" aria-label="Close">×</button><h2>Cancel your appointment?</h2><p>This will release your time for someone else. You can always book a new appointment.</p><p data-error class="form-error" role="alert" hidden></p><div class="dialog-actions"><button class="button outline" value="keep">Keep appointment</button><button class="button danger-button" id="confirm-cancel" type="button">Yes, cancel it</button></div></form></dialog>`;
    $('#copy-link')?.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(location.href); toast('Your private link is copied. Keep it somewhere safe.'); } catch { $('#booking-link').select(); toast('Select and copy the link above.'); }
    });
    $('#add-calendar')?.addEventListener('click', () => {
      const stamp = (timestamp) => new Date(timestamp).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      const safe = (text) => text.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, '\\$&');
      const content = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Haircut Scheduler//EN', 'BEGIN:VEVENT', `UID:${booking.id}@haircut-scheduler`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(booking.startsAt)}`, `DTEND:${stamp(booking.endsAt)}`, `SUMMARY:${safe(`${booking.serviceName} at ${data.settings.name}`)}`, `LOCATION:${safe(data.settings.address || data.settings.location)}`, `DESCRIPTION:${safe(`Manage this appointment: ${location.href}`)}`, 'END:VEVENT', 'END:VCALENDAR', ''].join('\r\n');
      const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar' }));
      const link = document.createElement('a'); link.href = url; link.download = 'my-haircut.ics'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    const dialog = $('#cancel-dialog');
    $('#cancel-booking')?.addEventListener('click', () => dialog.showModal());
    $('#confirm-cancel')?.addEventListener('click', async (event) => {
      const restore = loadingButton(event.currentTarget, 'Cancelling…');
      try { await api(`/api/booking/${token}`, { method: 'POST', body: { action: 'cancel' } }); dialog.close(); navigate(location.pathname + location.hash); }
      catch (error) { fieldError(dialog, error); } finally { restore(); }
    });
  } catch (error) { root.innerHTML = `<section class="section-shell centered-state"><h1>Appointment not found</h1><p>${esc(error.message)}</p><p>Open the complete private link from your confirmation, or contact the studio.</p><a class="button primary" href="/schedule">Book an appointment ${arrow}</a></section>`; }
}
