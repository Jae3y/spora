import 'server-only';

/**
 * Kotani Pay -- Nigerian ingress rail.
 *
 * Members of the Dawakin Kudu cooperative contribute in Naira. Nigeria is not
 * an bank transfer market: money moves over NIBSS instant transfer and USSD, and the
 * wallet apps farmers actually hold -- OPay, PalmPay, Moniepoint, Kuda -- are
 * built on top of those rails. Kotani aggregates them and settles to native
 * Stellar USDC.
 *
 * ## Threat model for the webhook
 *
 * The callback endpoint is public and its side effect is *minting escrow
 * credit*. Three distinct attacks have to be closed, and each needs a
 * different defence:
 *
 * | Attack                       | Defence                                    |
 * |------------------------------|--------------------------------------------|
 * | Forged callback              | HMAC-SHA256 over the raw body              |
 * | Replayed genuine callback    | Idempotency ledger keyed on transaction id |
 * | Captured-then-delayed replay | Timestamp freshness window                 |
 *
 * A signature alone stops none of the last two: a replayed message carries a
 * perfectly valid signature, because it *is* the original message.
 */

import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { kotaniConfig, kotaniMode, appConfig } from '@/lib/config';
import { ngnToStroops, fromStroops } from '@/lib/money';
import { PHONE, RAILS } from '@/lib/corridor';

export interface StkPushRequest {
  /** E.164, e.g. `+2348031234567`. */
  phoneNumber: string;
  amountNgn: number;
  cooperativeId: string;
  memberId: string;
}

export interface StkPushResult {
  success: boolean;
  transactionId: string;
  status: 'PENDING_PIN' | 'PROCESSING' | 'FAILED';
  estimatedUsdc: string;
  estimatedStroops: string;
  reference: string;
  /** Carrier-facing prompt text the handset displays. */
  customerMessage: string;
  mode: 'live' | 'mock';
}

export interface KotaniWebhookPayload {
  transactionId: string;
  reference: string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED';
  amount: number;
  currency: string;
  phoneNumber: string;
  /** NIBSS session reference, e.g. `NIB240918XKQ2`. */
  transferRef?: string;
  settledUsdc?: string;
  timestamp: string;
}

export class KotaniError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_PHONE' | 'INVALID_AMOUNT' | 'DISPATCH_FAILED' | 'NOT_CONFIGURED',
  ) {
    super(message);
    this.name = 'KotaniError';
  }
}

/**
 * NIBSS instant-transfer bounds, in Naira.
 *
 * Validating locally turns a rejected transfer -- which a farmer experiences
 * as a silent non-event on their handset -- into an immediate, explicable
 * error.
 */
export const TRANSFER_MIN_NGN = 100;
export const TRANSFER_MAX_NGN = 5_000_000;

/**
 * Normalise a Nigerian number to E.164.
 *
 * Accepts the four forms people actually type -- `08031234567`,
 * `8031234567`, `2348031234567`, `+2348031234567` -- because rejecting a
 * locally-written number would exclude exactly the farmers this product
 * exists to serve. A woman in Dawakin Kudu writes her number starting with a
 * zero; the software should meet her there.
 */
export function normaliseNigerianPhone(input: string): string {
  const digits = input.replace(/[\s()-]/g, '');
  let national: string;

  if (/^\+234\d{10}$/.test(digits)) national = digits.slice(4);
  else if (/^234\d{10}$/.test(digits)) national = digits.slice(3);
  else if (/^0\d{10}$/.test(digits)) national = digits.slice(1);
  else if (/^\d{10}$/.test(digits)) national = digits;
  else throw new KotaniError(`Not a valid Nigerian mobile number: ${input}`, 'INVALID_PHONE');

  // Every Nigerian mobile prefix is 70, 80, 81, 90 or 91 followed by 8 digits.
  const prefix = national.slice(0, 2);
  if (!(PHONE.validPrefixes as readonly string[]).includes(prefix)) {
    throw new KotaniError(
      `${prefix} is not a Nigerian mobile prefix (expected ${PHONE.validPrefixes.join(', ')})`,
      'INVALID_PHONE',
    );
  }
  return `${PHONE.countryCode}${national}`;
}

/** Deterministic, collision-resistant reference for reconciliation. */
export function buildReference(cooperativeId: string, memberId: string): string {
  return `SPORA-${cooperativeId}-${memberId}-${Date.now().toString(36).toUpperCase()}`;
}

