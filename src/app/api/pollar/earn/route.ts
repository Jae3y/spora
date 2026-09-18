import { fail, fromError, ok, readJson } from '@/lib/api';
import { formatUsdc, parseStroops } from '@/lib/money';
import {
  depositBufferToYield,
  emergencyYieldRedeem,
  listYieldOpportunities,
  simpleAccrual,
} from '@/lib/pollar/earn';
import { appendAuditEvent, readEscrow, recordYieldDeployment } from '@/lib/store/ledger';

/**
 * Pollar Earn: inspect venues, deploy the climate buffer, redeem it.
 *
 * `GET` also projects the buffer's expected return over the shipment window so
 * the cockpit can show what the float is earning without having to deploy it
 * first -- the projection uses the same {@link simpleAccrual} function the
 * redemption path uses, so the estimate and the settlement cannot disagree
 * about the model.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Nominal Caranavi -> Kano transit window used for yield projection. */
const TRANSIT_WINDOW_DAYS = 28;

export async function GET(): Promise<Response> {
  try {
    const opportunities = await listYieldOpportunities();
    const escrow = readEscrow();
    const buffer = BigInt(escrow.bufferAllocationStroops);
    const best = opportunities[0] ?? null;

    const projectedStroops = best ? simpleAccrual(buffer, best.apy, TRANSIT_WINDOW_DAYS) : 0n;

    return ok(
      {
        opportunities,
        best,
        buffer: {
          stroops: buffer.toString(),
          usdc: formatUsdc(buffer),
          deployedStroops: escrow.bufferDeployedStroops,
          accruedStroops: escrow.accruedYieldStroops,
        },
        projection: {
          windowDays: TRANSIT_WINDOW_DAYS,
          apy: best?.apy ?? 0,
          stroops: projectedStroops.toString(),
          usdc: formatUsdc(projectedStroops),
          model: 'simple interest, not compounded',
        },
      },
      { mode: best?.mode ?? 'mock' },
    );
  } catch (error) {
    return fromError(error);
  }
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  const action = typeof body?.action === 'string' ? body.action : null;

  try {
    if (action === 'deploy') {
      const escrow = readEscrow();
      const requested = body?.stroops
        ? parseStroops(String(body.stroops))
        : BigInt(escrow.bufferAllocationStroops);

      if (requested <= 0n) {
        return fail(
          'INVALID_AMOUNT',
          'There is no climate buffer to deploy; fund the escrow first.',
          409,
        );
      }
      // The buffer is the only capital eligible for yield. Deploying more
      // would put the supplier's input allocation at venue risk, which the
      // 90/10 split exists specifically to prevent.
      const buffer = BigInt(escrow.bufferAllocationStroops);
      if (requested > buffer) {
        return fail(
          'EXCEEDS_BUFFER',
          `Refusing to deploy ${formatUsdc(requested)} USDC: the climate buffer is only ` +
            `${formatUsdc(buffer)} USDC. The 90% input allocation is not eligible for yield.`,
          409,
        );
      }

      const deployment = await depositBufferToYield(requested);
      const projected = simpleAccrual(
        requested,
        deployment.opportunity.apy,
        TRANSIT_WINDOW_DAYS,
      );
      recordYieldDeployment(requested, projected);

      appendAuditEvent({
        category: 'yield',
        event: 'buffer_deployed',
        summary:
          `Deployed ${formatUsdc(requested)} USDC climate buffer into ` +
          `${deployment.opportunity.name} at ${(deployment.opportunity.apy * 100).toFixed(2)}% APY.`,
        txHash: deployment.transactionHash,
        mode: deployment.mode,
        detail: {
          opportunity: deployment.opportunity,
          projectedYieldStroops: projected.toString(),
          windowDays: TRANSIT_WINDOW_DAYS,
        },
      });

      return ok(
        { deployment, projectedYieldStroops: projected.toString() },
        { mode: deployment.mode },
      );
    }

    if (action === 'redeem') {
      const escrow = readEscrow();
      const principal = BigInt(escrow.bufferDeployedStroops || escrow.bufferAllocationStroops);
      if (principal <= 0n) {
        return fail('NOTHING_DEPLOYED', 'No buffer is currently deployed', 409);
      }

      const redemption = await emergencyYieldRedeem(principal, {
        holdingPeriodDays: TRANSIT_WINDOW_DAYS,
      });
      recordYieldDeployment(0n, BigInt(redemption.accruedStroops));

      appendAuditEvent({
        category: 'yield',
        event: 'buffer_redeemed',
        summary:
          `Redeemed ${formatUsdc(BigInt(redemption.totalStroops))} USDC ` +
          `(${formatUsdc(BigInt(redemption.accruedStroops))} accrued) from ` +
          `${redemption.opportunity?.name ?? 'yield venue'}.`,
        txHash: redemption.transactionHash,
        mode: redemption.mode,
        detail: { ...redemption },
      });

      return ok({ redemption }, { mode: redemption.mode });
    }

    return fail('UNKNOWN_ACTION', 'action must be one of: deploy, redeem', 400);
  } catch (error) {
    return fromError(error);
  }
}
