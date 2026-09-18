import 'server-only';

/**
 * Pollar Deferred Funding policy.
 *
 * ## Why deferral exists
 *
 * Creating a Stellar account costs a 0.5 XLM base reserve, and every trustline
 * it carries costs another 0.5 XLM held for as long as the line exists. An
 * operator who materialises an account for each sign-up therefore burns real
 * capital on users who may never transact -- a failure mode that is merely
 * wasteful in a high-ARPU market and fatal in an emerging one, where funding
 * wallets are thin and sign-up-to-transaction conversion is low.
 *
 * Deferred funding breaks the link between *knowing* an address and *paying*
 * for it. The recipient's public key is derived deterministically up front, so
 * it can be printed on an invoice, embedded in a QR payload, and referenced by
 * the escrow contract — all before a single stroop of reserve is committed.
 * The account is materialised only at the instant value must actually land in
 * it: on `Completed` or `ParametricTriggered`.
 *
 * ## Derivation
 *
 * The keypair is HMAC-SHA512/256 over a namespaced label, keyed by a
 * server-held seed. Properties that matter:
 *
 * - **Deterministic**: the same supplier always resolves to the same address,
 *   so a re-deploy or a crashed process never orphans funds at a lost key.
 * - **Non-enumerable**: without the seed, knowing one derived address tells an
 *   attacker nothing about any other.
 * - **Namespaced**: the label includes a domain tag, so a supplier key can
 *   never collide with a cooperative or treasury key derived from the same
 *   seed.
 */

import { createHmac, randomBytes } from 'node:crypto';
import {
  Account,
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { pollarConfig, pollarMode, stellarConfig } from '@/lib/config';
import { wrapWithPollarGasSponsorship } from './gas-sponsor';

export type DeferredStatus =
  /** Address derived; nothing on chain. Zero reserve committed. */
  | 'deferred'
  /** Account exists but cannot yet hold USDC. */
  | 'awaiting_trustline'
  /** Account exists and the USDC trustline is established. */
  | 'active';

export interface DeferredRecipient {
  /** The G... address, known from derivation onward. */
  publicKey: string;
  /** Stable label this key was derived from. */
  derivationLabel: string;
  /** Human-readable derivation path, surfaced in the audit drawer. */
  derivationPath: string;
  status: DeferredStatus;
  /**
   * Reserve the operator has committed so far, in XLM. Exactly `0` until
   * activation -- the entire point of the policy.
   */
  committedReserveXlm: number;
}

/** Base reserve (0.5 XLM) plus one trustline reserve (0.5 XLM). */
export const ACTIVATION_RESERVE_XLM = 1.0;

const DERIVATION_DOMAIN = 'spora.pollar.deferred.v1';

export class DeferredFundingError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_SEED' | 'ACTIVATION_FAILED' | 'ALREADY_ACTIVE' | 'HORIZON_UNAVAILABLE',
  ) {
    super(message);
    this.name = 'DeferredFundingError';
  }
}

/**
 * Resolve the derivation seed.
 *
 * In mock mode a process-lifetime random seed is generated so the demo still
 * produces valid, self-consistent addresses. It is deliberately *not*
 * persisted: a stable fallback seed checked into a repo would be the single
 * worst thing in this codebase, since anyone reading it could derive and drain
 * every deferred recipient on a real deployment.
 */
let ephemeralSeed: Buffer | null = null;
function derivationSeed(): Buffer {
  if (pollarConfig.derivationSeed) {
    return Buffer.from(pollarConfig.derivationSeed, 'utf8');
  }
  if (!ephemeralSeed) {
    ephemeralSeed = randomBytes(32);
  }
  return ephemeralSeed;
}

/**
 * Derive the deferred recipient keypair for a stable business identifier
 * (e.g. `supplier:caranavi-biofert-srl`).
 *
 * Returns the secret alongside the public key because activation must sign
 * `changeTrust` and `endSponsoringFutureReserves` *as the sponsored account*.
 * Callers that only need the address should use {@link deferredAddressFor},
 * which never materialises the secret.
 */