/**
 * Dispatch an STK push, prompting the member's handset for their bank transfer PIN.
 *
 * In mock mode this returns an authentically-shaped response after a realistic
 * delay, so the dashboard's push-notification choreography is exercised
 * exactly as it would be against the live rail.
 */
export async function initiateKotaniStkPush(req: StkPushRequest): Promise<StkPushResult> {
  const phoneNumber = normaliseNigerianPhone(req.phoneNumber);

  if (!Number.isFinite(req.amountNgn) || req.amountNgn < TRANSFER_MIN_NGN) {
    throw new KotaniError(
      `NIBSS transfers start at NGN ${TRANSFER_MIN_NGN}; got ${req.amountNgn}`,
      'INVALID_AMOUNT',
    );
  }
  if (req.amountNgn > TRANSFER_MAX_NGN) {
    throw new KotaniError(
      `NIBSS caps a single instant transfer at NGN ${TRANSFER_MAX_NGN.toLocaleString('en-US')}`,
      'INVALID_AMOUNT',
    );
  }

  const reference = buildReference(req.cooperativeId, req.memberId);
  const stroops = ngnToStroops(req.amountNgn);

  if (kotaniMode === 'mock') {
    await simulateLatency(900, 1_600);
    return {
      success: true,
      transactionId: `KTN-${Date.now()}-${Math.floor(Math.random() * 1000)
        .toString()
        .padStart(3, '0')}`,
      status: 'PENDING_PIN',
      estimatedUsdc: fromStroops(stroops),
      estimatedStroops: stroops.toString(),
      reference,
      customerMessage:
        `Dial ${RAILS.ingress.ussdCode} or approve in your wallet app to send ` +
        `NGN ${req.amountNgn.toLocaleString('en-US')} to SPORA COOPERATIVE POOL, ref ${reference}.`,
      mode: 'mock',
    };
  }

  try {
    const response = await fetch(`${kotaniConfig.baseUrl}/payments/stk-push`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${kotaniConfig.apiKey}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': reference,
      },
      body: JSON.stringify({
        phone_number: phoneNumber,
        amount: req.amountNgn,
        currency: 'NGN',
        callback_url: `${appConfig.host}/api/kotani/webhook`,
        reference,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '<unreadable>');
      throw new KotaniError(
        `Kotani STK push rejected with HTTP ${response.status}: ${detail.slice(0, 300)}`,
        'DISPATCH_FAILED',
      );
    }

    const data = (await response.json()) as Record<string, unknown>;
    return {
      success: true,
      transactionId: String(data.transactionId ?? data.id ?? reference),
      status: 'PENDING_PIN',
      estimatedUsdc: fromStroops(stroops),
      estimatedStroops: stroops.toString(),
      reference,
      customerMessage: String(data.customerMessage ?? 'Approve the transfer in your wallet app.'),
      mode: 'live',
    };
  } catch (cause) {
    if (cause instanceof KotaniError) throw cause;
    throw new KotaniError(
      `Kotani STK push failed: ${(cause as Error).message}`,
      'DISPATCH_FAILED',
    );
  }
}

// ---------------------------------------------------------------------------
// webhook verification
// ---------------------------------------------------------------------------

/** Reject callbacks older than this, in milliseconds. */
export const WEBHOOK_FRESHNESS_WINDOW_MS = 5 * 60 * 1_000;

export type WebhookVerdict =
  | { ok: true; payload: KotaniWebhookPayload }
  | { ok: false; reason: string; status: 400 | 401 | 409 };

/**
 * Verify a webhook's HMAC-SHA256 signature against the **raw** request body.
 *
 * The raw bytes matter: `JSON.parse` followed by `JSON.stringify` reorders
 * keys and normalises whitespace, producing a different byte sequence and
 * therefore a different MAC. Every caller must pass the body exactly as it
 * arrived on the wire.
 */
export function verifyKotaniSignature(rawBody: string, signatureHeader: string | null): boolean {
  if (!signatureHeader || !kotaniConfig.webhookSecret) return false;

  const expected = createHmac('sha256', kotaniConfig.webhookSecret).update(rawBody).digest();
  // Providers send either bare hex or a `sha256=` prefix; accept both.
  const provided = Buffer.from(signatureHeader.replace(/^sha256=/i, '').trim(), 'hex');

  // Length must be compared *before* `timingSafeEqual`, which throws rather
  // than returning false on a length mismatch.
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(provided, expected);
}

