import { $, $$, esc, money, timeLabel, dateLabel, todayIn, dayNames, categories, api, arrow, smallIcon, toast, loadingButton, fieldError, imageEvents } from './shared.js?v=2';
import { galleryImage } from './pages.js?v=2';

export async function mountAdmin(publicData, { refreshData }) {
  const root = $('#main');
  let session = await api('/api/admin/session');
  if (location.pathname !== '/admin') return;
  let data;
  let tab = 'appointments';
  let filter = 'upcoming';
  let search = '';
  let editing = false;
  async function login() {
    root.innerHTML = `<section class="login-section section-shell"><a href="/" class="back-link">← Back to the studio</a><div class="login-card"><div class="summary-icon">${smallIcon('lock')}</div><p class="eyebrow">YOUR SPACE, BEHIND THE SCENES</p><h1>Hey, <span class="serif-word">good looking.</span></h1><p>Sign in to take care of the studio.</p>${!session.configured ? '<div class="setup-note"><strong>Let’s set up your admin account.</strong><p>In the project terminal, run <code>npm run admin:create</code>, then refresh this page. There is no default password.</p><button class="button outline" id="check-setup">I’ve created my account</button></div>' : `<form id="login-form"><label>Email address<input name="email" type="email" autocomplete="username" required maxlength="254" placeholder="you@example.com"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256" placeholder="Your password"></label><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary full-width" type="submit">Enter the studio ${arrow}</button></form><p class="fine-print">Forgot your password? Run <code>npm run admin:create</code> in the project terminal to reset it.</p>`}</div></section>`;
    $('#check-setup')?.addEventListener('click', async () => { try { session = await api('/api/admin/session'); if (session.configured) login(); else toast('Create your account in the terminal first.'); } catch (error) { toast(error.message); } });
    $('#login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const restore = loadingButton($('button[type="submit"]', form), 'Signing in…');
      try { await api('/api/admin/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); await load(); render(); }
      catch (error) { fieldError(form, error); } finally { restore(); }
    });
  }
  async function load() { data = await api('/api/admin/data'); }
  async function save(path, body, button) {
    const restore = loadingButton(button, 'Saving…');
    try {
      await api(path, { method: 'PUT', body });
      editing = false;
      await load();
      await refreshData();
      render();
      toast('Changes saved. Looking good.');
    } catch (error) {
      if (error.status === 401) { toast('Your session expired. Please sign in again.'); login(); }
      else fieldError(button.closest('form') || root, error);
    } finally { restore(); }
  }
  function render() {
    if (location.pathname !== '/admin') return;
    const today = todayIn(data.settings.timezone);
    const active = data.bookings.filter((b) => b.status === 'confirmed');
    const todays = active.filter((b) => b.date === today);
    root.innerHTML = `<section class="section-shell admin-intro"><div><p class="eyebrow">BEHIND THE CHAIR</p><h1>The <span class="serif-word">studio.</span></h1><p>A little order. More time for the good stuff.</p></div><button class="button outline" id="logout">Sign out ${arrow}</button></section><section class="section-shell admin-shell"><nav class="admin-nav" aria-label="Studio management">${[['appointments', 'Appointments'], ['availability', 'Availability'], ['services', 'Services'], ['gallery', 'Gallery'], ['settings', 'Studio details']].map(([id, label]) => `<button data-tab="${id}" class="${id === tab ? 'active' : ''}" ${id === tab ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav><div id="admin-content">${tab === 'appointments' ? `<div class="stat-grid"><div><span>ON THE BOOKS TODAY</span><strong>${todays.length}</strong><small>${dateLabel(today, { weekday: 'short', month: 'short' })}</small></div><div><span>UPCOMING VISITS</span><strong>${active.filter((b) => b.ends_at > Date.now()).length}</strong><small>A little good company ahead</small></div><div><span>TODAY’S SCHEDULED TOTAL</span><strong>${money(todays.reduce((sum, b) => sum + b.price, 0))}</strong><small>Before cancellations or no-shows</small></div></div><div class="admin-section-heading"><h2>Your appointments</h2><input class="search-input" id="appointment-search" type="search" placeholder="Search name or phone" aria-label="Search appointments" value="${esc(search)}"></div><div class="filter-row appointment-filters">${[['upcoming', 'Upcoming'], ['today', 'Today'], ['past', 'Past'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([id, name]) => `<button class="filter ${filter === id ? 'active' : ''}" data-booking-filter="${id}" aria-pressed="${filter === id}">${name}</button>`).join('')}</div><div id="appointment-list">${appointments()}</div>` : tab === 'availability' ? availability() : tab === 'services' ? services() : tab === 'gallery' ? gallery() : settingsForm()}</div></section><dialog id="admin-dialog"><form method="dialog"><button class="dialog-close" aria-label="Close">×</button><div id="admin-dialog-content"></div></form></dialog>`;
    bind(); imageEvents(root);
  }
  function appointments() {
    const today = todayIn(data.settings.timezone);
    const bookings = data.bookings.filter((b) => {
      const match = !search || `${b.name} ${b.email} ${b.phone} ${b.service_name}`.toLowerCase().includes(search.toLowerCase());
      return match && (filter === 'all' || (filter === 'cancelled' ? b.status === 'cancelled' : filter === 'today' ? b.date === today && b.status !== 'cancelled' : filter === 'upcoming' ? b.ends_at > Date.now() && b.status === 'confirmed' : b.ends_at <= Date.now() && b.status !== 'cancelled'));
    }).sort((a, b) => filter === 'past' ? b.starts_at - a.starts_at : a.starts_at - b.starts_at);
    if (!bookings.length) return `<div class="empty-state">${smallIcon('calendar')}<h3>${search ? 'No matching appointments.' : 'A little breathing room.'}</h3><p>${search ? 'Try a different name or phone number.' : 'Appointments will appear here as people book.'}</p><a href="/schedule" class="text-link">View the booking page ${arrow}</a></div>`;
    return `<div class="appointment-list">${bookings.map((b) => `<article class="appointment-row"><div class="appointment-date"><strong>${new Date(`${b.date}T12:00:00`).getDate()}</strong><span>${new Date(`${b.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span></div><div class="appointment-person"><h3>${esc(b.name)}</h3><p>${esc(b.service_name)} <span>·</span> ${b.duration} min <span>·</span> ${money(b.price)}</p>${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ''}${b.phone ? `<a class="appointment-phone" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}${b.notes ? `<p class="appointment-notes">“${esc(b.notes)}”</p>` : ''}</div><div class="appointment-time"><strong>${timeLabel(b.time)}</strong><span class="status-badge ${b.status === 'cancelled' ? 'cancelled' : ''}">${esc(b.status)}</span></div>${b.status === 'confirmed' ? `<div class="appointment-buttons">${b.ends_at <= Date.now() ? `<button class="subtle-button" data-booking-action="completed" data-id="${b.id}">Complete</button><button class="subtle-button" data-booking-action="no-show" data-id="${b.id}">No-show</button>` : ''}<button class="subtle-button danger" data-booking-action="cancelled" data-id="${b.id}">Cancel</button></div>` : ''}</article>`).join('')}</div><p class="fine-print">All appointment times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}. Status changes do not send automatic messages.</p>`;
  }
  function availability() {
    return `<div class="admin-section-heading"><div><h2>Make room for good days.</h2><p>Your weekly rhythm, with a little flexibility.</p></div></div><form id="hours-form"><div class="admin-panel"><h3>Weekly hours</h3><p class="fine-print">Times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}. Existing appointments stay booked when hours change.</p><div class="hours-editor">${data.hours.map((row) => `<div class="hours-editor-row" data-day="${row.day}"><label class="toggle-label"><input type="checkbox" name="enabled-${row.day}" ${row.enabled ? 'checked' : ''}><span>${dayNames[row.day]}</span></label><div><label><span class="sr-only">${dayNames[row.day]} opening time</span><input name="start-${row.day}" type="time" value="${row.start}" required></label><span class="hours-to">to</span><label><span class="sr-only">${dayNames[row.day]} closing time</span><input name="end-${row.day}" type="time" value="${row.end}" required></label></div></div>`).join('')}</div></div><div class="admin-panel"><h3>Days off</h3><p class="fine-print">Close a full date for holidays or a little time away. Existing appointments need to be cancelled separately.</p><div id="days-off-list">${data.daysOff.map((day) => dayOffRow(day)).join('')}</div><button type="button" class="button outline small" id="add-day-off">+ Add a day off</button></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save availability ${arrow}</button></form>`;
  }
  function dayOffRow(day = {}) { return `<div class="day-off-row"><label>Date<input type="date" name="off-date" value="${esc(day.date || '')}" required></label><label>Note<input name="off-note" value="${esc(day.note || '')}" maxlength="150" placeholder="A little time away"></label><button type="button" class="icon-button remove-row" aria-label="Remove day off">×</button></div>`; }
  function services() {
    return `<div class="admin-section-heading"><div><h2>The menu, your way.</h2><p>Set your services, prices, and time in the chair.</p></div></div><form id="services-form"><div id="service-editor-list">${data.services.map((s) => serviceRow(s)).join('')}</div><button class="button outline small" type="button" id="add-service">+ Add a service</button><p class="fine-print">Prices are in USD. Service changes apply to new bookings; existing appointments keep their booked price and duration.</p><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save services ${arrow}</button></form>`;
  }
  function serviceRow(s = { active: 1, duration: 45, price: 4000 }) {
    return `<fieldset class="admin-panel service-editor" data-service-id="${esc(s.id || '')}"><legend class="sr-only">Service details</legend><div class="form-grid"><label class="full">Service name<input name="name" required maxlength="80" value="${esc(s.name || '')}" placeholder="The signature cut"></label><label class="full">Description<textarea name="description" rows="2" required maxlength="400">${esc(s.description || '')}</textarea></label><label>Duration (minutes)<select name="duration">${Array.from({ length: 12 }, (_, i) => (i + 1) * 15).map((n) => `<option ${s.duration === n ? 'selected' : ''} value="${n}">${n} minutes</option>`).join('')}</select></label><label>Price (USD)<input name="price" type="number" min="0" max="1000" step="0.01" required value="${(s.price / 100).toFixed(2)}"></label></div><div class="editor-bottom"><label class="toggle-label"><input name="active" type="checkbox" ${s.active ? 'checked' : ''}>Available to book</label><button class="subtle-button danger remove-row" type="button">Remove service</button></div></fieldset>`;
  }
  function gallery() {
    return `<div class="admin-section-heading"><div><h2>Let your work do the talking.</h2><p>Add real cuts, a little texture, and your point of view.</p></div></div><form id="gallery-form"><div id="gallery-editor-list">${data.gallery.map((item) => galleryRow(item)).join('')}</div><button type="button" class="button outline small" id="add-gallery">+ Add a photo</button><p class="fine-print">Upload JPEG, PNG, or WebP images under 5 MB. Only share photos you have permission to publish.</p><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save gallery ${arrow}</button></form>`;
  }
  function galleryRow(item = {}) {
    return `<fieldset class="admin-panel gallery-editor" data-gallery-id="${esc(item.id || '')}" data-image="${esc(item.image || '')}"><legend class="sr-only">Gallery photo</legend><div class="gallery-editor-photo"><img src="${esc(item.image ? galleryImage(item) : '/assets/photo-fallback.svg')}" alt="${esc(item.alt || 'Preview of your gallery photo')}"><label class="upload-label">${item.image ? 'Replace photo' : 'Choose a photo'}<input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label><span class="upload-status" role="status"></span></div><div class="form-grid"><label class="full">Title<input name="title" required maxlength="100" value="${esc(item.title || '')}" placeholder="A fresh perspective"></label><label class="full">Image description<input name="alt" required maxlength="250" value="${esc(item.alt || '')}" placeholder="Describe the cut for people using a screen reader"></label><label class="full">Category<select name="category">${categories.map((c) => `<option ${item.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label class="toggle-label full"><input type="checkbox" name="sample" ${item.sample ? 'checked' : ''}>Label as style inspiration / sample image</label><button class="subtle-button danger remove-row" type="button">Remove photo</button></div></fieldset>`;
  }
  function settingsForm() {
    const s = data.settings;
    return `<div class="admin-section-heading"><div><h2>A studio that feels like you.</h2><p>The little details that make the page yours.</p></div></div><form id="settings-form"><div class="admin-panel"><h3>Your studio</h3><div class="form-grid">${[['name', 'Studio name', 50], ['tagline', 'Tagline', 100], ['location', 'Location / neighborhood', 150], ['address', 'Full address', 300], ['email', 'Contact email', 254], ['phone', 'Contact phone', 40], ['instagram', 'Instagram profile URL', 200], ['timezone', 'Time zone', 80]].map(([key, label, max]) => `<label>${label}<input name="${key}" ${key === 'email' ? 'type="email"' : key === 'instagram' ? 'type="url"' : ''} value="${esc(s[key])}" maxlength="${max}" ${['name', 'tagline', 'location', 'timezone'].includes(key) ? 'required' : ''}>${key === 'timezone' ? '<small>IANA name, for example America/New_York.</small>' : ''}</label>`).join('')}<label class="full">Homepage introduction<textarea name="description" rows="3" maxlength="600" required>${esc(s.description)}</textarea></label></div></div><div class="admin-panel"><h3>Booking preferences</h3><div class="form-grid"><label>Minimum notice (minutes)<input name="leadMinutes" type="number" min="0" max="10080" required value="${s.leadMinutes}"></label><label>How far ahead can clients book? (days)<input name="bookingDays" type="number" min="1" max="180" required value="${s.bookingDays}"></label><label class="full">Appointment note<textarea name="bookingNotice" rows="3" maxlength="500">${esc(s.bookingNotice)}</textarea></label></div></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save studio details ${arrow}</button></form>`;
  }
  function bind() {
    root.oninput = () => { editing = true; };
    $('#logout').addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST', body: {} }); editing = false; session.authenticated = false; login(); toast('Signed out. See you soon.'); } catch (error) { toast(error.message); }
    });
    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => {
      const next = button.dataset.tab;
      if (next === tab) return;
      if (editing && tab !== 'appointments') showDialog('Leave without saving?', 'You have changes on this page. Save them first or leave them behind.', 'Leave page', () => { tab = next; editing = false; render(); });
      else { tab = next; editing = false; render(); }
    }));
    $$('[data-booking-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.bookingFilter; render(); }));
    $('#appointment-search')?.addEventListener('input', (event) => { search = event.target.value; $('#appointment-list').innerHTML = appointments(); bindAppointmentActions(); });
    bindAppointmentActions();
    $('#add-day-off')?.addEventListener('click', () => { $('#days-off-list').insertAdjacentHTML('beforeend', dayOffRow()); editing = true; bindRemove(); });
    $('#add-service')?.addEventListener('click', () => { if ($$('.service-editor').length >= 20) return toast('You can add up to 20 services.'); $('#service-editor-list').insertAdjacentHTML('beforeend', serviceRow()); editing = true; bindRemove(); });
    $('#add-gallery')?.addEventListener('click', () => { if ($$('.gallery-editor').length >= 100) return toast('You can add up to 100 photos.'); $('#gallery-editor-list').insertAdjacentHTML('beforeend', galleryRow()); editing = true; bindRemove(); bindUploads(); });
    bindRemove(); bindUploads();
    $('#hours-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const hours = $$('[data-day]', form).map((row) => { const day = Number(row.dataset.day); return { day, enabled: $(`[name="enabled-${day}"]`, row).checked ? 1 : 0, start: $(`[name="start-${day}"]`, row).value, end: $(`[name="end-${day}"]`, row).value }; });
      const daysOff = $$('.day-off-row', form).map((row) => ({ date: $('[name="off-date"]', row).value, note: $('[name="off-note"]', row).value }));
      save('/api/admin/hours', { hours, daysOff }, $('button[type="submit"]', form));
    });
    $('#services-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const services = $$('.service-editor', form).map((row) => ({ id: row.dataset.serviceId || undefined, name: $('[name="name"]', row).value, description: $('[name="description"]', row).value, duration: Number($('[name="duration"]', row).value), price: Math.round(Number($('[name="price"]', row).value) * 100), active: $('[name="active"]', row).checked }));
      save('/api/admin/services', { services }, $('button[type="submit"]', form));
    });
    $('#gallery-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      if ($$('input[type="file"]', form).some((input) => input.disabled)) return toast('Let your photo finish uploading first.');
      const gallery = $$('.gallery-editor', form).map((row) => ({ id: row.dataset.galleryId || undefined, title: $('[name="title"]', row).value, alt: $('[name="alt"]', row).value, category: $('[name="category"]', row).value, image: row.dataset.image, sample: $('[name="sample"]', row).checked }));
      save('/api/admin/gallery', { gallery }, $('button[type="submit"]', form));
    });
    $('#settings-form')?.addEventListener('submit', (event) => { event.preventDefault(); const form = event.currentTarget; const settings = Object.fromEntries(new FormData(form)); settings.leadMinutes = Number(settings.leadMinutes); settings.bookingDays = Number(settings.bookingDays); save('/api/admin/settings', settings, $('button[type="submit"]', form)); });
  }
  function bindRemove() { $$('.remove-row').forEach((button) => { button.onclick = () => { button.closest('fieldset, .day-off-row').remove(); editing = true; }; }); }
  function bindUploads() {
    $$('input[type="file"]').forEach((input) => { input.onchange = async () => {
      const file = input.files[0];
      if (!file) return;
      const row = input.closest('.gallery-editor'); const status = $('.upload-status', row);
      if (file.size > 5_000_000) { input.value = ''; return toast('Please choose an image under 5 MB.'); }
      input.disabled = true; status.textContent = 'Uploading…';
      try {
        const base64 = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = () => reject(new Error('This photo could not be read.')); reader.readAsDataURL(file); });
        const result = await api('/api/admin/upload', { method: 'POST', body: { data: base64 } });
        row.dataset.image = result.image; $('img', row).src = result.image;
        $('[name="sample"]', row).checked = false;
        status.textContent = 'Uploaded. Save gallery to publish.'; editing = true;
      } catch (error) { status.textContent = error.message; input.value = ''; } finally { input.disabled = false; }
    }; });
  }
  function bindAppointmentActions() {
    $$('[data-booking-action]').forEach((button) => button.addEventListener('click', () => {
      const action = button.dataset.bookingAction;
      const booking = data.bookings.find((b) => b.id === button.dataset.id);
      showDialog(action === 'cancelled' ? 'Cancel this appointment?' : action === 'completed' ? 'All looking good?' : 'Mark as a no-show?', `${booking.name} · ${booking.service_name} · ${dateLabel(booking.date)} at ${timeLabel(booking.time)}. No automatic notification is sent.`, action === 'cancelled' ? 'Cancel appointment' : 'Update appointment', async () => {
        await api(`/api/admin/bookings/${booking.id}`, { method: 'PATCH', body: { status: action } });
        await load(); render(); toast('Appointment updated.');
      });
    }));
  }
  function showDialog(title, description, action, callback) {
    const dialog = $('#admin-dialog');
    $('#admin-dialog-content').innerHTML = `<h2>${esc(title)}</h2><p>${esc(description)}</p><p class="form-error" data-error role="alert" hidden></p><div class="dialog-actions"><button class="button outline" value="close">Go back</button><button class="button primary" type="button" id="dialog-confirm">${esc(action)}</button></div>`;
    dialog.showModal();
    $('#dialog-confirm').addEventListener('click', async (event) => {
      const restore = loadingButton(event.currentTarget, 'One moment…');
      try { await callback(); if (dialog.isConnected) dialog.close(); } catch (error) { fieldError(dialog, error); } finally { restore(); }
    });
  }
  if (session.authenticated) { await load(); render(); } else login();
}
