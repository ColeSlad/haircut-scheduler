import { esc, money } from './shared.js?v=11';

const photos = [
  'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=800&q=85',
  'https://images.unsplash.com/photo-1621605815971-fbc98d665033?auto=format&fit=crop&w=800&q=85',
  'https://images.unsplash.com/photo-1622296089863-eb7fc530daa8?auto=format&fit=crop&w=800&q=85',
];

export function galleryImage(item) {
  const sample = /^\/assets\/cut-([1-3])\.jpg$/.exec(item.image);
  return sample ? photos[Number(sample[1]) - 1] : item.image;
}

function localVideoPlayers(videos = []) {
  return videos.map((video) => `<video controls playsinline preload="none" poster="${esc(video.poster)}" aria-label="${esc(video.title)}"><source src="${esc(video.video)}" type="video/mp4"><a href="${esc(video.video)}">Open video</a></video>`).join('');
}

export function home(data) {
  const { settings: s, services } = data;
  const [haircut] = services;
  return `<section class="section-shell page-intro home-intro">
    <h1>Haircuts</h1>
    <p>${esc(s.description)}</p>
    ${haircut ? `<p class="home-price">${haircut.duration} min · ${money(haircut.price)}</p>` : ''}
    <div class="page-actions"><a class="button primary" href="/schedule">Book a cut</a><a class="text-link" href="/gallery">Gallery</a></div>
    ${haircut ? '<p class="fine-print">Pay at your appointment.</p>' : ''}
  </section>${data.homeVideos?.length ? `<section class="section-shell home-videos local-video-grid" aria-label="Haircut videos">${localVideoPlayers(data.homeVideos)}</section>` : ''}`;
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
    <section class="section-shell gallery-section" aria-labelledby="haircut-videos-heading">
      <h2 id="haircut-videos-heading">Haircut videos</h2>
      ${data.homeVideos?.length ? `<div class="local-video-grid">${localVideoPlayers(data.homeVideos)}</div>` : '<p class="empty-state">No videos yet.</p>'}
    </section>`;
}
