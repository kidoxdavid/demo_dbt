import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** The port every payment provider adapter implements. Raw card data never touches our servers. */
export interface PaymentProvider {
  readonly name: string; readonly simulated: boolean;
  createIntent(a: { orderId: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<{ providerRef: string; clientSecret?: string }>;
  refund(a: { paymentRef: string; amountCents: number; idempotencyKey: string }): Promise<{ providerRef: string }>;
  verifyWebhook(rawBody: string, signature: string | undefined): boolean;
}
export const MOCK_SECRET = process.env.MOCK_WEBHOOK_SECRET ?? 'mock-webhook-secret-dev-only';
export const sign = (body: string) => createHmac('sha256', MOCK_SECRET).update(body).digest('hex');
/** Simulated provider for development and tests: moves no money. `failRefundsOnce` lets tests exercise the failure path. */
export const mock: PaymentProvider & { failRefundsOnce: number } = {
  name: 'mock', simulated: true, failRefundsOnce: 0,
  async createIntent(a) { return { providerRef: 'mock_pi_' + randomBytes(10).toString('hex'), clientSecret: 'mock_secret_' + a.orderId }; },
  async refund() { if (mock.failRefundsOnce > 0) { mock.failRefundsOnce--; throw new Error('provider_unavailable'); } return { providerRef: 'mock_re_' + randomBytes(10).toString('hex') }; },
  verifyWebhook(raw, sig) { if (!sig) return false; const want = Buffer.from(sign(raw)); const got = Buffer.from(sig); return want.length === got.length && timingSafeEqual(want, got); },
};
/** 'mock' is the only adapter built. A Stripe adapter is a later step and must implement this interface. Production refuses the mock. */
export function getProvider(name = process.env.PAYMENT_PROVIDER ?? (process.env.NODE_ENV === 'production' ? 'none' : 'mock')): PaymentProvider | null { return name === 'mock' ? mock : null; }
