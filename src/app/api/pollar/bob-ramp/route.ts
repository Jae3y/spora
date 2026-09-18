import { fail, fromError, ok, readJson } from '@/lib/api';
import { pollarMode } from '@/lib/config';
import { formatBob, formatUsdc, parseStroops, stroopsToBobCentavos, FX_RATES, type BobRateKind } from '@/lib/money';
import { getPollarClient } from '@/lib/pollar/client';
import { resolveDeferredStatus } from '@/lib/pollar/funding';
import { qrForUsdcSettlement, verifyEmvcoPayload, BOLIVIAN_BANKS } from '@/lib/pollar/qr-bancario';
import { appendAuditEvent } from '@/lib/store/ledger';

/**
 * Bolivian egress: USDC settlement -> BOB -> QR Simple payload.
 *
 * ## Why the QR is generated locally rather than read back from Pollar
 *
 * Pollar's ramp models bank rails as an enum -- `CLABE | PIX | PSE | ACH |
 * BREB` -- and Bolivia's ASFI QR Simple is not a member of it. The offramp
 * body does, however, accept a free-form `qrCode` string plus a `fields` map,
 * and the instructions it returns can carry a scannable of kind `opaque`.
 *
 * So the integration shape is: **we** mint a standards-compliant EMVCo payload
 * and hand it to Pollar as the opaque rail instruction, rather than asking
 * Pollar for a Bolivian QR it has no native concept of. This route therefore
 * always produces a verifiable QR, and additionally attaches a live Pollar
 * quote when one is available for BO.
 *
 * ## Exchange-rate policy
 *
 * Bolivia runs an official peg alongside a materially weaker parallel market.
 * The rate used is an explicit input (`rateKind`), defaults to `official`, and
 * is recorded on the settlement -- it is a commercial decision, and burying it
 * in a constant would make every downstream figure unauditable.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SUPPLIER_IDENTIFIER = 'supplier:caranavi-biofert-srl';

export async function GET(): Promise<Response> {
  const recipient = await resolveDeferredStatus(SUPPLIER_IDENTIFIER);
  return ok(
    {
      recipient,
      banks: BOLIVIAN_BANKS,
      rates: {
        official: FX_RATES.bobPerUsdOfficial,
        parallel: FX_RATES.bobPerUsdParallel,
      },
    },
    { mode: pollarMode },
  );
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body) return fail('MALFORMED_JSON', 'Request body must be JSON', 400);

  try {
    const stroops = parseStroops(String(body.stroops ?? body.amountStroops ?? '0'));
    if (stroops <= 0n) {
      return fail('INVALID_AMOUNT', 'A positive USDC stroop amount is required', 400);
    }

    const rateKind: BobRateKind = body.rateKind === 'parallel' ? 'parallel' : 'official';
    const recipientName = String(body.recipientName ?? 'CARANAVI BIOFERT SRL');
    const recipientAccount = String(body.recipientAccount ?? '4021998745');
    const bankCode = String(body.bankCode ?? '0010');
    const gloss = String(body.gloss ?? 'SPORA INSUMOS BIOLOGICOS');

    // 30-day validity: long enough for a supplier to reach a branch, short
    // enough that a stale rate cannot be presented as current.
    const expiry = new Date();
    expiry.setUTCDate(expiry.getUTCDate() + 30);
    const expirationDate = expiry.toISOString().slice(0, 10).replace(/-/g, '');

    const qr = qrForUsdcSettlement({
      stroops,
      rateKind,
      recipientName,
      recipientAccount,
      bankCode,
      gloss,
      expirationDate,
      invoiceId: typeof body.invoiceId === 'string' ? body.invoiceId : undefined,
    });

    // Refuse to hand out a payload that would fail at a Bolivian teller.
    if (!verifyEmvcoPayload(qr.emvco)) {
      return fail('QR_VERIFICATION_FAILED', 'Generated EMVCo payload failed CRC validation', 500);
    }

    const centavos = stroopsToBobCentavos(stroops, rateKind);
    const quote = await tryLiveQuote(stroops, rateKind);
    const recipient = await resolveDeferredStatus(SUPPLIER_IDENTIFIER);

    appendAuditEvent({
      category: 'egress',
      event: 'bob_qr_issued',
      summary:
        `Issued Bolivian QR Simple for ${formatBob(centavos)} BOB ` +
        `(${formatUsdc(stroops)} USDC at the ${rateKind} rate), invoice ${qr.invoiceId}.`,
      txHash: null,
      mode: quote ? 'live' : 'mock',
      detail: {
        invoiceId: qr.invoiceId,
        payloadDigest: qr.payloadDigest,
        crc: qr.crc,
        bankCode,
        bankName: BOLIVIAN_BANKS[bankCode] ?? 'Entidad Financiera',
        rateKind,
        deferredRecipient: recipient.publicKey,
      },
    });

    return ok(
      {
        settlement: {
          stroops: stroops.toString(),
          usdc: formatUsdc(stroops),
          bob: formatBob(centavos),
          bobCentavos: centavos.toString(),
          rateKind,
          rate: rateKind === 'official' ? FX_RATES.bobPerUsdOfficial : FX_RATES.bobPerUsdParallel,
        },
        qr: {
          emvco: qr.emvco,
          base64: qr.base64,
          envelope: qr.envelope,
          invoiceId: qr.invoiceId,
          payloadDigest: qr.payloadDigest,
          crc: qr.crc,
          crcVerified: true,
        },
        recipient,
        pollarQuote: quote,
      },
      { mode: quote ? 'live' : 'mock' },
    );
  } catch (error) {
    return fromError(error);
  }
}

/**
 * Attempt a live Pollar offramp quote for Bolivia.
 *
 * Failure is expected and benign: Pollar may have no BO anchor on this
 * network, in which case the locally-generated QR is the whole settlement
 * instruction. The quote is enrichment, never a dependency.
 */
async function tryLiveQuote(
  stroops: bigint,
  rateKind: BobRateKind,
): Promise<Record<string, unknown> | null> {
  const client = await getPollarClient();
  if (!client) return null;

  try {
    const countries = await client.getRampCountries();
    const bolivia = countries.countries?.find(
      (c) => String((c as { code?: string }).code ?? '').toUpperCase() === 'BO',
    );
    if (!bolivia) return null;

    const quote = await client.getRampsQuote({
      type: 'offramp',
      amount: Number(stroops / 10_000_000n),
      currency: 'BOB',
      country: 'BO',
    } as never);

    return { available: true, rateKind, quote: quote.quotes?.[0] ?? null };
  } catch (cause) {
    console.warn(`[spora/bob-ramp] Live quote unavailable: ${(cause as Error).message}`);
    return null;
  }
}
