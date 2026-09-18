/**
 * Bolivian QR Simple / QR Bancario payload generation.
 *
 * Bolivia's domestic instant-payment rail (supervised by ASFI, cleared through
 * the BCB's ACH) is addressed by a merchant-presented QR. Banks there accept an
 * EMVCo Merchant-Presented-Mode payload, and the interoperable ASFI profile
 * pins the currency to BOB (ISO 4217 numeric **068**) and the country to `BO`.
 *
 * ## Why this emits EMVCo TLV and not only base64 JSON
 *
 * The reference design base64-encoded a JSON object. That round-trips, but it
 * is not verifiable: any corrupted or tampered payload decodes to *something*,
 * and nothing in it proves integrity. Real EMVCo MPM is tag-length-value with a
 * trailing **CRC-16/CCITT-FALSE** over the entire string, so a scanner rejects
 * a damaged code instead of paying the wrong beneficiary.
 *
 * This module therefore emits both:
 *
 * - {@link buildEmvcoPayload} -- standards-compliant TLV with a valid CRC,
 *   parseable by any EMVCo implementation and checkable by
 *   {@link verifyEmvcoPayload};
 * - {@link generateBolivianQRSimplePayload} -- the ASFI JSON envelope from the
 *   original specification, which carries the TLV string inside it so the two
 *   representations can never disagree.
 *
 * ## EMVCo tags used
 *
 * | Tag | Meaning                        | Value here                    |
 * |-----|--------------------------------|-------------------------------|
 * | 00  | Payload Format Indicator       | `01`                          |
 * | 01  | Point of Initiation Method     | `12` (dynamic, single-use)    |
 * | 26  | Merchant Account Information   | ASFI template (see below)     |
 * | 52  | Merchant Category Code         | `0763` agricultural co-op     |
 * | 53  | Transaction Currency           | `068` (BOB)                   |
 * | 54  | Transaction Amount             | decimal, 2 dp                 |
 * | 58  | Country Code                   | `BO`                          |
 * | 59  | Merchant Name                  | beneficiary                   |
 * | 60  | Merchant City                  | `CARANAVI`                    |
 * | 62  | Additional Data Template       | invoice / reference / purpose |
 * | 63  | CRC-16                         | computed last                 |
 */

import { createHash, randomBytes } from 'node:crypto';
import { formatBob, stroopsToBobCentavos, type BobRateKind } from '@/lib/money';

export interface QRBancarioParams {
  recipientName: string;
  /** Bolivian bank account number or CIF. */
  recipientAccount: string;
  /** ASFI institution code, e.g. `"0010"` for Banco Nacional de Bolivia. */
  bankCode: string;
  amountBob: number | string;
  /** Payment memo ("glosa"). */
  gloss: string;
  /** `YYYYMMDD`. */
  expirationDate: string;
  /** Overrides the generated invoice id; useful for idempotent regeneration. */
  invoiceId?: string;
  merchantCity?: string;
}

/** ISO 4217 numeric code for the Boliviano. */
export const BOB_CURRENCY_NUMERIC = '068';
/** MCC 0763 -- agricultural cooperatives. */
export const AGRICULTURAL_COOPERATIVE_MCC = '0763';
/** ASFI-registered institution codes used by the corridor. */
export const BOLIVIAN_BANKS: Record<string, string> = {
  '0010': 'Banco Nacional de Bolivia',
  '0014': 'Banco Mercantil Santa Cruz',
  '0016': 'Banco de Credito de Bolivia',
  '0018': 'Banco Union',
  '0057': 'Banco Ganadero',
};

export class QrPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QrPayloadError';
  }
}

export interface BolivianQrPayload {
  /** EMVCo TLV string -- this is what goes into the QR image. */
  emvco: string;
  /** ASFI JSON envelope, base64-encoded, per the original specification. */
  base64: string;
  /** The decoded JSON envelope, for display and audit. */
  envelope: AsfiEnvelope;
  invoiceId: string;
  /** SHA-256 of the EMVCo payload, for correlating the QR to a ledger entry. */
  payloadDigest: string;
  crc: string;
}

