import 'server-only';

import { timingSafeEqual } from 'node:crypto';
import { appConfig, flutterwaveConfig } from '@/lib/config';
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
 * Flutterwave naira collection.
 *
 * ## Why it is here
 *
 * Second self-serve fallback behind Paystack. Test credentials arrive on email
 * signup, and it reaches the same NIBSS rails, so if one provider's signup
 * gate refuses us the other usually will not.
 *
 * ## A security note that must not be glossed over
 *
 * Flutterwave's `verif-hash` is **not** a signature. It is a static shared
 * secret that the sender echoes verbatim in a header -- there is no HMAC and
 * nothing is bound to the request body.
 *
 * The practical consequences are real, and pretending otherwise would be
 * worse than the weakness itself:
 *
 * - Anyone who learns the hash can forge an arbitrary callback, because the
 *   header does not commit to the payload at all.
 * - A body can be modified in transit without invalidating the header.
 *
 * So this provider leans much harder on the two defences that do not depend on
 * the provider: the idempotency ledger and the freshness window. The
 * comparison below is still constant-time -- a static secret is exactly the
 * kind of value a timing oracle recovers byte by byte.
 */

const BASE_URL = 'https://api.flutterwave.com/v3';

interface FlutterwavePaymentResponse {
  status?: string;
  message?: string;
  data?: { link?: string };
}

export class FlutterwaveProvider implements IngressProvider {
  readonly id = 'flutterwave' as const;
  readonly displayName = 'Flutterwave';
  readonly rail = 'NIBSS transfer / card / USSD';

  get configured(): boolean {
    return Boolean(flutterwaveConfig.secretKey);
  }

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    const reference = `SPORA-${request.cooperativeId}-${request.memberId}-${Math.random()
      .toString(36)
      .slice(2, 8)
      .toUpperCase()}`;
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
        customerMessage: 'Flutterwave is selected but no secret key is configured.',
        authorizationUrl: null,
        mode: 'mock',
      };
    }

    try {
      const response = await fetch(`${BASE_URL}/payments`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${flutterwaveConfig.secretKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          tx_ref: reference,
          // Flutterwave takes major units, unlike Paystack's kobo. The two
          // providers differing here is precisely why the conversion lives
          // inside each adapter rather than at the call site.
          amount: Math.round(request.amountNgn),
          currency: 'NGN',
          redirect_url: `${appConfig.host}/cooperative?settled=1`,
          payment_options: 'banktransfer,ussd,card',
          customer: {
            email: request.email ?? `${request.memberId.toLowerCase()}@members.spora.africa`,
            phonenumber: request.phoneNumber,
            name: request.memberName ?? request.memberId,
          },
          meta: {
            cooperativeId: request.cooperativeId,
            memberId: request.memberId,
            phoneNumber: request.phoneNumber,
          },
          customizations: {
            title: 'Spora Climate Escrow',
            description: 'Cooperative input contribution',
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });

      const json = (await response.json()) as FlutterwavePaymentResponse;

      if (!response.ok || json.status !== 'success' || !json.data?.link) {
        return {
          ...base,
          success: false,
          transactionId: '',
          status: 'FAILED',
          customerMessage:
            json.message ?? `Flutterwave refused the charge (HTTP ${response.status}).`,
          authorizationUrl: null,
          mode: 'live',
        };
      }

      return {
        ...base,
        success: true,
        transactionId: reference,
        status: 'PENDING_REDIRECT',
        customerMessage:
          'Complete the transfer on the Flutterwave page. The escrow is credited ' +
          'when the callback is verified.',
        authorizationUrl: json.data.link,
        mode: 'live',
      };
    } catch (cause) {
      return {
        ...base,
        success: false,
        transactionId: '',
        status: 'FAILED',
        customerMessage: `Could not reach Flutterwave: ${(cause as Error).message}`,
        authorizationUrl: null,
        mode: 'live',
      };
    }
  }

  /**
   * Compare the echoed secret, in constant time.
   *
   * `rawBody` is unused and that is the whole problem with this scheme -- the
   * header commits to nothing about the request. It is kept in the signature
   * so the interface stays uniform and so this comment sits where a reader
   * looking for the body binding will find it.
   */
  verifyCallback(_rawBody: string, headers: Headers): boolean {
    const provided = headers.get('verif-hash');
    const expected = flutterwaveConfig.webhookHash;
    if (!provided || !expected) return false;

    const a = Buffer.from(provided.trim(), 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  parseCallback(decoded: unknown): CallbackVerdict {
    if (typeof decoded !== 'object' || decoded === null) {
      return { ok: false, reason: 'Body is not a JSON object', status: 400 };
    }
    const envelope = decoded as Record<string, unknown>;
    const data = envelope.data as Record<string, unknown> | undefined;
    if (!data) {
      return { ok: false, reason: 'Callback has no data object', status: 400 };
    }

    const reference = typeof data.tx_ref === 'string' ? data.tx_ref : null;
    if (!reference) {
      return { ok: false, reason: 'Callback has no tx_ref', status: 400 };
    }

    const raw = typeof data.status === 'string' ? data.status.toLowerCase() : '';
    const status: 'SUCCESS' | 'FAILED' | 'PENDING' | 'REVERSED' =
      raw === 'successful'
        ? 'SUCCESS'
        : raw === 'failed'
          ? 'FAILED'
          : raw === 'reversed' || raw === 'refunded'
            ? 'REVERSED'
            : 'PENDING';

    const customer = data.customer as Record<string, unknown> | undefined;
    const meta = (envelope.meta ?? data.meta) as Record<string, unknown> | undefined;

    return {
      ok: true,
      settlement: {
        transactionId: String(data.id ?? reference),
        reference,
        status,
        amountNgn: typeof data.amount === 'number' ? data.amount : 0,
        currency: typeof data.currency === 'string' ? data.currency : 'NGN',
        phoneNumber:
          (typeof meta?.phoneNumber === 'string' ? meta.phoneNumber : null) ??
          (typeof customer?.phone_number === 'string' ? customer.phone_number : '') ??
          '',
        transferRef: typeof data.flw_ref === 'string' ? data.flw_ref : null,
        timestamp: typeof data.created_at === 'string' ? data.created_at : nowIso(),
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
        detail: 'No Flutterwave secret key configured.',
        checkedAt,
      };
    }

    try {
      const response = await fetch(`${BASE_URL}/banks/NG`, {
        headers: { Authorization: `Bearer ${flutterwaveConfig.secretKey}` },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });

      const testMode = flutterwaveConfig.secretKey?.includes('_TEST') ?? false;
      const hashMissing = !flutterwaveConfig.webhookHash;

      return {
        reachable: true,
        authenticated: response.ok,
        status: response.status,
        detail: !response.ok
          ? `Flutterwave rejected the key with HTTP ${response.status}.`
          : hashMissing
            ? 'Authenticated, but FLUTTERWAVE_WEBHOOK_HASH is unset — callbacks ' +
              'cannot be verified and will be refused.'
            : `Authenticated against Flutterwave${testMode ? ' (test mode — no funds move)' : ' (LIVE mode)'}.`,
        checkedAt,
      };
    } catch (cause) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail: `Could not reach Flutterwave: ${(cause as Error).message}`,
        checkedAt,
      };
    }
  }
}
