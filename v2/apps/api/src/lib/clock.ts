/** "Now" for delivery windows. EAZY_FAKE_NOW pins it in development and tests (never in production) so screens and visual tests are reproducible. */
export const now = (): Date => (process.env.EAZY_FAKE_NOW && process.env.NODE_ENV !== 'production' ? new Date(process.env.EAZY_FAKE_NOW) : new Date());
