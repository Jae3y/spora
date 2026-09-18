import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { paystackConfig } from '@/lib/config';
import { fromStroops, ngnToStroops } from '@/lib/money';
import {
  type CallbackVerdict,
  type IngressProvider,
  type InitiateRequest,
  type InitiateResult,
  type ProviderHealth,
  nowIso,
} from './types';

/**
 * Paystack naira collection.
 *
 * ## Why Paystack is here
 *
 * It is the one Nigerian collection rail whose credentials are genuinely
 * self-serve: an email signup yields working `sk_test_`/`pk_test_` keys with
 * no business registration, which means a live third-party integration is
 * reachable in an hour rather than in a week of KYB.
 *
 * ## Two deviations from Kotani worth knowing
 *
 * 1. **Kobo, not naira.** Every amount on the Paystack API is in the minor
 *    unit. Sending `316000` when you meant ₦316,000 charges the payer ₦3,160.
 *    The conversion happens once, here, rather than at each call site.
 *
 * 2. **HMAC-SHA512 with the secret key itself.** Paystack does not issue a
 *    separate webhook secret -- the signing key *is* `sk_test_…`, and the
 *    digest is SHA-512, not SHA-256. Reusing the Kotani verifier against a
 *    Paystack callback fails every time, and the failure looks exactly like an
 *    attack in the logs.
 *
 * ## What is not real in test mode
 *
 * Test keys move no money. The HTTP calls, the redirect, the webhook and its
 * signature are all genuinely Paystack's; the settlement behind them is not.
 * The rail badge says so.
 */

const BASE_URL = 'https://api.paystack.co';

interface PaystackInitializeResponse {
  status: boolean;
  message?: string;
  data?: { authorization_url?: string; access_code?: string; reference?: string };
}

export class PaystackProvider implements IngressProvider {
  readonly id = 'paystack' as const;
  readonly displayName = 'Paystack';
  readonly rail = 'NIBSS transfer / card / USSD';

  get configured(): boolean {
    return Boolean(paystackConfig.secretKey);
  }

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    const reference = buildReference(request.cooperativeId, request.memberId);
    const stroops = ngnToStroops(request.amountNgn);

    const base = {
      reference,
      estimatedStroops: stroops.toString(),
      estimatedUsdc: fromStroops(stroops),
      provider: this.id,
    };

    if (!this.configured) {
      return {
        ...base,
        success: false,
        transactionId: '',
        status: 'FAILED',
        customerMessage: 'Paystack is selected but no secret key is configured.',
        authorizationUrl: null,
        mode: 'mock',
      };
    }

    // Paystack requires an email. A cooperative member authorising over USSD
    // has no reason to have given one, so a stable per-member address is
    // derived instead -- stable because Paystack keys its customer record on
    // it, and a random address per attempt would fragment one farmer into
    // eight customers.
    const email = request.email ?? `${request.memberId.toLowerCase()}@members.spora.africa`;