export function deriveDeferredKeypair(identifier: string): {
  keypair: Keypair;
  derivationLabel: string;
  derivationPath: string;
} {
  const derivationLabel = `${DERIVATION_DOMAIN}:${identifier}`;
  // HMAC-SHA512/256 gives exactly the 32 bytes Ed25519 needs, with no
  // truncation of a wider digest and no modular bias.
  const raw = createHmac('sha512-256', derivationSeed()).update(derivationLabel).digest();
  const keypair = Keypair.fromRawEd25519Seed(raw);
  return {
    keypair,
    derivationLabel,
    derivationPath: `hmac-sha512/256(${DERIVATION_DOMAIN}) / ${identifier}`,
  };
}

/** Address-only derivation, for display paths that must not touch the secret. */
export function deferredAddressFor(identifier: string): string {
  return deriveDeferredKeypair(identifier).keypair.publicKey();
}

/**
 * Inspect the chain to classify a derived address.
 *
 * A 404 from Horizon is the *expected, healthy* answer for a deferred account
 * and is mapped to `deferred` rather than treated as an error. Any other
 * transport failure is reported as such, because silently reporting `deferred`
 * on a network blip could cause a double activation.
 */
export async function resolveDeferredStatus(identifier: string): Promise<DeferredRecipient> {
  const { keypair, derivationLabel, derivationPath } = deriveDeferredKeypair(identifier);
  const publicKey = keypair.publicKey();

  const base: Omit<DeferredRecipient, 'status' | 'committedReserveXlm'> = {
    publicKey,
    derivationLabel,
    derivationPath,
  };

  if (pollarMode === 'mock') {
    return { ...base, status: 'deferred', committedReserveXlm: 0 };
  }

  const server = new Horizon.Server(stellarConfig.horizonUrl);
  try {
    const account = await server.loadAccount(publicKey);
    const hasUsdcTrustline = account.balances.some(
      (b) =>
        'asset_code' in b &&
        b.asset_code === 'USDC' &&
        'asset_issuer' in b &&
        b.asset_issuer === stellarConfig.usdcIssuer,
    );
    return {
      ...base,
      status: hasUsdcTrustline ? 'active' : 'awaiting_trustline',
      committedReserveXlm: hasUsdcTrustline ? ACTIVATION_RESERVE_XLM : 0.5,
    };
  } catch (cause) {
    if (isNotFound(cause)) {
      return { ...base, status: 'deferred', committedReserveXlm: 0 };
    }
    throw new DeferredFundingError(
      `Horizon lookup failed for ${publicKey}: ${(cause as Error).message}`,
      'HORIZON_UNAVAILABLE',
    );
  }
}

export interface ActivationResult {
  publicKey: string;
  /** Submitted fee-bump envelope hash, when live. */
  transactionHash: string | null;
  feeBumpXdr: string;
  /** Sponsor that absorbed the 1.0 XLM of reserves. */
  sponsorAddress: string;
  reserveCommittedXlm: number;
  mode: 'live' | 'mock';
  operations: string[];
}

/**
 * Materialise a deferred recipient atomically: create the account, establish
 * the USDC trustline, and have the sponsor absorb both reserves -- all in one
 * transaction that either lands whole or not at all.
 *
 * The operation sandwich is Stellar's canonical sponsorship pattern:
 *
 * ```text
 *   beginSponsoringFutureReserves(sponsored)   <- signed by sponsor
 *     createAccount(sponsored, startingBalance: "0")
 *     changeTrust(USDC)                        <- signed by sponsored
 *   endSponsoringFutureReserves()              <- signed by sponsored
 * ```
 *
 * `startingBalance` is `"0"` precisely because the sponsor, not the new
 * account, is holding the base reserve. The sponsored account must co-sign:
 * `changeTrust` and `endSponsoringFutureReserves` are its own operations, and
 * Stellar will not let a third party encumber an account without its consent.
 *
 * Partial activation is impossible by construction. There is no state where
 * the account exists but the trustline does not and the reserve has been
 * spent, because both live in one transaction.
 */
