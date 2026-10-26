import Stripe from 'stripe';
import { randomUUID } from 'node:crypto';

export function fakeProvider() {
  const sessions = new Map();
  const keys = new Map();
  const charges = new Map();
  const webhookSecret = 'whsec_isolated_test_fixture';
  const webhooks = new Stripe('sk_test_fixture').webhooks;
  const provider = {
    secret: 'isolated-test-secret-at-least-32-characters', webhookSecret, live: false,
    stripe: {
      webhooks,
      checkout: { sessions: {
        async create(params, { idempotencyKey }) {
          if (keys.has(idempotencyKey)) return structuredClone(sessions.get(keys.get(idempotencyKey)));
          const id = `cs_test_${randomUUID()}`;
          const session = { ...params, id, status: 'open', payment_status: 'unpaid', livemode: false, currency: 'usd', amount_total: params.line_items[0].price_data.unit_amount, url: `https://checkout.stripe.com/c/pay/${id}` };
          sessions.set(id, session); keys.set(idempotencyKey, id);
          return structuredClone(session);
        },
        async retrieve(id) { if (!sessions.has(id)) throw new Error('Unknown test session'); return structuredClone(sessions.get(id)); },
        async expire(id) { const session = sessions.get(id); if (session.status !== 'open') throw new Error('Already finished'); session.status = 'expired'; return structuredClone(session); },
      } },
      charges: { async retrieve(id) { return structuredClone(charges.get(id)); } },
      paymentIntents: { async retrieve(id) {
        const session = [...sessions.values()].find((item) => item.payment_intent === id);
        return { id, metadata: session?.payment_intent_data?.metadata || {} };
      } },
    },
    sessions, charges,
    payBooking(id) {
      const session = [...sessions.values()].find((item) => item.client_reference_id === id);
      Object.assign(session, { status: 'complete', payment_status: 'paid', payment_intent: `pi_${id}`, url: null });
      return session;
    },
    event(type, object, id = `evt_${randomUUID()}`) {
      const raw = JSON.stringify({ id, type, livemode: false, data: { object } });
      return { raw: Buffer.from(raw), signature: webhooks.generateTestHeaderString({ payload: raw, secret: webhookSecret }) };
    },
  };
  return provider;
}