export interface AsfiEnvelope {
  version: string;
  currency: 'BOB';
  currencyNumeric: string;
  amount: string;
  beneficiary: {
    name: string;
    account: string;
    bank: string;
    bankName: string;
  };
  gloss: string;
  singleUse: true;
  invoice: string;
  expiresAt: string;
  /** Embedded so the JSON and TLV representations cannot drift apart. */
  emvco: string;
}

/**
 * Encode one EMVCo TLV field.
 *
 * Length is a zero-padded two-digit *character* count. Values longer than 99
 * characters cannot be represented at all in MPM and are rejected rather than
 * silently truncated -- a truncated account number is a misdirected payment.
 */
export function tlv(tag: string, value: string): string {
  if (!/^\d{2}$/.test(tag)) {
    throw new QrPayloadError(`EMVCo tag must be two digits, got ${JSON.stringify(tag)}`);
  }
  if (value.length > 99) {
    throw new QrPayloadError(
      `EMVCo field ${tag} is ${value.length} characters; the format caps a field at 99.`,
    );
  }
  return `${tag}${value.length.toString().padStart(2, '0')}${value}`;
}

/**
 * CRC-16/CCITT-FALSE: polynomial `0x1021`, initial value `0xFFFF`, no input or
 * output reflection, no final XOR. This is the exact variant EMVCo specifies;
 * the commonly-confused `CRC-16/ARC` would produce a checksum every compliant
 * scanner rejects.
 */