export async function activateDeferredRecipient(
  identifier: string,
  options: { sponsorSecret?: string } = {},
): Promise<ActivationResult> {
  const { keypair } = deriveDeferredKeypair(identifier);
  const publicKey = keypair.publicKey();
  const sponsorSecret = options.sponsorSecret ?? stellarConfig.gasWalletSecret;

  const usdc = new Asset('USDC', stellarConfig.usdcIssuer);
  const operationNames = [
    'beginSponsoringFutureReserves',
    'createAccount',
    'changeTrust(USDC)',
    'endSponsoringFutureReserves',
  ];

  // Mock path: build a structurally authentic envelope against a synthetic
  // sequence number. It cannot submit, but it is a real signed XDR that the
  // audit drawer and any XDR viewer will decode correctly.
  if (!sponsorSecret || pollarMode === 'mock') {
    const sponsor = sponsorSecret ? Keypair.fromSecret(sponsorSecret) : Keypair.random();
    const xdr = buildActivationXdr({
      sponsor,
      sponsored: keypair,
      usdc,
      sequence: '1',
    });
    const sponsorship = await wrapWithPollarGasSponsorship(xdr, sponsorSecret);
    return {
      publicKey,
      transactionHash: null,
      feeBumpXdr: sponsorship.feeBumpXdr,
      sponsorAddress: sponsorship.sponsorAddress,
      reserveCommittedXlm: ACTIVATION_RESERVE_XLM,
      mode: 'mock',
      operations: operationNames,
    };
  }

  const sponsor = Keypair.fromSecret(sponsorSecret);
  const server = new Horizon.Server(stellarConfig.horizonUrl);

  const existing = await resolveDeferredStatus(identifier);
  if (existing.status === 'active') {
    throw new DeferredFundingError(
      `${publicKey} is already active; activating twice would burn a second reserve.`,
      'ALREADY_ACTIVE',
    );
  }

  const sponsorAccount = await server.loadAccount(sponsor.publicKey());
  const xdr = buildActivationXdr({
    sponsor,
    sponsored: keypair,
    usdc,
    sequence: sponsorAccount.sequenceNumber(),
  });

  const sponsorship = await wrapWithPollarGasSponsorship(xdr, sponsorSecret);

  try {
    const response = await server.submitTransaction(
      TransactionBuilder.fromXDR(sponsorship.feeBumpXdr, stellarConfig.networkPassphrase),
    );
    return {
      publicKey,
      transactionHash: response.hash,
      feeBumpXdr: sponsorship.feeBumpXdr,
      sponsorAddress: sponsorship.sponsorAddress,
      reserveCommittedXlm: ACTIVATION_RESERVE_XLM,
      mode: 'live',
      operations: operationNames,
    };
  } catch (cause) {
    throw new DeferredFundingError(
      `Activation of ${publicKey} failed: ${describeHorizonError(cause)}`,
      'ACTIVATION_FAILED',
    );
  }
}

function buildActivationXdr(args: {
  sponsor: Keypair;
  sponsored: Keypair;
  usdc: Asset;
  sequence: string;
}): string {
  const { sponsor, sponsored, usdc, sequence } = args;

  // `Account` is constructed from the sequence *already consumed*; the builder
  // increments it when it builds, so the loaded value is passed through as-is.
  const source = new Account(sponsor.publicKey(), sequence);

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(
      Operation.beginSponsoringFutureReserves({ sponsoredId: sponsored.publicKey() }),
    )
    .addOperation(
      Operation.createAccount({
        destination: sponsored.publicKey(),
        // Zero: the sponsor holds the base reserve on this account's behalf.
        startingBalance: '0',
      }),
    )
    .addOperation(
      Operation.changeTrust({ asset: usdc, source: sponsored.publicKey() }),
    )
    .addOperation(
      Operation.endSponsoringFutureReserves({ source: sponsored.publicKey() }),
    )
    .setTimeout(180)
    .build();

  // Both principals sign: the sponsor authorises the reserve spend, the
  // sponsored account consents to being created and encumbered.
  tx.sign(sponsor, sponsored);
  return tx.toXDR();
}

function isNotFound(cause: unknown): boolean {
  const status = (cause as { response?: { status?: number } })?.response?.status;
  return status === 404;
}

function describeHorizonError(cause: unknown): string {
  const codes = (
    cause as { response?: { data?: { extras?: { result_codes?: unknown } } } }
  )?.response?.data?.extras?.result_codes;
  if (codes) return JSON.stringify(codes);
  return (cause as Error)?.message ?? 'unknown error';
}
