import { randomBytes } from 'node:crypto';
import { paymentProvider } from '../config.js';

/** Port every payment provider adapter must implement. Raw card data never touches our servers. */
export interface PaymentProvider {
  readonly name: string;
  readonly status: 'live' | 'sandbox' | 'simulated' | 'awaiting-credentials';
  createIntent(a: { orderId: string; amountCents: number; currency: string; idempotencyKey: string }): Promise<{ providerRef: string }>;
}

/** Simulated adapter for development/tests. Moves no money. Clearly labelled so it can't be mistaken for a live integration. */
const simulated: PaymentProvider = {
  name: 'simulated', status: 'simulated',
  async createIntent() { return { providerRef: 'sim_' + randomBytes(12).toString('hex') }; },
};

export function getProvider(): PaymentProvider | null {
  return paymentProvider === 'simulated' ? simulated : null;
}
