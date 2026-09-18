import { fail, ok } from '@/lib/api';
import { kotaniMode } from '@/lib/config';
import { providerForCallback, type CanonicalSettlement } from '@/lib/ingress';
import { ngnToStroops, formatUsdc } from '@/lib/money';
import { chainMode } from '@/lib/config';
import { depositFunds } from '@/lib/soroban/escrow';
import {
  appendAuditEvent,
  creditDeposit,
  hasSeenWebhook,
  markMemberFailed,
  markWebhookSeen,
  recordMemberSettlement,
} from '@/lib/store/ledger';

/**
 * Naira ingress settlement callback.
 *
 * ## One endpoint, several providers
 *
 * The route is mounted under `/api/kotani/` for backward compatibility, but it
 * is no longer Kotani-specific. The sending provider is identified from the
 * header shape *before* verification, because each one signs differently:
 * Paystack uses HMAC-SHA512 keyed with its secret key, Kotani HMAC-SHA256 with
 * a dedicated webhook secret, Flutterwave a static echoed hash. Verifying with
 * the wrong scheme fails every time and looks exactly like an attack in the
 * logs.
 *
 * Identification is not authentication: choosing a verifier from a header
 * grants nothing, since that verifier still has to pass. An attacker can pick
 * which lock to be tested against, not whether to be tested.
 *
 * ## Order of operations is load-bearing
 *
 * ```text
 *   1. read RAW body      (before any parsing)
 *   2. verify HMAC        (over those exact bytes)
 *   3. parse + validate   (shape, freshness)
 *   4. idempotency check  (transaction id)
 *   5. credit + settle    (ledger, then chain)
 *   6. mark seen          (only after success)
 * ```
 *
 * Reading the raw body first is not stylistic. `request.json()` consumes the
 * stream, and re-serialising the parsed object produces different bytes --
 * different key order, different whitespace -- so the HMAC would never match.
 *
 * Marking the callback seen *after* the work succeeds, rather than before, is
 * the deliberate choice between the two failure modes. Marking first would
 * make a crash mid-settlement permanent: the retry is rejected as a duplicate
 * and the member's money is taken but never credited. Marking last means a
 * crash leaves the callback retryable, and Kotani will retry. Double-crediting
 * is prevented because the mark is written inside the same synchronous
 * completion path as the credit.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  // 1. Raw bytes, before anything touches them.
  const rawBody = await request.text();
  const provider = providerForCallback(request.headers);

  // 2. Authenticity, using that provider's own scheme. In mock mode the
  //    signature is still verified -- the mock engine signs with the same
  //    secret, so this path is never bypassed.
  if (!provider.verifyCallback(rawBody, request.headers)) {
    appendAuditEvent({
      category: 'ingress',
      event: 'webhook_rejected',
      summary: `Rejected a ${provider.displayName} callback with an invalid or missing signature.`,
      txHash: null,
      mode: kotaniMode,
      detail: { reason: 'signature_mismatch', provider: provider.id },
    });
    return fail('INVALID_SIGNATURE', 'Webhook signature verification failed', 401);
  }

  // 3. Shape and freshness.
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return fail('MALFORMED_JSON', 'Webhook body is not valid JSON', 400);
  }

  const verdict = provider.parseCallback(parsed);
  if (!verdict.ok) {
    // A correctly signed but malformed body means the provider changed their
    // contract. That is a different incident from a forged callback, and the
    // audit trail has to be able to tell them apart.
    appendAuditEvent({
      category: 'ingress',
      event: 'webhook_rejected',
      summary: `Rejected a signed ${provider.displayName} callback: ${verdict.reason}`,
      txHash: null,
      mode: kotaniMode,
      detail: { reason: verdict.reason, provider: provider.id, signatureValid: true },
    });
    return fail('INVALID_PAYLOAD', verdict.reason, verdict.status);
  }
  const payload: CanonicalSettlement = verdict.settlement;

  // 4. Idempotency. A genuine replay carries a genuine signature, so this is
  //    the only thing standing between a retry and a double credit.
  const seen = hasSeenWebhook(payload.transactionId);
  if (seen.seen) {
    return ok(
      { duplicate: true, transactionId: payload.transactionId, firstSeenAt: seen.at },
      { mode: kotaniMode, note: 'Callback already processed; no action taken.' },
    );
  }

  // Non-success terminal states are recorded and acknowledged. Returning a
  // non-2xx here would make Kotani retry a settlement that definitively failed.
  if (payload.status !== 'SUCCESS') {
    markWebhookSeen(payload.transactionId, payload.status);
    markMemberFailed(payload.phoneNumber);
    appendAuditEvent({
      category: 'ingress',
      event: 'ingress_not_settled',
      summary: `Naira contribution ${payload.reference} reported ${payload.status}.`,
      txHash: null,
      mode: kotaniMode,
      detail: { ...payload },
    });
    return ok({ acknowledged: true, status: payload.status }, { mode: kotaniMode });
  }

  // 5. Credit.
  const stroops = ngnToStroops(payload.amountNgn);

  const escrow = creditDeposit(stroops);
  recordMemberSettlement({
    phoneNumber: payload.phoneNumber,
    amountNgn: payload.amountNgn,
    stroops: stroops.toString(),
    transferRef: payload.transferRef,
  });

  appendAuditEvent({
    category: 'ingress',
    event: 'ingress_settled',
    summary:
      `₦ ${payload.amountNgn.toLocaleString('en-US')} from ${maskPhone(payload.phoneNumber)} settled as ` +
      `${formatUsdc(stroops)} USDC (receipt ${payload.transferRef ?? 'n/a'}).`,
    txHash: null,
    mode: kotaniMode,
    detail: {
      reference: payload.reference,
      transactionId: payload.transactionId,
      amountNgn: payload.amountNgn,
      stroops: stroops.toString(),
      transferRef: payload.transferRef,
    },
  });

  // Push the deposit on chain through the sponsored gas wallet. A chain
  // failure must not fail the webhook: the money has genuinely arrived at
  // Kotani, so rejecting the callback would make Kotani retry a settlement
  // that already happened. The discrepancy is recorded for reconciliation
  // instead.
  let chainHash: string | null = null;
  let chainError: string | null = null;

  if (chainMode === 'live') {
    try {
      const receipt = await depositFunds(stroops);
      chainHash = receipt.hash;
      appendAuditEvent({
        category: 'chain',
        event: 'deposit_funds',
        summary: `Deposited ${formatUsdc(stroops)} USDC into the escrow contract.`,
        txHash: receipt.hash,
        mode: 'live',
        detail: {
          explorerUrl: receipt.explorerUrl,
          sponsorAddress: receipt.sponsorAddress,
          totalFeeStroops: receipt.totalFeeStroops,
        },
      });
    } catch (cause) {
      chainError = (cause as Error).message;
      appendAuditEvent({
        category: 'chain',
        event: 'deposit_failed',
        summary:
          `Off-chain settlement of ${payload.reference} succeeded but the on-chain deposit ` +
          `failed; flagged for reconciliation.`,
        txHash: null,
        mode: 'live',
        detail: { error: chainError, stroops: stroops.toString() },
      });
    }
  }

  // 6. Only now is the callback considered consumed.
  markWebhookSeen(payload.transactionId, chainError ? 'SETTLED_CHAIN_PENDING' : 'SETTLED');

  return ok(
    {
      transactionId: payload.transactionId,
      reference: payload.reference,
      creditedStroops: stroops.toString(),
      creditedUsdc: formatUsdc(stroops),
      escrow,
      chain: { submitted: Boolean(chainHash), hash: chainHash, error: chainError },
    },
    { mode: kotaniMode },
  );
}

/** Never log a full mobile number; the last four digits are enough to reconcile. */
function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}
