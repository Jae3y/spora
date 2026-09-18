import { fail, fromError, ok, readJson } from '@/lib/api';
import { appConfig, kotaniMode } from '@/lib/config';
import {
  buildMockWebhookCallback,
  initiateKotaniStkPush,
  normaliseNigerianPhone,
} from '@/lib/kotani';
import { ngnToStroops } from '@/lib/money';
import { appendAuditEvent, markMemberPending } from '@/lib/store/ledger';

/**
 * NIBSS transfer dispatch, and the PIN confirmation that follows it.
 *
 * Two actions on one route because they are two halves of one interaction:
 *
 * - `initiate` sends the push and the handset displays a PIN prompt;
 * - `confirm` represents the member entering that PIN.
 *
 * In mock mode `confirm` does something deliberately roundabout: it builds a
 * genuinely HMAC-signed callback and **POSTs it to our own webhook endpoint**
 * over HTTP, rather than calling the settlement logic directly. That means the
 * offline demo exercises signature verification, freshness checking, payload
 * validation and the idempotency guard -- the entire security path -- instead
 * of tunnelling under it. A demo that bypassed those checks would prove only
 * that the happy path renders.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body) return fail('MALFORMED_JSON', 'Request body must be JSON', 400);

  const action = typeof body.action === 'string' ? body.action : 'initiate';

  try {
    if (action === 'confirm') return await confirmPin(body);
    return await initiate(body);
  } catch (error) {
    return fromError(error);
  }
}

async function initiate(body: Record<string, unknown>): Promise<Response> {
  const phoneNumber = String(body.phoneNumber ?? '');
  const amountNgn = Number(body.amountNgn);
  const cooperativeId = String(body.cooperativeId ?? 'KANO-COOP-01');
  const memberId = String(body.memberId ?? 'WALKIN');

  if (!phoneNumber) return fail('INVALID_PHONE', 'phoneNumber is required', 400);
  if (!Number.isFinite(amountNgn)) {
    return fail('INVALID_AMOUNT', 'amountNgn must be a number', 400);
  }

  const result = await initiateKotaniStkPush({
    phoneNumber,
    amountNgn,
    cooperativeId,
    memberId,
  });

  const normalised = normaliseNigerianPhone(phoneNumber);
  markMemberPending({
    phoneNumber: normalised,
    amountNgn,
    stroops: ngnToStroops(amountNgn).toString(),
    // Optional display name for a contributor who is not already on the
    // cooperative roster; ignored for known members.
    name: typeof body.memberName === 'string' ? body.memberName : undefined,
  });

  appendAuditEvent({
    category: 'ingress',
    event: 'stk_push_sent',
    summary:
      `Transfer request sent to ${maskPhone(normalised)} for ₦ ${amountNgn.toLocaleString('en-US')} ` +
      `(ref ${result.reference}).`,
    txHash: null,
    mode: result.mode,
    detail: {
      transactionId: result.transactionId,
      reference: result.reference,
      estimatedUsdc: result.estimatedUsdc,
    },
  });

  return ok(result, { mode: result.mode });
}

/**
 * Complete the push by submitting the member's PIN.
 *
 * The PIN is checked for shape only and is never stored, logged, or forwarded.
 * Real bank transfer PIN entry happens on the SIM toolkit and never transits an
 * application server at all -- this endpoint exists to drive the demo's
 * handset simulation, and treating the value as a secret regardless is the
 * only defensible way to model it.
 */
async function confirmPin(body: Record<string, unknown>): Promise<Response> {
  const reference = String(body.reference ?? '');
  const phoneNumber = String(body.phoneNumber ?? '');
  const amountNgn = Number(body.amountNgn);
  const pin = String(body.pin ?? '');
  const transactionId =
    typeof body.transactionId === 'string' ? body.transactionId : undefined;

  if (!reference) return fail('INVALID_PAYLOAD', 'reference is required', 400);
  if (!/^\d{4}$/.test(pin)) {
    return fail('INVALID_PIN', 'Wallet PINs are four digits', 400);
  }
  if (!Number.isFinite(amountNgn)) {
    return fail('INVALID_AMOUNT', 'amountNgn must be a number', 400);
  }

  if (kotaniMode === 'live') {
    // Against the live rail the member authorises on their own handset and
    // Kotani calls our webhook directly. There is nothing for us to confirm.
    return ok(
      { awaitingCarrierCallback: true, reference },
      {
        mode: 'live',
        note: 'PIN entry happens on the SIM toolkit; awaiting Kotani callback.',
      },
    );
  }

  const { rawBody, signature, payload } = buildMockWebhookCallback({
    reference,
    amountNgn,
    phoneNumber: normaliseNigerianPhone(phoneNumber),
    transactionId,
  });

  // Deliberately a real HTTP round trip through the public webhook route, so
  // the signature, freshness and idempotency checks all actually run.
  const response = await fetch(`${appConfig.host}/api/kotani/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Kotani-Signature': signature,
    },
    body: rawBody,
  });

  const settlement = await response.json().catch(() => null);

  if (!response.ok) {
    return fail(
      'WEBHOOK_REJECTED',
      'The simulated callback was rejected by the webhook handler',
      502,
      settlement,
    );
  }

  return ok(
    {
      confirmed: true,
      transferRef: payload.transferRef,
      transactionId: payload.transactionId,
      settlement: settlement?.data ?? null,
    },
    { mode: 'mock' },
  );
}

function maskPhone(phone: string): string {
  if (phone.length < 4) return '****';
  return `${phone.slice(0, 4)}****${phone.slice(-3)}`;
}
