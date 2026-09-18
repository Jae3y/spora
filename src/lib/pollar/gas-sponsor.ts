/**
 * Pollar Gas Wallet fee-bump sponsorship engine.
 *
 * Smallholder farmers in Kano hold no XLM and should never be asked to. Every
 * Soroban call the corridor makes on their behalf is therefore wrapped in a
 * `FeeBumpTransactionEnvelope` whose fee source is the Pollar gas wallet, so
 * the end user's account is debited exactly zero.
 *
 * ## Corrections to the reference snippet
 *
 * 1. **Argument order.** The real signature is
 *    `buildFeeBumpTransaction(feeSource, baseFee, innerTx, networkPassphrase)`.
 *    The reference passed `(keypair, innerTx, fee, passphrase)`, transposing
 *    `baseFee` and `innerTx`.
 * 2. **Union return.** `TransactionBuilder.fromXDR()` returns
 *    `Transaction | FeeBumpTransaction`. Feeding an already-bumped envelope
 *    back in is a protocol error, so it is rejected explicitly rather than
 *    allowed to fail deep inside the builder.
 * 3. **Dynamic base fee.** A fee bump is only valid if its fee is at least
 *    `(innerOperations + 1) x innerBaseFee`. Soroban envelopes carry a resource
 *    fee that routinely exceeds a hardcoded 2 000 000 stroops, so a fixed base
 *    fee silently breaks the moment the contract's footprint grows. The fee is
 *    derived from the inner envelope and only *capped* by configuration.
 */

import {
  FeeBumpTransaction,
  Keypair,
  Transaction,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { gasSponsorMode, stellarConfig } from '@/lib/config';

/**
 * Upper bound on what the gas wallet will pay for a single envelope, in
 * stroops. A runaway resource fee should surface as a loud refusal, not as a
 * silently drained sponsorship wallet.
 */
export const MAX_SPONSORED_BASE_FEE = 10_000_000n;

/** Floor, so a trivially cheap inner tx still clears surge pricing. */
export const MIN_SPONSORED_BASE_FEE = 2_000_000n;

export class GasSponsorshipError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'ALREADY_FEE_BUMPED'
      | 'NO_SPONSOR_KEY'
      | 'FEE_CEILING_EXCEEDED'
      | 'MALFORMED_ENVELOPE',
  ) {
    super(message);
    this.name = 'GasSponsorshipError';
  }
}

export interface SponsorshipResult {
  /** The signed `FeeBumpTransactionEnvelope`, base64 XDR. */
  feeBumpXdr: string;
  /** Public key that will actually be charged. */
  sponsorAddress: string;
  /** Total stroops the sponsor commits to. */
  totalFeeStroops: string;
  /** Per-operation base fee used for the bump. */
  baseFeeStroops: string;
  /** Hash of the inner transaction, for correlation in the audit drawer. */
  innerTransactionHash: string;
  mode: 'live' | 'mock';
}

/**
 * Wrap a signed inner transaction in a fee bump paid for by the gas wallet.
 *
 * The inner transaction must already carry its own source-account signature --
 * a fee bump delegates *fees*, never authorisation.
 */
export async function wrapWithPollarGasSponsorship(
  innerTxXdr: string,
  gasSignerSecret?: string,
): Promise<SponsorshipResult> {
  const secret = gasSignerSecret ?? stellarConfig.gasWalletSecret;
  const networkPassphrase = stellarConfig.networkPassphrase;

  // Without a funded sponsor we still produce a structurally valid, correctly
  // signed envelope from an ephemeral keypair. It will not submit, but every
  // downstream consumer -- the audit drawer, the XDR inspector, the demo --
  // sees an authentic FeeBumpTransactionEnvelope rather than a placeholder.
  const keypair = secret
    ? keypairFromSecret(secret)
    : Keypair.random();

  const inner = parseInnerTransaction(innerTxXdr, networkPassphrase);
  const baseFee = deriveBaseFee(inner);

  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    keypair,
    baseFee.toString(),
    inner,
    networkPassphrase,
  );
  feeBump.sign(keypair);

  return {
    feeBumpXdr: feeBump.toXDR(),
    sponsorAddress: keypair.publicKey(),
    totalFeeStroops: feeBump.fee,
    baseFeeStroops: baseFee.toString(),
    innerTransactionHash: inner.hash().toString('hex'),
    mode: secret ? 'live' : 'mock',
  };
}

/**
 * Decode an envelope and assert it is a plain v1 transaction.
 *
 * Re-bumping an existing `FeeBumpTransaction` is invalid on Stellar; catching
 * it here produces an actionable error instead of a `TypeError` from inside
 * the builder.
 */
export function parseInnerTransaction(xdr: string, networkPassphrase: string): Transaction {
  let decoded: Transaction | FeeBumpTransaction;
  try {
    decoded = TransactionBuilder.fromXDR(xdr, networkPassphrase);
  } catch (cause) {
    throw new GasSponsorshipError(
      `Could not decode transaction envelope: ${(cause as Error).message}`,
      'MALFORMED_ENVELOPE',
    );
  }

  if (decoded instanceof FeeBumpTransaction) {
    throw new GasSponsorshipError(
      'Envelope is already a FeeBumpTransaction; Stellar does not permit nested fee bumps.',
      'ALREADY_FEE_BUMPED',
    );
  }
  return decoded;
}

/**
 * Choose a base fee that is guaranteed to satisfy the protocol's fee-bump
 * rule for this specific inner transaction.
 *
 * Validity requires `feeBump.fee >= (innerOps + 1) * innerBaseFee`, where
 * `innerBaseFee = ceil(inner.fee / innerOps)`. Soroban invocations are
 * single-operation but carry a resource fee folded into `inner.fee`, so that
 * quotient can be far above any sensible hardcoded constant.
 */
export function deriveBaseFee(inner: Transaction): bigint {
  const operationCount = BigInt(Math.max(inner.operations.length, 1));
  const innerFee = BigInt(inner.fee);
  // Ceiling division: a truncated quotient can land one stroop under the
  // protocol minimum and get the bump rejected outright.
  const innerBaseFee = (innerFee + operationCount - 1n) / operationCount;

  const required = innerBaseFee > MIN_SPONSORED_BASE_FEE ? innerBaseFee : MIN_SPONSORED_BASE_FEE;

  if (required > MAX_SPONSORED_BASE_FEE) {
    throw new GasSponsorshipError(
      `Inner transaction requires a base fee of ${required} stroops, above the ` +
        `sponsorship ceiling of ${MAX_SPONSORED_BASE_FEE}. Refusing to sponsor.`,
      'FEE_CEILING_EXCEEDED',
    );
  }
  return required;
}

/**
 * Construct the sponsor keypair, converting a malformed secret into a typed
 * error. `Keypair.fromSecret` throws a bare `Error` whose message leaks the
 * offending string in some SDK versions, which must never reach a log.
 */
function keypairFromSecret(secret: string): Keypair {
  try {
    return Keypair.fromSecret(secret);
  } catch {
    throw new GasSponsorshipError(
      'Gas wallet secret is not a valid Stellar seed (expected an S... strkey).',
      'NO_SPONSOR_KEY',
    );
  }
}

/** Public key of the configured gas wallet, or `null` when unconfigured. */
export function gasWalletAddress(): string | null {
  if (!stellarConfig.gasWalletSecret) return null;
  try {
    return keypairFromSecret(stellarConfig.gasWalletSecret).publicKey();
  } catch {
    return null;
  }
}

export function gasSponsorshipStatus(): { mode: 'live' | 'mock'; address: string | null } {
  return { mode: gasSponsorMode, address: gasWalletAddress() };
}
