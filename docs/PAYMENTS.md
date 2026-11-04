# Payments: provider research, recommendation and build plan

Status: **research only. No real payment provider is integrated.** Checkout runs on a clearly labelled simulated provider in development and refuses to take orders in production (`payments_not_configured`).

## What I could and could not verify

The sandbox could search the web but could not open `docs.stripe.com` (blocked by the session's network allowlist), so the findings below come from search-result summaries, not from reading Stripe's documentation end to end. Treat each item as a lead to confirm, not a fact to build on.

| Claim | Basis | Confidence |
|---|---|---|
| Stripe lists Canada among regions that support *separate charges and transfers* | Stripe docs excerpt returned by search | Medium: confirm on the live page |
| Stripe Connect **Express** accounts (Stripe-hosted seller onboarding and identity checks) are available in Canada | Search summary; it also said to contact Stripe to confirm per country | Medium |
| *Destination charges* = the platform creates the charge and funds move to the seller's connected account in one step | Stripe docs excerpt | High |
| With separate charges and transfers the platform takes its fee by transferring less than it collected | Stripe docs excerpt | High |
| Stripe advises separate charges and transfers only when the platform is responsible for connected accounts' negative balances | Stripe docs excerpt | Medium |
| **Helcim** has a marketplace or "split to sellers" API for Canadian platforms | **Nothing found.** Helcim's "split payments" material is about a customer splitting a bill, not a platform paying sellers | Not supported by evidence |

Not checked at all: Stripe's Canadian pricing and Connect fees, payout timing, how disputes and refunds behave under each charge type, restrictions on seller categories, Canadian Express onboarding requirements, and whether a Canada-based platform may have sellers outside Canada.

## Recommendation

**Stripe Connect with Express accounts.**

- Today's checkout has **one seller per order**, which fits **destination charges** with an `application_fee_amount` for the platform fee. It is the simplest model and lets Stripe handle seller identity verification and tax forms.
- When a multi-seller cart is built, move to **separate charges and transfers** (one customer payment, several seller transfers). The order model already separates a customer order from per-seller money (ledger entries are per order and tenant).
- Helcim should only be reconsidered if Helcim confirms **in writing** that it supports platform payouts to sub-merchants. Nothing found suggests it does.

This is a recommendation, not a decision. It needs the owner's choice plus a call or email with Stripe to confirm the open questions below.

## Questions to put to Stripe before building

1. Can a Canadian platform onboard Canadian sellers on Express accounts, and what do sellers have to provide (individuals, sole proprietors, corporations)?
2. Fees: card processing, Connect account fees, payout fees, and how the platform's own fee is charged. Is anything per active seller per month?
3. For destination charges, who is liable for refunds and chargebacks, and can the platform recover disputed amounts from the seller's balance?
4. Payout schedule and reserves for brand-new sellers.
5. Are any of our planned categories (fragrance, cosmetics, supplements, made-to-order goods) restricted or high-risk?
6. Test-mode behaviour for Express onboarding, disputes and refunds, and how to simulate each.
7. Does Stripe support selling to customers in other provinces with our tax-inclusive totals (we compute tax ourselves; Stripe receives a final amount)?

## What already exists in the code

- `PaymentProvider` port (`createIntent`, `refund`) with the simulated adapter; checkout, refunds and the unfulfilled-payment flow already go through it.
- **Idempotent settlement**: `settlePayment(providerRef, outcome)` is safe to call repeatedly, handles late payments after stock is gone, and writes a balanced ledger (cash, platform fee, tax payable, seller payable).
- Refunds with exact fee and tax return, an idempotency key, and an append-only record.
- Sales tax, order totals including tax, and a payments table keyed by `(provider, provider_ref)`.

## What must be built (in this order)

1. **Adapter + hosted card fields.** Create the PaymentIntent server-side; collect card details only in Stripe-hosted fields so raw card data never touches our servers (PCI scope stays minimal).
2. **Seller onboarding.** A `payment_accounts` table (tenant, provider account id, `charges_enabled`, `payouts_enabled`, requirements due). Sellers cannot take card payments until the provider says charges are enabled. Show the status and "finish verification" link on the seller dashboard.
3. **Webhooks.** A raw-body endpoint with **signature verification**, an inbox table for exactly-once processing, and handlers for payment succeeded/failed, refund updates, account updates, and disputes. `settlePayment` already provides the idempotent core.
4. **Disputes.** A disputes table, a seller and admin queue, ledger entries for the disputed amount and fees, and evidence deadlines.
5. **Payout reconciliation.** Match provider payout reports to ledger `seller_payable` and flag differences (the admin overview already surfaces unresolved refunds; reconciliation needs its own screen).
6. **Refund hardening.** Today the provider call runs inside the order's database transaction. Switch to record-intent first, call the provider, then record the result, with a reconciliation job for crashes in between.
7. **Fees and subscription billing** on top.

## Acceptance tests to run in provider test mode before any real money

- A successful payment settles once even if the webhook is delivered three times.
- A webhook with a bad signature is rejected; a replay of an old signed webhook is rejected or harmless.
- A payment that succeeds after the browser closed still settles the order.
- A failed card releases the reserved stock.
- A partial and a full refund both reach the customer and balance the ledger to the cent, including tax.
- A seller who has not finished onboarding cannot check out with a card.
- A dispute opens a queue entry and moves the right amounts.
- Payout totals reconcile with the ledger for a test period.

## Decisions needed from the owner

1. Provider (recommendation above), and sign-off after the Stripe call.
2. Who bears chargeback risk (platform or seller) and how sellers are told.
3. The real fee model. Check it against processing costs: card fees can leave very little margin on small orders under a 3% platform fee.
4. Payout timing and any reserve for new sellers.
5. Whether sellers outside Canada are in scope.

Sources used: Stripe documentation pages on [separate charges and transfers](https://docs.stripe.com/connect/marketplace/tasks/accept-payment/separate-charges-and-transfers), [Connect charges](https://docs.stripe.com/connect/charges), and [application fees](https://docs.stripe.com/connect/application-fees) (as summarised by search, not read directly), and Helcim's [split payment guide](https://www.helcim.com/guides/what-are-split-payments/).
