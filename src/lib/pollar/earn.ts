import 'server-only';

/**
 * Pollar Earn: productive deployment of the 10% climate buffer.
 *
 * The buffer sits idle for the 4-6 weeks a shipment spends crossing the
 * Atlantic. Parking it in a Blend lending pool or a DeFindex vault for that
 * window turns dead collateral into yield that ultimately accrues to whichever
 * party the escrow settles to.
 *
 * ## Two constraints shape this module
 *
 * **Provider fan-out.** `getEarnOpportunities` is scoped to a *single*
 * provider (`"blend" | "defindex"`). Calling it once would compare a fraction
 * of the available venues and systematically under-select APY, so
 * {@link listYieldOpportunities} enumerates providers first and queries each,
 * tolerating a partial failure rather than losing the whole comparison.
 *
 * **Redemption must beat settlement.** A parametric trigger fires on an oracle
 * report and drains the contract in the same transaction. If the buffer is
 * still in a vault at that moment it is simply not there to distribute. The
 * escrow handles this with `sweep_residual`, but the operationally correct
 * behaviour is still to redeem *first* and settle second, which is why
 * {@link emergencyYieldRedeem} is fire-and-report rather than fire-and-forget.
 */

import type { EarnOpportunity, EarnProviderId } from '@pollar/core';
import { pollarMode } from '@/lib/config';
import { formatUsdc, fromStroops, toStroops } from '@/lib/money';
import { getPollarClient } from './client';

export interface YieldOpportunity {
  provider: EarnProviderId | 'blend' | 'defindex';
  id: string;
  name: string;
  symbol: string | null;
  kind: 'vault' | 'lending';
  assetCode: string;
  /** Annual percentage yield as a decimal fraction, e.g. `0.0714` for 7.14%. */
  apy: number;
  mode: 'live' | 'mock';
}

export interface YieldDeployment {
  opportunity: YieldOpportunity;
  /** Principal deployed, in USDC stroops. */
  principalStroops: string;
  transactionHash: string | null;
  deployedAt: string;
  mode: 'live' | 'mock';
}

export interface YieldRedemption {
  opportunity: YieldOpportunity | null;
  principalStroops: string;
  /** Interest earned over the holding period, in USDC stroops. */
  accruedStroops: string;
  totalStroops: string;
  holdingPeriodDays: number;
  transactionHash: string | null;
  mode: 'live' | 'mock';
}

export class EarnError extends Error {
  constructor(
    message: string,
    readonly code: 'NO_OPPORTUNITIES' | 'DEPOSIT_FAILED' | 'REDEEM_FAILED',
  ) {
    super(message);
    this.name = 'EarnError';
  }
}

/**
 * Mock venues modelled on the shapes Blend and DeFindex actually return on
 * Stellar testnet, including the spread between a lending pool and a vault.
 * APYs are fixed rather than random so a demo is reproducible and the "highest
 * APY wins" selection is verifiable by eye.
 */
const MOCK_OPPORTUNITIES: YieldOpportunity[] = [
  {
    provider: 'blend',
    id: 'CCBLENDPOOLUSDCXLMTESTNETPOOLIDPLACEHOLDER00001',
    name: 'Blend USDC Lending Pool',
    symbol: 'bUSDC',
    kind: 'lending',
    assetCode: 'USDC',
    apy: 0.0618,
    mode: 'mock',
  },
  {
    provider: 'defindex',
    id: 'CDDEFINDEXVAULTUSDCYIELDTESTNETVAULTID0000002',
    name: 'DeFindex USDC Yield Vault',
    symbol: 'dfUSDC',
    kind: 'vault',
    assetCode: 'USDC',
    apy: 0.0741,
    mode: 'mock',
  },
  {
    provider: 'blend',
    id: 'CCBLENDPOOLUSDCCONSERVATIVETESTNETPOOLID00003',
    name: 'Blend USDC Conservative Pool',
    symbol: 'bcUSDC',
    kind: 'lending',
    assetCode: 'USDC',
    apy: 0.0452,
    mode: 'mock',
  },
];

/**
 * Enumerate every yield venue across every enabled provider, sorted by APY
 * descending.
 *
 * A provider that errors is *skipped*, not fatal. Losing DeFindex should still
 * let the buffer earn Blend's rate; failing the whole call would leave the
 * money idle, which is strictly worse than a suboptimal placement.
 */
export async function listYieldOpportunities(): Promise<YieldOpportunity[]> {
  const client = await getPollarClient();
  if (!client) return [...MOCK_OPPORTUNITIES].sort(byApyDescending);

  try {
    const providers = await client.getEarnProviders();
    if (!providers.length) {
      // An empty provider list means the app has Earn switched off upstream.
      // That is a legitimate configuration, not a failure.
      return [];
    }

    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const opportunities = await client.getEarnOpportunities(provider);
        return opportunities.map((o) => normaliseOpportunity(o, provider));
      }),
    );

    const live = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const failures = settled.filter((r) => r.status === 'rejected').length;
    if (failures) {
      console.warn(`[spora/earn] ${failures}/${providers.length} Earn providers unavailable`);
    }

    // If every provider failed we have no live picture at all; fall back to
    // the mock venues so the buffer still has somewhere to go.
    return (live.length ? live : [...MOCK_OPPORTUNITIES]).sort(byApyDescending);
  } catch (cause) {
    console.warn(`[spora/earn] Falling back to mock venues: ${(cause as Error).message}`);
    return [...MOCK_OPPORTUNITIES].sort(byApyDescending);
  }
}

/** The single best-yielding venue, or `null` when Earn is disabled. */
export async function bestYieldOpportunity(): Promise<YieldOpportunity | null> {
  const [best] = await listYieldOpportunities();
  return best ?? null;
}

