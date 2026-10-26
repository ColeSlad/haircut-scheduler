import { $, esc, api, loadingButton, fieldError } from './shared.js';

export function reviewCard(review, { showDate = false } = {}) {
  return `<figure class="review-item"><div class="review-stars" role="img" aria-label="${review.stars} out of 5 stars"><span aria-hidden="true">${'★'.repeat(review.stars)}${'☆'.repeat(5 - review.stars)}</span></div><blockquote><p>${esc(review.text)}</p></blockquote><figcaption><span>${esc(review.name)}</span>${review.sample ? '<span class="review-placeholder">Placeholder</span>' : ''}${showDate && review.createdAt ? `<time datetime="${new Date(review.createdAt).toISOString()}">${new Date(review.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</time>` : ''}</figcaption></figure>`;
}
export function reviewRating(reviews) {
  return reviews.rating === null ? 'No ratings yet' : `${reviews.rating.toFixed(2)}/5 · ${reviews.ratedCount} ${reviews.ratedCount === 1 ? 'rating' : 'ratings'}`;
}
export async function mountReviews(data, { refreshData }) {
  const root = $('#main');
  const current = () => root.isConnected && location.pathname === '/reviews';
  root.innerHTML = '<div class="section-shell centered-state" role="status">Loading reviews…</div>';
  let reviews = await api('/api/reviews');
  if (!current()) return;
  let pendingSubmission;
  root.innerHTML = `<section class="section-shell page-intro reviews-intro"><div><h1>Reviews</h1><p id="all-review-rating">${reviewRating(reviews)}</p></div><a class="button outline" href="#write-review">Write a review</a></section><section class="section-shell reviews-layout"><div class="reviews-feed"><div id="all-reviews"></div><p class="form-error" id="reviews-load-error" role="alert" hidden></p></div><section class="review-submission" id="write-review" aria-labelledby="write-review-heading"><h2 id="write-review-heading">Write a review</h2><form id="public-review-form"><fieldset class="review-fields"><legend class="sr-only">Your review</legend><label>Name (shown publicly)<input name="name" autocomplete="name" required maxlength="80" placeholder="Your name"></label><label>Rating<select name="stars" required><option value="">Choose a rating</option>${[5, 4, 3, 2, 1].map(stars => `<option value="${stars}">${stars} ${stars === 1 ? 'star' : 'stars'}</option>`).join('')}</select></label><label>Your review<textarea name="text" rows="4" required maxlength="600" placeholder="How was your cut?"></textarea></label><label class="honeypot" aria-hidden="true">Website<input name="website" tabindex="-1" autocomplete="off"></label></fieldset><p class="form-error" data-error role="alert" tabindex="-1" hidden></p><p id="review-feedback" role="status" hidden></p><button class="button primary" type="submit">Post review</button></form></section></section>`;
  function renderRows() {
    $('#all-review-rating', root).textContent = reviewRating(reviews);
    $('#all-reviews', root).innerHTML = `${reviews.items.length ? reviews.items.map(review => reviewCard(review, { showDate: true })).join('') : '<p class="empty-state">No reviews yet.</p>'}${reviews.nextCursor ? '<button class="button outline" id="load-more-reviews">Load more reviews</button>' : ''}`;
    $('#load-more-reviews', root)?.addEventListener('click', async (event) => {
      const restore = loadingButton(event.currentTarget, 'Loading…');
      $('#reviews-load-error', root).hidden = true;
      try {
        const next = await api(`/api/reviews?before=${reviews.nextCursor}`);
        if (!current()) return;
        reviews = { ...next, items: [...reviews.items, ...next.items] };
        renderRows();
      } catch (error) { if (current()) { $('#reviews-load-error', root).textContent = error.message; $('#reviews-load-error', root).hidden = false; } }
      finally { restore(); }
    });
  }
  renderRows();
  const form = $('#public-review-form', root);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const values = new FormData(form);
    const details = { name: values.get('name').trim(), text: values.get('text').trim(), stars: Number(values.get('stars')), website: values.get('website') };
    const restore = loadingButton($('button[type="submit"]', form), 'Posting…');
    $('fieldset', form).disabled = true;
    $('[data-error]', form).hidden = true;
    $('#review-feedback', form).hidden = true;
    try {
      const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(details))))).map(byte => byte.toString(16).padStart(2, '0')).join('');
      let saved = pendingSubmission;
      try { saved = JSON.parse(sessionStorage.getItem('l2cuts-review') || 'null') || saved; } catch { /* Keep in-memory retries when storage is unavailable. */ }
      if (!saved || saved.fingerprint !== fingerprint) saved = { fingerprint, requestId: crypto.randomUUID() };
      pendingSubmission = saved;
      try { sessionStorage.setItem('l2cuts-review', JSON.stringify(saved)); } catch { /* Optional browser storage. */ }
      const result = await api('/api/reviews', { method: 'POST', body: { ...details, requestId: saved.requestId } });
      pendingSubmission = null;
      try { sessionStorage.removeItem('l2cuts-review'); } catch { /* Optional browser storage. */ }
      if (!current()) return;
      form.reset();
      $('#review-feedback', form).textContent = result.published ? 'Your review was added.' : 'Your review was already submitted.';
      $('#review-feedback', form).hidden = false;
      try {
        const latest = await api('/api/reviews');
        await refreshData();
        if (current()) { reviews = latest; renderRows(); }
      } catch { if (current()) $('#review-feedback', form).textContent = 'Your review was saved. Refresh the page to update the list.'; }
    } catch (error) { if (current()) fieldError(form, error); }
    finally { $('fieldset', form).disabled = false; restore(); }
  });
}
