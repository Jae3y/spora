import 'server-only';

import { kotaniConfig, kotaniMode } from '@/lib/config';
import { RAILS } from '@/lib/corridor';
import {
  initiateKotaniStkPush,
  validateWebhookPayload,
  verifyKotaniSignature,
} from '@/lib/kotani';
import {
  type CallbackVerdict,
  type IngressProvider,
  type InitiateRequest,
  type InitiateResult,
  type ProviderHealth,
  nowIso,
} from './types';

/**
 * Kotani Pay, behind the common ingress interface.
 *
 * This is an adapter, not a rewrite. The existing module keeps all the
 * behaviour -- phone normalisation, the USSD prompt text, the mock engine,
 * HMAC-SHA256 verification -- and this class only translates its shapes into
 * the canonical ones every provider shares.
 *
 * ## Why Kotani is still the architecturally right choice
 *
 * It is the only provider in this corridor that does NGN collection *and*
 * stablecoin settlement in a single hop. Paystack and Flutterwave collect
 * naira and stop there; the USDC leg is then ours to perform. Kotani is last
 * in the fallback order purely because we could not obtain credentials, not
 * because the integration is inferior.
 *
 * ## What "mock" means here, precisely
 *
 * The cryptography is real and executes on every contribution: the HMAC is
 * genuinely computed over the raw body, the idempotency ledger genuinely
 * refuses a replay, the freshness window genuinely rejects a stale callback.
 * What is *not* verified is the payload schema -- it is reconstructed from
 * Kotani's public documentation and has never been checked against their live
 * API. Mechanism faithful, schema unconfirmed. The badge says `mock` for
 * exactly that reason.
 */
export class KotaniProvider implements IngressProvider {
  readonly id = 'kotani' as const;
  readonly displayName = 'Kotani Pay';
  readonly rail = RAILS.ingress.rail;

  get configured(): boolean {
    return kotaniMode === 'live';
  }

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    const result = await initiateKotaniStkPush({
      phoneNumber: request.phoneNumber,
      amountNgn: request.amountNgn,
      cooperativeId: request.cooperativeId,
      memberId: request.memberId,
    });

    return {
      success: result.success,
      transactionId: result.transactionId,
      // Kotani pushes a prompt to the handset rather than redirecting, so
      // there is never an authorisation URL on this rail.
      status: result.status === 'PENDING_PIN' ? 'PENDING_PIN' : result.status,
      estimatedUsdc: result.estimatedUsdc,
      estimatedStroops: result.estimatedStroops,
      reference: result.reference,
      customerMessage: result.customerMessage,
      authorizationUrl: null,
      mode: result.mode,
      provider: this.id,
    };
  }

  verifyCallback(rawBody: string, headers: Headers): boolean {
    // Accept either spelling: providers differ, and a header name mismatch
    // presents identically to a forged signature if only one is checked.
    const signature =
      headers.get('x-kotani-signature') ??
      headers.get('x-signature') ??
      headers.get('x-webhook-signature');
    return verifyKotaniSignature(rawBody, signature);
  }

  parseCallback(decoded: unknown): CallbackVerdict {
    const verdict = validateWebhookPayload(decoded);
    if (!verdict.ok) {
      return { ok: false, reason: verdict.reason, status: verdict.status };
    }

    const p = verdict.payload;
    return {
      ok: true,
      settlement: {
        transactionId: p.transactionId,
        reference: p.reference,
        status: p.status,
        amountNgn: p.amount,
        currency: p.currency,
        phoneNumber: p.phoneNumber,
        transferRef: p.transferRef ?? null,
        timestamp: p.timestamp ?? nowIso(),
        provider: this.id,
      },
    };
  }

  async health(): Promise<ProviderHealth> {
    const checkedAt = nowIso();

    if (!kotaniConfig.apiKey) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail:
          'No Kotani credentials. Running the documented mock: HMAC, idempotency ' +
          'and freshness all execute for real; the counterparty does not.',
        checkedAt,
      };
    }

    if (!kotaniConfig.webhookSecret) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail:
          'Kotani API key present but no webhook secret. Accepting unverifiable ' +
          'callbacks would be strictly worse than the mock, so the mock is used.',
        checkedAt,
      };
    }

    try {
      const response = await fetch(`${kotaniConfig.baseUrl}/health`, {
        headers: { Authorization: `Bearer ${kotaniConfig.apiKey}` },
        signal: AbortSignal.timeout(8_000),
        cache: 'no-store',
      });
      return {
        reachable: true,
        authenticated: response.ok,
        status: response.status,
        detail: response.ok
          ? `Authenticated against ${kotaniConfig.baseUrl}.`
          : `Kotani answered HTTP ${response.status}.`,
        checkedAt,
      };
    } catch (cause) {
      return {
        reachable: false,
        authenticated: false,
        status: null,
        detail: `Could not reach Kotani: ${(cause as Error).message}`,
        checkedAt,
      };
    }
  }
}