    try {
      const response = await fetch(`${BASE_URL}/transaction/initialize`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${paystackConfig.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          email,
          // Kobo. See the note above -- this factor is the single easiest way
          // to undercharge a payer by 100x.
          amount: Math.round(request.amountNgn * 100),
          currency: 'NGN',
          reference,
          channels: ['bank_transfer', 'ussd', 'card'],
          metadata: {
            cooperativeId: request.cooperativeId,
            memberId: request.memberId,
            memberName: request.memberName ?? null,
            phoneNumber: request.phoneNumber,
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const json = (await response.json()) as PaystackInitializeResponse;

      if (!response.ok || !json.status || !json.data?.authorization_url) {
        return {
          ...base,
          success: false,
          transactionId: '',
          status: 'FAILED',
          customerMessage:
            json.message ?? `Paystack refused the charge (HTTP ${response.status}).`,
          authorizationUrl: null,
          mode: 'live',
        };
      }

      return {
        ...base,
        success: true,
        transactionId: json.data.access_code ?? json.data.reference ?? reference,
        status: 'PENDING_REDIRECT',
        customerMessage:
          'Authorise the transfer on the Paystack page, then return here. ' +
          'Settlement is credited when Paystack calls back.',
        authorizationUrl: json.data.authorization_url,
        mode: 'live',
      };
    } catch (cause) {
      return {
        ...base,
        success: false,
        transactionId: '',
        status: 'FAILED',
        customerMessage: `Could not reach Paystack: ${(cause as Error).message}`,
        authorizationUrl: null,
        mode: 'live',
      };
    }
  }

  /**
   * `x-paystack-signature` is HMAC-SHA512 of the raw body, keyed with the
   * secret key. There is no separate webhook secret to configure.
   */
  verifyCallback(rawBody: string, headers: Headers): boolean {
    const provided = headers.get('x-paystack-signature');
    if (!provided || !paystackConfig.secretKey) return false;

    const expected = createHmac('sha512', paystackConfig.secretKey).update(rawBody).digest();
    const given = Buffer.from(provided.trim(), 'hex');

    // Length is compared first: `timingSafeEqual` throws on a mismatch rather
    // than returning false, which would surface as a 500 instead of a 401.
    if (given.length !== expected.length) return false;
    return timingSafeEqual(given, expected);
  }

  parseCallback(decoded: unknown): CallbackVerdict {
    if (typeof decoded !== 'object' || decoded === null) {
      return { ok: false, reason: 'Body is not a JSON object', status: 400 };
    }
    const envelope = decoded as Record<string, unknown>;
    const event = typeof envelope.event === 'string' ? envelope.event : '';
    const data = envelope.data as Record<string, unknown> | undefined;

    if (!data || typeof data !== 'object') {
      return { ok: false, reason: 'Callback has no data object', status: 400 };
    }

    const reference = typeof data.reference === 'string' ? data.reference : null;
    if (!reference) {
      return { ok: false, reason: 'Callback has no reference', status: 400 };
    }

    // Paystack signs and delivers every event type on the same endpoint. A
    // `charge.failed` is a legitimate, correctly-signed message -- it simply
    // must not credit the escrow.
    const status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED' =
      event === 'charge.success' && data.status === 'success'
        ? 'SUCCESS'
        : event === 'refund.processed' || event === 'charge.reversed'
          ? 'REVERSED'
          : event === 'charge.failed' || data.status === 'failed'
            ? 'FAILED'
            : 'PENDING';

    const koboAmount = typeof data.amount === 'number' ? data.amount : 0;
    const customer = data.customer as Record<string, unknown> | undefined;
    const metadata = data.metadata as Record<string, unknown> | undefined;

    return {
      ok: true,
      settlement: {
        transactionId: String(data.id ?? reference),
        reference,
        status,
        // Back out of the minor unit exactly once, here.
        amountNgn: koboAmount / 100,
        currency: typeof data.currency === 'string' ? data.currency : 'NGN',
        phoneNumber:
          (typeof metadata?.phoneNumber === 'string' ? metadata.phoneNumber : null) ??
          (typeof customer?.phone === 'string' ? customer.phone : '') ??
          '',
        transferRef:
          typeof data.receipt_number === 'string'
            ? data.receipt_number
            : typeof data.reference === 'string'
              ? data.reference
              : null,
        timestamp: typeof data.paid_at === 'string' ? data.paid_at : nowIso(),
        provider: this.id,
      },
    };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = nowIso();
    if (!this.configured) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail: 'No Paystack secret key configured.',
        checkedAt,
      };
    }

    try {
      // Cheapest authenticated read Paystack exposes: no body, no side effects.
      const response = await fetch(`${BASE_URL}/bank?currency=NGN&perPage=1`, {
        headers: { Authorization: `Bearer ${paystackConfig.secretKey}` },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });

      const testMode = paystackConfig.secretKey?.startsWith('sk_test_') ?? false;
      return {
        reachable: true,
        authenticated: response.ok,
        status: response.status,
        detail: response.ok
          ? `Authenticated against Paystack${testMode ? ' (test mode — no funds move)' : ' (LIVE mode)'}.`
          : `Paystack rejected the key with HTTP ${response.status}.`,
        checkedAt,
      };
    } catch (cause) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail: `Could not reach Paystack: ${(cause as Error).message}`,
        checkedAt,
      };
    }
  }
}

/**
 * Reference format, shared across providers.
 *
 * Deliberately *not* delimited by hyphens on parse: both the cooperative id
 * and the member id contain hyphens themselves, so splitting on `-` cannot
 * recover the parts. Downstream code keys on the phone number instead, and
 * this string is an opaque correlation id.
 */
function buildReference(cooperativeId: string, memberId: string): string {
  const entropy = Math.random().toString(36).slice(2, 8).toUpperCase();
  return `SPORA-${cooperativeId}-${memberId}-${entropy}`;
}
