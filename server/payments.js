import Stripe from 'stripe';
import { createHmac, randomUUID } from 'node:crypto';
import { createBooking, HttpError, tokenHash } from './scheduling.js';

export function paymentProvider(env = process.env) {
  const key = env.STRIPE_SECRET_KEY;
  if (!key || !env.STRIPE_WEBHOOK_SECRET || !env.APP_SECRET || env.APP_SECRET.length < 32) throw new HttpError(503, 'Online payment is not configured yet. Please contact the barber.');
  if (!/^sk_(test|live)_/.test(key)) throw new Error('Invalid Stripe secret key.');
  if (env.VERCEL_ENV !== 'production' && key.startsWith('sk_live_')) throw new Error('Live Stripe keys may only be used in Vercel production.');
  // The SDK's pinned API version is recorded in package-lock.json.
  const stripe = new Stripe(key, { maxNetworkRetries: 2, timeout: 15000 });
  return { stripe, secret: env.APP_SECRET, webhookSecret: env.STRIPE_WEBHOOK_SECRET, live: key.startsWith('sk_live_') };
}

const objectId = (value) => typeof value === 'string' ? value : value?.id;
const unavailable = () => new HttpError(503, 'Payment could not be checked. Please try again; your time is still reserved.');

export function createPayments(db, { origin, provider = paymentProvider } = {}) {
  const get = typeof provider === 'function' ? provider : () => provider;
  const bookingById = (id) => db.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
  const managementToken = (id) => createHmac('sha256', get().secret).update(`booking:${id}`).digest('base64url');

  async function ensureCheckout(booking) {
    const { stripe } = get();
    if (booking.checkout_session_id) return stripe.checkout.sessions.retrieve(booking.checkout_session_id);
    // Stripe forgets idempotency keys after 24h. Never risk making a second session.
    if (Date.now() - booking.created_at >= 23 * 60 * 60_000) throw unavailable();
    let session;
    try {
      session = await stripe.checkout.sessions.create(JSON.parse(booking.checkout_params), { idempotencyKey: `checkout:${booking.id}` });
    } catch (error) {
      // An invalid request without a cached session cannot have taken a payment.
      if (error.type === 'StripeInvalidRequestError' && error.statusCode === 400 && error.code !== 'idempotency_key_in_use') {
        await db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending' AND checkout_session_id IS NULL").run(booking.id);
      }
      throw unavailable();
    }
    await db.prepare('UPDATE bookings SET checkout_session_id = ?, checkout_url = ? WHERE id = ? AND checkout_session_id IS NULL').run(session.id, session.url || null, booking.id);
    return session;
  }

  async function start(input, now = Date.now()) {
    get(); // Fail before reserving a slot when payments are unconfigured.
    if (typeof input.requestId !== 'string' || !/^[a-f0-9-]{36}$/.test(input.requestId)) throw new HttpError(400, 'Refresh this page and try again.');
    const requestHash = tokenHash(input.requestId);
    const fingerprint = tokenHash(JSON.stringify([input.date, input.time, input.serviceId ?? 'haircut', input.firstName, input.lastName, input.phone]));
    const booking = await db.transaction(async (tx) => {
      const previous = await tx.prepare('SELECT * FROM bookings WHERE request_hash = ?').get(requestHash);
      if (previous) {
        if (previous.request_fingerprint !== fingerprint) throw new HttpError(409, 'Your booking details changed. Please choose your time again.');
        if (previous.status !== 'pending') throw new HttpError(409, 'This checkout is already finished. Use your appointment link or choose another time.');
        return previous;
      }
      const id = randomUUID();
      const token = managementToken(id);
      const created = await createBooking(tx, input, now, { id, token });
      if (created.price < 50 || created.price > 100000) throw new HttpError(400, 'Online booking is unavailable at this price. Please contact the barber.');
      const expiresAt = Math.floor(now / 1000) + 31 * 60;
      const params = {
        mode: 'payment', payment_method_types: ['card'], client_reference_id: id,
        metadata: { booking_id: id }, payment_intent_data: { metadata: { booking_id: id } },
        line_items: [{ price_data: { currency: 'usd', unit_amount: created.price, product_data: { name: 'Haircut' } }, quantity: 1 }],
        expires_at: expiresAt,
        success_url: `${origin}/api/checkout/return/${id}`,
        cancel_url: `${origin}/api/checkout/return/${id}`,
      };
      await tx.prepare(`UPDATE bookings SET payment_status = 'unpaid', request_hash = ?, request_fingerprint = ?, hold_expires_at = ?, checkout_params = ? WHERE id = ?`).run(requestHash, fingerprint, expiresAt * 1000, JSON.stringify(params), id);
      return tx.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    });
    const session = await ensureCheckout(booking);
    await reconcile(booking.id, session);
    if (session.status !== 'open' || !session.url?.startsWith('https://checkout.stripe.com/')) throw new HttpError(409, 'This checkout has ended. Please choose another time.');
    return { id: booking.id, token: managementToken(booking.id), checkoutUrl: session.url };
  }

  async function reconcile(id, suppliedSession) {
    const { stripe, live } = get();
    const before = await bookingById(id);
    if (!before?.checkout_params) throw new HttpError(404, 'Checkout not found.');
    const session = suppliedSession || await ensureCheckout(before);
    if (session.client_reference_id !== id || session.metadata?.booking_id !== id || session.livemode !== live ||
      session.amount_total !== before.price || session.currency !== 'usd' || session.mode !== 'payment' ||
      (before.checkout_session_id && session.id !== before.checkout_session_id)) throw new Error('Stripe checkout does not match the reservation.');
    return db.transaction(async (tx) => {
      const booking = await tx.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
      if (session.status === 'complete' && session.payment_status === 'paid') {
        const intent = objectId(session.payment_intent);
        if (!intent) throw new Error('Paid checkout has no payment intent.');
        // A slot is never released while its checkout can still be paid.
        if (booking.status === 'expired' || (booking.status === 'cancelled' && booking.payment_status === 'unpaid')) throw new Error('Payment received for a released reservation.');
        await tx.prepare(`UPDATE bookings SET status = CASE WHEN status = 'pending' THEN 'confirmed' ELSE status END,
          payment_status = CASE WHEN payment_status = 'unpaid' THEN 'paid' ELSE payment_status END, payment_intent_id = ? WHERE id = ?`).run(intent, id);
      } else if (session.status === 'expired' && booking.status === 'pending') {
        await tx.prepare("UPDATE bookings SET status = 'expired' WHERE id = ?").run(id);
      }
      return tx.prepare('SELECT * FROM bookings WHERE id = ?').get(id);
    });
  }

  async function cancel(id) {
    let booking = await bookingById(id);
    if (!booking) throw new HttpError(404, 'Appointment not found.');
    if (booking.starts_at <= Date.now()) throw new HttpError(400, 'This appointment has already started. Please contact the barber.');
    if (booking.status === 'pending') {
      const { stripe } = get();
      let session = await ensureCheckout(booking);
      if (session.status === 'open') {
        try { session = await stripe.checkout.sessions.expire(session.id); }
        catch { session = await stripe.checkout.sessions.retrieve(session.id); }
      }
      booking = await reconcile(id, session);
      if (booking.status === 'pending') throw unavailable();
    }
    // Paid cancellations deliberately do not call Stripe's refund API.
    await db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ? AND status = 'confirmed'").run(id);
    return bookingById(id);
  }

  async function webhook(raw, signature) {
    const { stripe, webhookSecret, live } = get();
    let event;
    try { event = stripe.webhooks.constructEvent(raw, signature, webhookSecret); }
    catch { throw new HttpError(400, 'Invalid payment webhook signature.'); }
    if (event.livemode !== live) throw new HttpError(400, 'Wrong payment environment.');
    if (await db.prepare('SELECT id FROM stripe_events WHERE id = ?').get(event.id)) return;
    if (['checkout.session.completed', 'checkout.session.expired', 'checkout.session.async_payment_succeeded', 'checkout.session.async_payment_failed'].includes(event.type)) {
      const session = await stripe.checkout.sessions.retrieve(event.data.object.id);
      await reconcile(session.metadata?.booking_id, session);
    } else if (event.type === 'charge.refunded') {
      const charge = await stripe.charges.retrieve(event.data.object.id);
      const intent = objectId(charge.payment_intent);
      const booking = await db.prepare('SELECT * FROM bookings WHERE payment_intent_id = ?').get(intent);
      if (!booking) throw unavailable(); // Retry after the checkout completion event.
      if (charge.livemode !== live || charge.currency !== 'usd' || charge.amount !== booking.price || charge.amount_refunded < 0 || charge.amount_refunded > booking.price) throw new Error('Refund does not match the appointment.');
      await db.prepare(`UPDATE bookings SET amount_refunded = GREATEST(amount_refunded, ?),
        payment_status = CASE WHEN GREATEST(amount_refunded, ?) = price THEN 'refunded' ELSE 'partially_refunded' END WHERE id = ?`).run(charge.amount_refunded, charge.amount_refunded, booking.id);
    }
    await db.prepare('INSERT INTO stripe_events VALUES (?, ?, ?) ON CONFLICT DO NOTHING').run(event.id, event.type, Date.now());
  }

  async function sweep(now = Date.now()) {
    const rows = await db.prepare("SELECT id FROM bookings WHERE status = 'pending' AND hold_expires_at <= ? ORDER BY hold_expires_at LIMIT 50").all(now);
    let failed = 0;
    for (const row of rows) { try { await reconcile(row.id); } catch { failed++; console.error('payment_hold_reconciliation_failed', row.id); } }
    await db.prepare('DELETE FROM rate_limits WHERE expires_at <= ?').run(now);
    await db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    if (failed) throw unavailable();
    return { checked: rows.length };
  }

  return { start, reconcile, cancel, webhook, sweep, managementToken };
}