export function crc16CcittFalse(input: string): string {
  let crc = 0xffff;
  for (let i = 0; i < input.length; i += 1) {
    crc ^= input.charCodeAt(i) << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Assemble the EMVCo Merchant-Presented-Mode payload.
 *
 * The CRC is computed over the payload *including* the literal `6304` tag and
 * length header, which is the part of the spec implementations most often get
 * wrong. Omitting it yields a checksum that looks plausible and fails on every
 * real terminal.
 */
export function buildEmvcoPayload(params: QRBancarioParams & { invoiceId: string }): {
  payload: string;
  crc: string;
} {
  const amount = normaliseAmount(params.amountBob);

  // Tag 26: merchant account information, ASFI profile. Sub-tag 00 is the
  // globally unique identifier for the scheme, 01 the institution, 02 the
  // beneficiary account.
  const merchantAccount =
    tlv('00', 'BO.ASFI.QRSIMPLE') + tlv('01', params.bankCode) + tlv('02', params.recipientAccount);

  // Tag 62: additional data. 01 = bill/invoice number, 05 = reference label,
  // 08 = purpose of transaction.
  const additionalData =
    tlv('01', params.invoiceId) +
    tlv('05', sanitise(params.gloss, 25)) +
    tlv('08', sanitise(`EXP${params.expirationDate}`, 25));

  const body =
    tlv('00', '01') +
    // 12 = dynamic QR, valid for a single transaction. A static `11` would let
    // the same code be paid twice.
    tlv('01', '12') +
    tlv('26', merchantAccount) +
    tlv('52', AGRICULTURAL_COOPERATIVE_MCC) +
    tlv('53', BOB_CURRENCY_NUMERIC) +
    tlv('54', amount) +
    tlv('58', 'BO') +
    tlv('59', sanitise(params.recipientName, 25)) +
    tlv('60', sanitise(params.merchantCity ?? 'CARANAVI', 15)) +
    tlv('62', additionalData);

  // `6304` is the CRC tag and its fixed length; both are inside the checksum.
  const withCrcHeader = `${body}6304`;
  const crc = crc16CcittFalse(withCrcHeader);
  return { payload: `${withCrcHeader}${crc}`, crc };
}

/**
 * Validate an EMVCo payload's trailing checksum.
 *
 * Used by the API route before handing a QR to a supplier: emitting a code
 * whose CRC does not verify would produce a scan failure at a Bolivian
 * teller's window, with no diagnostic reaching us.
 */
export function verifyEmvcoPayload(payload: string): boolean {
  if (payload.length < 8) return false;
  const body = payload.slice(0, -4);
  const declared = payload.slice(-4).toUpperCase();
  if (!body.endsWith('6304')) return false;
  return crc16CcittFalse(body) === declared;
}

/**
 * Generate the full Bolivian QR Simple payload set for a settlement.
 *
 * Returns both representations plus a digest, so the audit drawer can prove
 * that the QR a supplier scanned is the QR this escrow issued.
 */
export function generateBolivianQRSimplePayload(params: QRBancarioParams): BolivianQrPayload {
  validate(params);

  const invoiceId = params.invoiceId ?? randomBytes(8).toString('hex').toUpperCase();
  const { payload, crc } = buildEmvcoPayload({ ...params, invoiceId });

  if (!verifyEmvcoPayload(payload)) {
    // Unreachable unless the encoder itself regresses; asserting here turns a
    // silent scan failure in Bolivia into a loud failure in CI.
    throw new QrPayloadError('Generated EMVCo payload failed its own CRC verification');
  }

  const envelope: AsfiEnvelope = {
    version: '000201',
    currency: 'BOB',
    currencyNumeric: BOB_CURRENCY_NUMERIC,
    amount: normaliseAmount(params.amountBob),
    beneficiary: {
      name: params.recipientName,
      account: params.recipientAccount,
      bank: params.bankCode,
      bankName: BOLIVIAN_BANKS[params.bankCode] ?? 'Entidad Financiera',
    },
    gloss: params.gloss,
    singleUse: true,
    invoice: invoiceId,
    expiresAt: params.expirationDate,
    emvco: payload,
  };

  return {
    emvco: payload,
    base64: Buffer.from(JSON.stringify(envelope)).toString('base64'),
    envelope,
    invoiceId,
    payloadDigest: createHash('sha256').update(payload).digest('hex'),
    crc,
  };
}

/** Convenience: build the QR directly from a USDC settlement amount. */
export function qrForUsdcSettlement(args: {
  stroops: bigint;
  rateKind?: BobRateKind;
  recipientName: string;
  recipientAccount: string;
  bankCode: string;
  gloss: string;
  expirationDate: string;
  invoiceId?: string;
}): BolivianQrPayload & { amountBob: string; rateKind: BobRateKind } {
  const rateKind = args.rateKind ?? 'official';
  const amountBob = formatBob(stroopsToBobCentavos(args.stroops, rateKind));
  const payload = generateBolivianQRSimplePayload({
    recipientName: args.recipientName,
    recipientAccount: args.recipientAccount,
    bankCode: args.bankCode,
    amountBob,
    gloss: args.gloss,
    expirationDate: args.expirationDate,
    invoiceId: args.invoiceId,
  });
  return { ...payload, amountBob, rateKind };
}

function validate(params: QRBancarioParams): void {
  if (!params.recipientName?.trim()) throw new QrPayloadError('recipientName is required');
  if (!/^\d{3,20}$/.test(params.recipientAccount)) {
    throw new QrPayloadError(
      `recipientAccount must be 3-20 digits, got ${JSON.stringify(params.recipientAccount)}`,
    );
  }
  if (!/^\d{4}$/.test(params.bankCode)) {
    throw new QrPayloadError(`bankCode must be a 4-digit ASFI code, got ${params.bankCode}`);
  }
  if (!/^\d{8}$/.test(params.expirationDate)) {
    throw new QrPayloadError(`expirationDate must be YYYYMMDD, got ${params.expirationDate}`);
  }
  const amount = Number(params.amountBob);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new QrPayloadError(`amountBob must be a positive number, got ${params.amountBob}`);
  }
}

function normaliseAmount(amount: number | string): string {
  const value = typeof amount === 'string' ? Number(amount) : amount;
  if (!Number.isFinite(value)) throw new QrPayloadError(`Invalid amount: ${amount}`);
  return value.toFixed(2);
}

/**
 * EMVCo fields are ASCII-only and length-bounded. Bolivian beneficiary names
 * routinely carry accents, so transliterate rather than emit bytes a scanner
 * will mangle.
 */
function sanitise(value: string, maxLength: number): string {
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x20-\x7E]/g, '')
    .trim()
    .slice(0, maxLength)
    .toUpperCase();
}
