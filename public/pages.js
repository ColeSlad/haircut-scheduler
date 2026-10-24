import { esc, money, timeLabel, dayNames, imageEvents, $, $$ } from './shared.js?v=7';

const photos = [
  'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=800&q=85',
  'https://images.unsplash.com/photo-1621605815971-fbc98d665033?auto=format&fit=crop&w=800&q=85',
  'https://images.unsplash.com/photo-1622296089863-eb7fc530daa8?auto=format&fit=crop&w=800&q=85',
];

export function galleryImage(item) {
  const sample = /^\/assets\/cut-([1-3])\.jpg$/.exec(item.image);
  return sample ? photos[Number(sample[1]) - 1] : item.image;
}

export function galleryCard(item) {
  return `<article class="work-card">
    <div class="work-photo"><img src="${esc(galleryImage(item))}" alt="${esc(item.alt)}" loading="lazy"></div>
    <div class="work-caption"><h3>${esc(item.title)}</h3><p>${esc(item.category)}${item.sample ? ' · Sample photo' : ''}</p></div>
  </article>`;
}

export function home(data) {
  const { settings: s, services, hours } = data;
  return `<section class="section-shell page-intro home-intro">
    <h1>Haircuts by appointment</h1>
    <p>${esc(s.description)}</p>
    <div class="page-actions"><a class="button primary" href="/schedule">Book a cut</a><a class="text-link" href="/gallery">View gallery</a></div>
  </section>
  <div class="section-shell home-details">
    <section class="services-section" id="services">
      <h2>Haircut</h2>
      <ul class="service-list">${services.map((service) => `<li>
        <div><h3>${esc(service.name)}</h3><p>${service.duration} minutes · ${money(service.price)}</p></div>
        <a class="text-link" href="/schedule" aria-label="Book ${esc(service.name)}">Book</a>
      </li>`).join('')}</ul>
      <p class="fine-print">Payment is taken at your appointment.</p>
    </section>
    <section class="visit-details">
      <h2>Location &amp; hours</h2>
      <p>${esc(s.location)}</p>
      ${s.address ? `<p>${esc(s.address)}</p>` : ''}
      <dl class="hours-list">${hours.filter((day) => day.enabled).map((day) => `<div><dt>${dayNames[day.day]}</dt><dd>${timeLabel(day.start)} – ${timeLabel(day.end)}</dd></div>`).join('')}</dl>
      <p class="fine-print">${esc(s.timezone.replaceAll('_', ' '))}</p>
      ${s.phone ? `<p><a href="tel:${esc(s.phone)}">${esc(s.phone)}</a></p>` : ''}
    </section>
  </div>`;
}

export function galleryPage(data) {
  return `<section class="section-shell page-intro"><h1>Gallery</h1></section>
    <section class="section-shell gallery-section" aria-labelledby="tiktok-heading">
      <div class="gallery-heading"><h2 id="tiktok-heading">TikTok videos</h2><a class="text-link" href="https://www.tiktok.com/@l2cuts" target="_blank" rel="noopener noreferrer">@l2cuts</a></div>
      ${(data.videos || []).length ? `<div class="video-grid">${data.videos.map((video) => {
        const id = /\/video\/(\d+)$/.exec(video.url)?.[1];
        return id ? `<article class="video-card"><iframe class="tiktok-player" src="https://www.tiktok.com/player/v1/${id}?autoplay=0&amp;rel=0" title="${esc(video.title)}" loading="lazy" allow="fullscreen" referrerpolicy="no-referrer"></iframe><h3>${esc(video.title)}</h3><a class="text-link" href="${esc(video.url)}" target="_blank" rel="noopener noreferrer">Watch on TikTok</a></article>` : '';
      }).join('')}</div>` : '<p class="empty-state">No videos yet. <a href="https://www.tiktok.com/@l2cuts" target="_blank" rel="noopener noreferrer">View @l2cuts on TikTok</a>.</p>'}
    </section>
    <section class="section-shell gallery-section" aria-labelledby="photos-heading">
      <h2 id="photos-heading">Photos</h2>
      ${data.gallery.length ? `<div class="filter-row" role="group" aria-label="Filter gallery">
        <button class="filter active" data-filter="All" aria-pressed="true">All photos</button>
        ${[...new Set(data.gallery.map((item) => item.category))].map((category) => `<button class="filter" data-filter="${esc(category)}" aria-pressed="false">${esc(category)}</button>`).join('')}
      </div>` : ''}
      ${data.gallery.some((item) => item.sample) ? '<p class="gallery-note">Photos marked as samples are style inspiration, not the studio’s own work.</p>' : ''}
      <div class="work-grid gallery-grid" id="gallery-grid">${data.gallery.length ? data.gallery.map(galleryCard).join('') : '<p class="empty-state">No photos yet.</p>'}</div>
    </section>`;
}

export function mountGallery(data) {
  $$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
    $$('[data-filter]').forEach((item) => {
      item.classList.toggle('active', item === button);
      item.setAttribute('aria-pressed', String(item === button));
    });
    const items = data.gallery.filter((item) => button.dataset.filter === 'All' || item.category === button.dataset.filter);
    $('#gallery-grid').innerHTML = items.map(galleryCard).join('');
    imageEvents($('#gallery-grid'));
  }));
}