/**
 * Deploy the climate buffer into the highest-APY venue.
 *
 * `amountStroops` is the buffer allocation read from the contract, so the
 * amount deployed can never exceed what the 90/10 split actually reserved.
 */
export async function depositBufferToYield(amountStroops: bigint): Promise<YieldDeployment> {
  if (amountStroops <= 0n) {
    throw new EarnError('Refusing to deploy a non-positive buffer amount', 'DEPOSIT_FAILED');
  }

  const opportunity = await bestYieldOpportunity();
  if (!opportunity) {
    throw new EarnError('No Earn venues available for USDC on this network', 'NO_OPPORTUNITIES');
  }

  const client = await getPollarClient();
  const deployedAt = new Date().toISOString();

  if (!client || pollarMode === 'mock') {
    return {
      opportunity,
      principalStroops: amountStroops.toString(),
      transactionHash: null,
      deployedAt,
      mode: 'mock',
    };
  }

  try {
    const outcome = await client.earnDeposit({
      provider: opportunity.provider as EarnProviderId,
      opportunity: opportunity.id,
      // The SDK takes a decimal string in the underlying asset, not base units.
      amount: fromStroops(amountStroops),
    });
    return {
      opportunity,
      principalStroops: amountStroops.toString(),
      transactionHash: outcome.hash ?? null,
      deployedAt,
      mode: 'live',
    };
  } catch (cause) {
    throw new EarnError(
      `Buffer deposit of ${formatUsdc(amountStroops)} USDC into ${opportunity.name} failed: ` +
        `${(cause as Error).message}`,
      'DEPOSIT_FAILED',
    );
  }
}

/**
 * Redeem principal plus accrued interest, immediately, because the parametric
 * circuit breaker has fired.
 *
 * Withdrawal units differ by provider -- Blend settles in the underlying
 * asset, DeFindex in vault shares -- so the live path reads the position to
 * learn `withdrawUnit` and `maxWithdraw` rather than assuming either.
 * Redeeming `maxWithdraw` rather than the original principal is deliberate:
 * the goal is to leave nothing behind.
 */
export async function emergencyYieldRedeem(
  principalStroops: bigint,
  options: { holdingPeriodDays?: number; walletAddress?: string } = {},
): Promise<YieldRedemption> {
  const holdingPeriodDays = options.holdingPeriodDays ?? 28;
  const opportunity = await bestYieldOpportunity();
  const client = await getPollarClient();

  if (!client || pollarMode === 'mock' || !options.walletAddress) {
    const apy = opportunity?.apy ?? 0;
    const accrued = simpleAccrual(principalStroops, apy, holdingPeriodDays);
    return {
      opportunity,
      principalStroops: principalStroops.toString(),
      accruedStroops: accrued.toString(),
      totalStroops: (principalStroops + accrued).toString(),
      holdingPeriodDays,
      transactionHash: null,
      mode: 'mock',
    };
  }

  if (!opportunity) {
    throw new EarnError('No venue to redeem from', 'NO_OPPORTUNITIES');
  }

  try {
    const position = await client.getEarnPosition({
      provider: opportunity.provider as EarnProviderId,
      opportunity: opportunity.id,
    });

    // `withdrawable` is already denominated in `withdrawUnit` -- the underlying
    // asset for Blend, vault shares for DeFindex -- which is exactly what
    // `earnWithdraw` expects. Passing the principal instead would silently
    // under-withdraw on a share-denominated vault, because one share is not
    // one USDC once any yield has accrued.
    const outcome = await client.earnWithdraw({
      provider: opportunity.provider as EarnProviderId,
      opportunity: opportunity.id,
      amount: position.withdrawable,
    });

    // `balance` is reported in underlying-asset terms regardless of
    // `withdrawUnit`, so it is the right basis for the accrual figure.
    const totalStroops = toStroops(position.balance);
    const accrued = totalStroops > principalStroops ? totalStroops - principalStroops : 0n;

    return {
      opportunity,
      principalStroops: principalStroops.toString(),
      accruedStroops: accrued.toString(),
      totalStroops: totalStroops.toString(),
      holdingPeriodDays,
      transactionHash: outcome.hash ?? null,
      mode: 'live',
    };
  } catch (cause) {
    throw new EarnError(
      `Emergency redemption from ${opportunity.name} failed: ${(cause as Error).message}`,
      'REDEEM_FAILED',
    );
  }
}

/**
 * Simple (not compounded) interest over a partial year, in integer stroops.
 *
 * Simple interest is the honest model here: a 4-6 week hold is far too short
 * for compounding frequency to be material, and claiming a compounded figure
 * we have not actually observed would overstate the buffer's return in a
 * financial UI. Scaling by 1e9 before dividing keeps the whole computation in
 * integer space.
 */
export function simpleAccrual(principal: bigint, apy: number, days: number): bigint {
  if (principal <= 0n || apy <= 0 || days <= 0) return 0n;
  const rateScaled = BigInt(Math.round(apy * 1_000_000_000));
  return (principal * rateScaled * BigInt(Math.round(days))) / (1_000_000_000n * 365n);
}

function normaliseOpportunity(o: EarnOpportunity, provider: EarnProviderId): YieldOpportunity {
  return {
    provider,
    id: o.id,
    name: o.name,
    symbol: o.symbol,
    kind: o.kind,
    assetCode: o.asset.code,
    apy: o.apy,
    mode: 'live',
  };
}

function byApyDescending(a: YieldOpportunity, b: YieldOpportunity): number {
  return b.apy - a.apy;
}
