import { $, $$, esc, money, timeLabel, dateLabel, todayIn, dayNames, categories, api, arrow, smallIcon, toast, loadingButton, fieldError, imageEvents } from './shared.js?v=12';
import { galleryImage } from './pages.js?v=12';

export async function mountAdmin(publicData, { refreshData }) {
  const root = $('#main');
  let session = await api('/api/admin/session');
  if (location.pathname !== '/admin') return;
  let data;
  let tab = 'appointments';
  let filter = 'upcoming';
  let search = '';
  let editing = false;
  function login() {
    if (location.pathname !== '/admin' || !root.isConnected) return;
    root.innerHTML = `<section class="login-section section-shell"><a href="/" class="back-link">← Home</a><div class="login-card"><h1>Admin sign in</h1>${session.configured ? `<form id="login-form"><label>Email address<input name="email" type="email" autocomplete="username" required maxlength="254" placeholder="you@example.com"></label><label>Password<input name="password" type="password" autocomplete="current-password" required maxlength="256" placeholder="Your password"></label><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Sign in</button></form><p class="fine-print">To reset your password, run <code>npm run admin:create</code> in the project terminal with your existing email.</p>` : '<div class="setup-note"><p>Run <code>npm run admin:create</code> in the project terminal to create an admin account. Run it again with a different email to add the second admin.</p><button class="button outline" id="check-setup">I’ve created my account</button></div>'}</div></section>`;
    $('#check-setup')?.addEventListener('click', async () => {
      try { session = await api('/api/admin/session'); login(); } catch (error) { toast(error.message); }
    });
    $('#login-form')?.addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const restore = loadingButton($('button[type="submit"]', form), 'Signing in…');
      try { await api('/api/admin/login', { method: 'POST', body: Object.fromEntries(new FormData(form)) }); await load(); session.authenticated = true; render(); }
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
      toast('Changes saved.');
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
    root.innerHTML = `<section class="section-shell admin-intro"><h1>Admin</h1><button class="button outline" id="logout">Sign out ${arrow}</button></section><section class="section-shell admin-shell"><nav class="admin-nav" aria-label="Studio management">${[['appointments', 'Appointments'], ['availability', 'Availability'], ['services', 'Haircut'], ['reviews', 'Reviews'], ['gallery', 'Gallery'], ['videos', 'TikTok videos'], ['settings', 'Studio details']].map(([id, label]) => `<button data-tab="${id}" class="${id === tab ? 'active' : ''}" ${id === tab ? 'aria-current="page"' : ''}>${label}</button>`).join('')}</nav><div id="admin-content">${tab === 'appointments' ? `<div class="stat-grid"><div><span>Today’s appointments</span><strong>${todays.length}</strong><small>${dateLabel(today, { weekday: 'short', month: 'short' })}</small></div><div><span>Upcoming appointments</span><strong>${active.filter((b) => b.ends_at > Date.now()).length}</strong></div><div><span>Today’s booked total</span><strong>${money(todays.reduce((sum, b) => sum + b.price, 0))}</strong></div></div><div class="admin-section-heading"><h2>Appointments</h2><input class="search-input" id="appointment-search" type="search" placeholder="Search name or phone" aria-label="Search appointments" value="${esc(search)}"></div><div class="filter-row appointment-filters">${[['upcoming', 'Upcoming'], ['today', 'Today'], ['past', 'Past'], ['cancelled', 'Cancelled'], ['all', 'All']].map(([id, name]) => `<button class="filter ${filter === id ? 'active' : ''}" data-booking-filter="${id}" aria-pressed="${filter === id}">${name}</button>`).join('')}</div><div id="appointment-list">${appointments()}</div>` : tab === 'availability' ? availability() : tab === 'services' ? services() : tab === 'reviews' ? reviewsForm() : tab === 'gallery' ? gallery() : tab === 'videos' ? videos() : settingsForm()}</div></section><dialog id="admin-dialog"><form method="dialog"><button class="dialog-close" aria-label="Close">×</button><div id="admin-dialog-content"></div></form></dialog>`;
    bind(); imageEvents(root);
  }
  function appointments() {
    const today = todayIn(data.settings.timezone);
    const bookings = data.bookings.filter((b) => {
      const match = !search || `${b.name} ${b.email} ${b.phone} ${b.service_name}`.toLowerCase().includes(search.toLowerCase());
      return match && (filter === 'all' || (filter === 'cancelled' ? b.status === 'cancelled' : filter === 'today' ? b.date === today && b.status !== 'cancelled' : filter === 'upcoming' ? b.ends_at > Date.now() && b.status === 'confirmed' : b.ends_at <= Date.now() && b.status !== 'cancelled'));
    }).sort((a, b) => filter === 'past' ? b.starts_at - a.starts_at : a.starts_at - b.starts_at);
    if (!bookings.length) return `<div class="empty-state">${smallIcon('calendar')}<h3>${search ? 'No matching appointments' : 'No appointments'}</h3>${search ? '<p>Try a different name or phone number.</p>' : ''}<a href="/schedule" class="text-link">View the booking page ${arrow}</a></div>`;
    return `<div class="appointment-list">${bookings.map((b) => `<article class="appointment-row"><div class="appointment-date"><strong>${new Date(`${b.date}T12:00:00`).getDate()}</strong><span>${new Date(`${b.date}T12:00:00`).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}</span></div><div class="appointment-person"><h3>${esc(b.name)}</h3><p>${esc(b.service_name)} <span>·</span> ${b.duration} min <span>·</span> ${money(b.price)}</p>${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a>` : ''}${b.phone ? `<a class="appointment-phone" href="tel:${esc(b.phone)}">${esc(b.phone)}</a>` : ''}${b.notes ? `<p class="appointment-notes">“${esc(b.notes)}”</p>` : ''}</div><div class="appointment-time"><strong>${timeLabel(b.time)}</strong><span class="status-badge ${b.status === 'cancelled' ? 'cancelled' : ''}">${esc(b.status)}</span></div>${b.status === 'confirmed' ? `<div class="appointment-buttons">${b.ends_at <= Date.now() ? `<button class="subtle-button" data-booking-action="completed" data-id="${b.id}">Complete</button><button class="subtle-button" data-booking-action="no-show" data-id="${b.id}">No-show</button>` : ''}<button class="subtle-button danger" data-booking-action="cancelled" data-id="${b.id}">Cancel</button></div>` : ''}</article>`).join('')}</div><p class="fine-print">All appointment times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}. Status changes do not send automatic messages.</p>`;
  }
  function availability() {
    return `<div class="admin-section-heading"><div><h2>Availability</h2></div></div><form id="hours-form"><div class="admin-panel"><h3>Weekly hours</h3><p class="fine-print">Times are in ${esc(data.settings.timezone.replaceAll('_', ' '))}. Existing appointments stay booked when hours change.</p><div class="hours-editor">${data.hours.map((row) => `<div class="hours-editor-row" data-day="${row.day}"><label class="toggle-label"><input type="checkbox" name="enabled-${row.day}" ${row.enabled ? 'checked' : ''}><span>${dayNames[row.day]}</span></label><div><label><span class="sr-only">${dayNames[row.day]} opening time</span><input name="start-${row.day}" type="time" value="${row.start}" required></label><span class="hours-to">to</span><label><span class="sr-only">${dayNames[row.day]} closing time</span><input name="end-${row.day}" type="time" value="${row.end}" required></label></div></div>`).join('')}</div></div><div class="admin-panel"><h3>Days off</h3><p class="fine-print">Blocks new bookings for the date. Existing appointments must be cancelled separately.</p><div id="days-off-list">${data.daysOff.map((day) => dayOffRow(day)).join('')}</div><button type="button" class="button outline small" id="add-day-off">+ Add a day off</button></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save availability ${arrow}</button></form>`;
  }
  function dayOffRow(day = {}) { return `<div class="day-off-row"><label>Date<input type="date" name="off-date" value="${esc(day.date || '')}" required></label><label>Note<input name="off-note" value="${esc(day.note || '')}" maxlength="150" placeholder="Optional note"></label><button type="button" class="icon-button remove-row" aria-label="Remove day off">×</button></div>`; }
  function services() {
    const service = data.services[0];
    return `<div class="admin-section-heading"><div><h2>Haircut</h2></div></div><form id="services-form"><div class="admin-panel service-editor"><div class="form-grid"><label>Duration (minutes)<select name="duration">${Array.from({ length: 12 }, (_, i) => (i + 1) * 15).map((n) => `<option ${service.duration === n ? 'selected' : ''} value="${n}">${n} minutes</option>`).join('')}</select></label><label>Price (USD)<input name="price" type="number" min="0" max="1000" step="0.01" required value="${(service.price / 100).toFixed(2)}"></label></div></div><p class="fine-print">Prices are in USD. Changes apply to new bookings; existing appointments keep their booked price and duration.</p><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save haircut ${arrow}</button></form>`;
  }
  function reviewsForm() {
    return `<div class="admin-section-heading"><h2>Reviews</h2></div><form id="reviews-form"><div class="admin-panel"><label class="review-rating-input">Overall rating (out of 5)<input name="rating" type="number" min="0" max="5" step="0.01" inputmode="decimal" required value="${data.reviews.rating}"></label><p class="fine-print">Set separately from individual review ratings.</p></div><div id="review-editor-list">${data.reviews.items.map(reviewRow).join('')}</div><button class="button outline small" type="button" id="add-review">+ Add a review</button><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save reviews ${arrow}</button></form>`;
  }
  function reviewRow(review = {}) {
    return `<fieldset class="admin-panel review-editor" data-review-id="${esc(review.id || '')}"><legend class="sr-only">Review</legend><div class="form-grid"><label>Reviewer name<input name="reviewer" required maxlength="80" value="${esc(review.name || '')}" placeholder="Reviewer name"></label><label>Stars<select name="stars">${[1, 2, 3, 4, 5].map((stars) => `<option value="${stars}" ${stars === (review.stars || 5) ? 'selected' : ''}>${stars} ${stars === 1 ? 'star' : 'stars'}</option>`).join('')}</select></label><label class="full">Review text<textarea name="text" rows="2" required maxlength="600" placeholder="Review text">${esc(review.text || '')}</textarea></label><label class="toggle-label full"><input type="checkbox" name="sample" ${review.sample !== false ? 'checked' : ''}>Placeholder review</label><button class="subtle-button danger remove-row" type="button">Remove review</button></div></fieldset>`;
  }
  function gallery() {
    return `<div class="admin-section-heading"><div><h2>Photos</h2></div></div><form id="gallery-form"><div id="gallery-editor-list">${data.gallery.map((item) => galleryRow(item)).join('')}</div><button type="button" class="button outline small" id="add-gallery">+ Add a photo</button><p class="fine-print">Upload JPEG, PNG, or WebP images under 5 MB. Only share photos you have permission to publish.</p><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save gallery ${arrow}</button></form>`;
  }
  function galleryRow(item = {}) {
    return `<fieldset class="admin-panel gallery-editor" data-gallery-id="${esc(item.id || '')}" data-image="${esc(item.image || '')}"><legend class="sr-only">Gallery photo</legend><div class="gallery-editor-photo"><img src="${esc(item.image ? galleryImage(item) : '/assets/photo-fallback.svg')}" alt="${esc(item.alt || 'Preview of your gallery photo')}"><label class="upload-label">${item.image ? 'Replace photo' : 'Choose a photo'}<input type="file" name="photo" accept="image/jpeg,image/png,image/webp"></label><span class="upload-status" role="status"></span></div><div class="form-grid"><label class="full">Title<input name="title" required maxlength="100" value="${esc(item.title || '')}" placeholder="Photo title"></label><label class="full">Image description<input name="alt" required maxlength="250" value="${esc(item.alt || '')}" placeholder="Describe the cut for people using a screen reader"></label><label class="full">Category<select name="category">${categories.map((c) => `<option ${item.category === c ? 'selected' : ''}>${c}</option>`).join('')}</select></label><label class="toggle-label full"><input type="checkbox" name="sample" ${item.sample ? 'checked' : ''}>Label as style inspiration / sample image</label><button class="subtle-button danger remove-row" type="button">Remove photo</button></div></fieldset>`;
  }
  function videos() {
    return `<div class="admin-section-heading"><div><h2>TikTok videos</h2><p>Add video links from <a href="https://www.tiktok.com/@l2cuts" target="_blank" rel="noopener noreferrer">@l2cuts</a>.</p></div></div><form id="videos-form"><div id="video-editor-list">${(data.videos || []).map(videoRow).join('')}</div><button class="button outline small" type="button" id="add-video">+ Add a TikTok video</button><p class="fine-print">Open a video on @l2cuts and paste its full link. Up to 30 videos.</p><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save TikTok videos ${arrow}</button></form>`;
  }
  function videoRow(video = {}) {
    return `<fieldset class="admin-panel video-editor" data-video-id="${esc(video.id || '')}"><legend class="sr-only">TikTok video</legend><div class="form-grid"><label class="full">Video title<input name="title" required maxlength="100" value="${esc(video.title || '')}" placeholder="Haircut video"></label><label class="full">TikTok video URL<input name="url" type="url" required maxlength="300" value="${esc(video.url || '')}" placeholder="https://www.tiktok.com/@l2cuts/video/…"></label></div><button class="subtle-button danger remove-row" type="button">Remove video</button></fieldset>`;
  }
  function settingsForm() {
    const s = data.settings;
    return `<div class="admin-section-heading"><div><h2>Studio details</h2></div></div><form id="settings-form"><div class="admin-panel"><h3>Business information</h3><div class="form-grid">${[['name', 'Studio name', 50], ['tagline', 'Tagline', 100], ['location', 'Location / neighborhood', 150], ['address', 'Full address', 300], ['email', 'Contact email', 254], ['phone', 'Contact phone', 40], ['instagram', 'Instagram profile URL', 200], ['timezone', 'Time zone', 80]].map(([key, label, max]) => `<label>${label}<input name="${key}" ${key === 'email' ? 'type="email"' : key === 'instagram' ? 'type="url"' : ''} value="${esc(s[key])}" maxlength="${max}" ${['name', 'tagline', 'location', 'timezone'].includes(key) ? 'required' : ''}>${key === 'timezone' ? '<small>IANA name, for example America/New_York.</small>' : ''}</label>`).join('')}<label class="full">Homepage introduction<textarea name="description" rows="3" maxlength="600" required>${esc(s.description)}</textarea></label></div></div><div class="admin-panel"><h3>Booking preferences</h3><div class="form-grid"><label>Minimum notice (minutes)<input name="leadMinutes" type="number" min="0" max="10080" required value="${s.leadMinutes}"></label><label>How far ahead can clients book? (days)<input name="bookingDays" type="number" min="1" max="180" required value="${s.bookingDays}"></label><label class="full">Appointment note<textarea name="bookingNotice" rows="3" maxlength="500">${esc(s.bookingNotice)}</textarea></label></div></div><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><button class="button primary" type="submit">Save studio details ${arrow}</button></form>`;
  }
  function bind() {
    root.oninput = () => { editing = true; };
    $('#logout').addEventListener('click', async () => {
      try { await api('/api/admin/logout', { method: 'POST', body: {} }); editing = false; session.authenticated = false; login(); toast('Signed out.'); } catch (error) { toast(error.message); }
    });
    $$('[data-tab]').forEach((button) => button.addEventListener('click', () => {
      const next = button.dataset.tab;
      if (next === tab) return;
      if (editing && tab !== 'appointments') showDialog('Leave without saving?', 'Your unsaved changes will be discarded.', 'Leave page', () => { tab = next; editing = false; render(); });
      else { tab = next; editing = false; render(); }
    }));
    $$('[data-booking-filter]').forEach((button) => button.addEventListener('click', () => { filter = button.dataset.bookingFilter; render(); }));
    $('#appointment-search')?.addEventListener('input', (event) => { search = event.target.value; $('#appointment-list').innerHTML = appointments(); bindAppointmentActions(); });
    bindAppointmentActions();
    $('#add-day-off')?.addEventListener('click', () => { $('#days-off-list').insertAdjacentHTML('beforeend', dayOffRow()); editing = true; bindRemove(); });
    $('#add-gallery')?.addEventListener('click', () => { if ($$('.gallery-editor').length >= 100) return toast('You can add up to 100 photos.'); $('#gallery-editor-list').insertAdjacentHTML('beforeend', galleryRow()); editing = true; bindRemove(); bindUploads(); });
    $('#add-review')?.addEventListener('click', () => { if ($$('.review-editor').length >= 10) return toast('You can add up to 10 reviews.'); $('#review-editor-list').insertAdjacentHTML('beforeend', reviewRow()); editing = true; bindRemove(); });
    $('#add-video')?.addEventListener('click', () => { if ($$('.video-editor').length >= 30) return toast('You can add up to 30 TikTok videos.'); $('#video-editor-list').insertAdjacentHTML('beforeend', videoRow()); editing = true; bindRemove(); });
    bindRemove(); bindUploads();
    $('#hours-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const hours = $$('[data-day]', form).map((row) => { const day = Number(row.dataset.day); return { day, enabled: $(`[name="enabled-${day}"]`, row).checked ? 1 : 0, start: $(`[name="start-${day}"]`, row).value, end: $(`[name="end-${day}"]`, row).value }; });
      const daysOff = $$('.day-off-row', form).map((row) => ({ date: $('[name="off-date"]', row).value, note: $('[name="off-note"]', row).value }));
      save('/api/admin/hours', { hours, daysOff }, $('button[type="submit"]', form));
    });
    $('#videos-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const videos = $$('.video-editor', form).map((row) => ({ id: row.dataset.videoId || undefined, title: $('[name="title"]', row).value, url: $('[name="url"]', row).value }));
      save('/api/admin/videos', { videos }, $('button[type="submit"]', form));
    });
    $('#reviews-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const items = $$('.review-editor', form).map((row) => ({ id: row.dataset.reviewId || undefined, name: $('[name="reviewer"]', row).value, text: $('[name="text"]', row).value, stars: Number($('[name="stars"]', row).value), sample: $('[name="sample"]', row).checked }));
      save('/api/admin/reviews', { rating: Number($('[name="rating"]', form).value), items }, $('button[type="submit"]', form));
    });
    $('#services-form')?.addEventListener('submit', (event) => {
      event.preventDefault(); const form = event.currentTarget;
      const services = [{ id: data.services[0].id, duration: Number($('[name="duration"]', form).value), price: Math.round(Number($('[name="price"]', form).value) * 100), active: true }];
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
      showDialog(action === 'cancelled' ? 'Cancel this appointment?' : action === 'completed' ? 'Mark appointment as completed?' : 'Mark as a no-show?', `${booking.name} · ${booking.service_name} · ${dateLabel(booking.date)} at ${timeLabel(booking.time)}. No automatic notification is sent.`, action === 'cancelled' ? 'Cancel appointment' : 'Update appointment', async () => {
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
      const restore = loadingButton(event.currentTarget, 'Updating…');
      try { await callback(); if (dialog.isConnected) dialog.close(); } catch (error) { fieldError(dialog, error); } finally { restore(); }
    });
  }
  if (session.authenticated) { await load(); render(); } else login();
}