/** Sign a body with the shared secret -- used by the mock engine and by tests. */
export function signKotaniPayload(rawBody: string, secret?: string): string {
  const key = secret ?? kotaniConfig.webhookSecret ?? 'spora-mock-webhook-secret';
  return createHmac('sha256', key).update(rawBody).digest('hex');
}

/**
 * Validate the shape and freshness of a decoded callback.
 *
 * Structural validation is separate from signature verification on purpose: a
 * correctly-signed but malformed payload indicates a provider-side contract
 * change, and should be distinguishable in logs from an attack.
 */
export function validateWebhookPayload(value: unknown): WebhookVerdict {
  if (typeof value !== 'object' || value === null) {
    return { ok: false, reason: 'Body is not a JSON object', status: 400 };
  }
  const p = value as Record<string, unknown>;

  const transactionId = typeof p.transactionId === 'string' ? p.transactionId : null;
  const reference = typeof p.reference === 'string' ? p.reference : null;
  const status = typeof p.status === 'string' ? p.status.toUpperCase() : null;
  const amount = typeof p.amount === 'number' ? p.amount : Number(p.amount);
  const timestamp = typeof p.timestamp === 'string' ? p.timestamp : null;

  if (!transactionId) return { ok: false, reason: 'Missing transactionId', status: 400 };
  if (!reference) return { ok: false, reason: 'Missing reference', status: 400 };
  if (!status || !['SUCCESS', 'FAILED', 'PENDING', 'REVERSED'].includes(status)) {
    return { ok: false, reason: `Unrecognised status ${JSON.stringify(p.status)}`, status: 400 };
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'Missing or non-positive amount', status: 400 };
  }
  if (!timestamp) return { ok: false, reason: 'Missing timestamp', status: 400 };

  const age = Date.now() - Date.parse(timestamp);
  if (!Number.isFinite(age)) {
    return { ok: false, reason: 'Unparseable timestamp', status: 400 };
  }
  // Reject stale callbacks, and also callbacks dated meaningfully in the
  // future -- both indicate replay or a badly skewed clock rather than a
  // genuine settlement.
  if (age > WEBHOOK_FRESHNESS_WINDOW_MS) {
    return { ok: false, reason: `Callback is ${Math.round(age / 1000)}s stale`, status: 401 };
  }
  if (age < -WEBHOOK_FRESHNESS_WINDOW_MS) {
    return { ok: false, reason: 'Callback timestamp is in the future', status: 401 };
  }

  return {
    ok: true,
    payload: {
      transactionId,
      reference,
      status: status as KotaniWebhookPayload['status'],
      amount,
      currency: typeof p.currency === 'string' ? p.currency : 'NGN',
      phoneNumber: typeof p.phoneNumber === 'string' ? p.phoneNumber : '',
      transferRef: typeof p.transferRef === 'string' ? p.transferRef : undefined,
      settledUsdc: typeof p.settledUsdc === 'string' ? p.settledUsdc : undefined,
      timestamp,
    },
  };
}

/**
 * Produce a signed mock callback, so the offline demo exercises the *real*
 * verification path rather than bypassing it. The signature this generates is
 * genuinely valid under the configured secret -- the webhook route cannot tell
 * it apart from Kotani's own, which is the point.
 */
export function buildMockWebhookCallback(args: {
  reference: string;
  amountNgn: number;
  phoneNumber: string;
  transactionId?: string;
  status?: KotaniWebhookPayload['status'];
}): { rawBody: string; signature: string; payload: KotaniWebhookPayload } {
  const payload: KotaniWebhookPayload = {
    transactionId: args.transactionId ?? `KTN-${randomUUID()}`,
    reference: args.reference,
    status: args.status ?? 'SUCCESS',
    amount: args.amountNgn,
    currency: 'NGN',
    phoneNumber: args.phoneNumber,
    transferRef: generateTransferRef(),
    settledUsdc: fromStroops(ngnToStroops(args.amountNgn)),
    timestamp: new Date().toISOString(),
  };
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: signKotaniPayload(rawBody), payload };
}

/** NIBSS session references are 12 characters, uppercase alphanumeric. */
function generateTransferRef(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';
  let out = '';
  for (let i = 0; i < 12; i += 1) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}

async function simulateLatency(minMs: number, maxMs: number): Promise<void> {
  if (!appConfig.simulateLatency) return;
  const delay = minMs + Math.random() * (maxMs - minMs);
  await new Promise((resolve) => setTimeout(resolve, delay));
}
