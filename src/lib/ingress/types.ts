import 'server-only';

/**
 * Provider-agnostic naira ingress.
 *
 * ## Why an interface and not just Kotani
 *
 * Every Nigerian collection rail is gated behind some form of verification,
 * and which gate opens for a given team on a given day is not predictable.
 * Kotani and Yellow Card want business documents. Paystack and Flutterwave
 * hand out test credentials on an email signup. Cowrie needs anchor
 * onboarding.
 *
 * Binding the corridor to one of them makes the whole product hostage to that
 * provider's signup flow. Behind this interface, the provider is a
 * configuration value: the escrow, the 90/10 split, the idempotency ledger and
 * the settlement path never change, because none of them care who collected
 * the naira.
 *
 * ## What each provider must supply
 *
 * The three capabilities below are the entire surface the corridor needs, and
 * they map onto what every collection rail actually does:
 *
 *   1. **initiate** -- ask the payer for money, however that provider asks.
 *   2. **verifyCallback** -- prove an inbound callback really came from them.
 *   3. **parseCallback** -- translate their payload into our canonical shape.
 *
 * Note that (2) and (3) are separate. A correctly signed but malformed payload
 * means the provider changed their contract; an unsigned payload means someone
 * is attacking us. Collapsing them into one boolean would make those two
 * indistinguishable in the logs, and they need completely different responses.
 */

export type ProviderId = 'kotani' | 'paystack' | 'flutterwave';

export interface InitiateRequest {
  /** E.164, e.g. `+2348031234567`. */
  phoneNumber: string;
  amountNgn: number;
  cooperativeId: string;
  memberId: string;
  memberName?: string;
  /** Email, required by card-first providers. Derived when absent. */
  email?: string;
}

export interface InitiateResult {
  success: boolean;
  /** Provider's own identifier for the attempt. */
  transactionId: string;
  status: 'PENDING_PIN' | 'PENDING_REDIRECT' | 'PROCESSING' | 'FAILED';
  estimatedUsdc: string;
  estimatedStroops: string;
  /** Our reference, echoed back by the provider on the callback. */
  reference: string;
  /** Text the payer sees -- a USSD prompt, or an instruction to continue. */
  customerMessage: string;
  /**
   * Hosted page the payer must visit, for providers that collect by redirect
   * rather than by pushing a prompt to the handset. Null for USSD rails.
   */
  authorizationUrl: string | null;
  mode: 'live' | 'mock';
  provider: ProviderId;
}

/**
 * The canonical settlement every provider is translated into.
 *
 * Downstream code -- the ledger, the escrow credit, the audit trail -- reads
 * only this. That is what makes swapping providers a configuration change
 * rather than a migration.
 */
export interface CanonicalSettlement {
  transactionId: string;
  reference: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
  amountNgn: number;
  currency: string;
  phoneNumber: string;
  /** Rail-level reference: a NIBSS session id, a provider receipt number. */
  transferRef: string | null;
  /** ISO 8601. Used for the freshness window. */
  timestamp: string;
  provider: ProviderId;
}

export type CallbackVerdict =
  | { ok: true; settlement: CanonicalSettlement }
  | { ok: false; reason: string; status: number };

export interface ProviderHealth {
  reachable: boolean;
  authenticated: boolean;
  status: number | null;
  detail: string;
  checkedAt: string;
}

export interface IngressProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  /** The underlying rail, for the interface to state plainly. */
  readonly rail: string;
  /** True when real credentials are present and this is not the mock path. */
  readonly configured: boolean;

  initiate(request: InitiateRequest): Promise<InitiateResult>;

  /**
   * Verify a callback against the raw request body.
   *
   * `rawBody` must be the exact bytes that arrived. Re-serialising JSON
   * reorders keys and normalises whitespace, producing a different byte
   * sequence and therefore a different MAC -- a verification that "sometimes
   * fails for no reason" is almost always this bug.
   */
  verifyCallback(rawBody: string, headers: Headers): boolean;

  parseCallback(decoded: unknown): CallbackVerdict;

  health(): Promise<ProviderHealth>;
}

/** Providers whose callbacks carry no timestamp get one on arrival. */
export function nowIso(): string {
  return new Date().toISOString();
}
