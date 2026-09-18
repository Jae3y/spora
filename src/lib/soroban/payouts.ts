import 'server-only';

/**
 * What the counterparties actually hold, read from Horizon.
 *
 * ## Why this exists
 *
 * The contract performs the settlement transfers but does not persist the
 * per-leg amounts: `settle` moves the funds and returns a `Settlement` to its
 * caller, and nothing writes `cooperative_paid` or `supplier_paid` into
 * instance storage. So `get_escrow` cannot report them, and the dashboard fell
 * back to the process-local mirror -- which a serverless cold start rebuilds
 * empty.
 *
 * The result was a live settlement displaying `0.00` paid to both sides
 * moments after 12 and 8 USDC had genuinely moved. That is the same failure as
 * a rail badge reading `mock` over a working integration: the interface
 * understating itself, which costs exactly as much credibility as overstating
 * it.
 *
 * Reading the counterparties' balances is the honest fix. It is ground truth
 * rather than a number we computed and then agreed with.
 *
 * ## Why balances rather than recomputing the split
 *
 * 60/40 of the deposited total would produce the right figures today and quietly
 * wrong ones the moment an account holds anything from another source. A
 * balance is a fact; a recomputed split is our arithmetic being marked by
 * itself.
 */

import { Horizon, Keypair } from '@stellar/stellar-sdk';
import { stellarConfig } from '@/lib/config';

export interface OnChainPayouts {
  /** USDC held by the cooperative, as a decimal string. */
  cooperative: string | null;
  /** USDC held by the supplier, as a decimal string. */
  supplier: string | null;
  /** Null when neither account could be read. */
  readAt: string | null;
  error: string | null;
}

const TTL_MS = 30_000;
let cached: { at: number; value: OnChainPayouts } | null = null;
let inFlight: Promise<OnChainPayouts> | null = null;

async function usdcBalance(
  server: Horizon.Server,
  address: string | null,
): Promise<string | null> {
  if (!address) return null;
  try {
    const account = await server.loadAccount(address);
    const line = account.balances.find(
      (b) => 'asset_code' in b && b.asset_code === 'USDC',
    );
    return line && 'balance' in line ? line.balance : '0';
  } catch {
    // An unfunded account is a 404, which is a legitimate "nothing here yet"
    // rather than an error worth surfacing.
    return null;
  }
}

async function probe(): Promise<OnChainPayouts> {
  const { cooperativeAddress, supplierAddress } = settlementAddresses();

  if (!cooperativeAddress && !supplierAddress) {
    return {
      cooperative: null,
      supplier: null,
      readAt: null,
      error: 'No counterparty addresses configured.',
    };
  }

  try {
    const server = new Horizon.Server(stellarConfig.horizonUrl);
    const [cooperative, supplier] = await Promise.all([
      usdcBalance(server, cooperativeAddress),
      usdcBalance(server, supplierAddress),
    ]);

    return { cooperative, supplier, readAt: new Date().toISOString(), error: null };
  } catch (cause) {
    return {
      cooperative: null,
      supplier: null,
      readAt: null,
      error: `Horizon read failed: ${(cause as Error).message}`,
    };
  }
}

/**
 * Cached for 30s, with concurrent callers sharing one in-flight read.
 *
 * Every dashboard poll asks for this, and Horizon rate-limits.
 */
export async function onChainPayouts(): Promise<OnChainPayouts> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  if (inFlight) return inFlight;

  inFlight = probe()
    .then((value) => {
      cached = { at: Date.now(), value };
      return value;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Derive the counterparty public keys from their configured seeds.
 *
 * Deriving rather than storing two more environment variables keeps a single
 * source of truth: a rotated seed cannot leave a stale address behind.
 */
function settlementAddresses(): {
  cooperativeAddress: string | null;
  supplierAddress: string | null;
} {
  return {
    cooperativeAddress: publicKeyOf(stellarConfig.cooperativeSecret),
    supplierAddress: publicKeyOf(stellarConfig.supplierSecret),
  };
}

function publicKeyOf(secret: string | undefined): string | null {
  if (!secret) return null;
  try {
    return Keypair.fromSecret(secret).publicKey();
  } catch {
    // A malformed seed yields no address rather than taking down the route.
    return null;
  }
}
