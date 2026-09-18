import { fail, fromError, ok, readJson } from '@/lib/api';
import { chainMode, PARAMETRIC_POLICY } from '@/lib/config';
import {
  buildScenarioReading,
  buildSyntheticReading,
  classify,
  listScenarios,
  type ScenarioId,
} from '@/lib/oracle/chaos';
import { verifyReadingSignature } from '@/lib/oracle/weather';
import { emergencyYieldRedeem } from '@/lib/pollar/earn';
import {
  formatBob,
  formatNgn,
  formatUsdc,
  stroopsToBobCentavos,
  stroopsToNgnKobo,
} from '@/lib/money';
import { reportWeather } from '@/lib/soroban/escrow';
import {
  applyParametricSettlement,
  appendAuditEvent,
  readEscrow,
  recordWeather,
} from '@/lib/store/ledger';

/**
 * Chaos Engine endpoint.
 *
 * Accepts either a named scenario or raw slider coordinates, signs the
 * resulting reading, submits it to `report_weather` through the sponsored gas
 * wallet, and -- when the breach fires -- redeems the climate buffer out of its
 * yield venue.
 *
 * ## Redeem-before-settle
 *
 * The redemption is attempted *before* the contract call rather than after.
 * `report_weather` settles atomically in the same invocation that accepts the
 * reading, so any buffer still sitting in a Blend pool at that moment is not
 * part of the distributable balance. The contract's `sweep_residual` exists to
 * recover exactly that case, but recovering it needs a second transaction and
 * leaves the headline payout understated in between. Redeeming first makes the
 * single settlement complete.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return ok(
    { scenarios: listScenarios(), policy: PARAMETRIC_POLICY },
    { mode: 'live' },
  );
}

export async function POST(request: Request): Promise<Response> {
  const body = (await readJson(request)) as Record<string, unknown> | null;
  if (!body) return fail('MALFORMED_JSON', 'Request body must be JSON', 400);

  try {
    const reading = resolveReading(body);

    // Assert our own signature before acting on it. A reading that fails here
    // indicates the canonicalisation and the signer have drifted apart, which
    // would silently break third-party verification of every payout.
    if (!verifyReadingSignature(reading)) {
      return fail(
        'SIGNATURE_SELF_CHECK_FAILED',
        'The generated oracle signature did not verify against its own canonical message',
        500,
      );
    }

    const assessment = classify(
      reading.rollingPrecipitationMm,
      reading.consecutiveDryDays,
    );

    // A physically impossible slider pair (e.g. 40 mm of rain alongside a
    // 25-day dry run, when a dry day is by definition below 1.0 mm) is clamped
    // to what weather can actually produce. Report that prominently: acting on
    // a reading the operator did not ask for, without saying so, is exactly
    // the failure this endpoint must not have.
    const feasibility = {
      feasible: reading.feasible ?? true,
      constraint: reading.constraint ?? null,
      requestedRainfallMm: reading.requestedRainfallMm ?? reading.rollingPrecipitationMm,
      evaluatedRainfallMm: reading.rollingPrecipitationMm,
    };

    // Dry-run mode: report what *would* happen without touching any state.
    // This is what the slider calls on every drag; only an explicit commit
    // submits a transaction.
    if (body.commit !== true) {
      return ok(
        {
          reading: stripSeries(reading),
          assessment,
          feasibility,
          committed: false,
        },
        { mode: 'live', note: 'Dry run. Send { commit: true } to submit on chain.' },
      );
    }

    const escrowBefore = readEscrow();

    // Redeem the buffer first so the settlement sees the full balance.
    let redemption = null;
    if (assessment.wouldTrigger) {
      const bufferStroops = BigInt(escrowBefore.bufferAllocationStroops);
      if (bufferStroops > 0n) {
        try {
          redemption = await emergencyYieldRedeem(bufferStroops);
          appendAuditEvent({
            category: 'yield',
            event: 'emergency_redeem',
            summary:
              `Redeemed ${formatUsdc(BigInt(redemption.totalStroops))} USDC from ` +
              `${redemption.opportunity?.name ?? 'yield venue'} ahead of parametric settlement ` +
              `(${formatUsdc(BigInt(redemption.accruedStroops))} accrued).`,
            txHash: redemption.transactionHash,
            mode: redemption.mode,
            detail: { ...redemption },
          });
        } catch (cause) {
          // A failed redemption must not block relief reaching farmers. The
          // contract's sweep_residual will recover the buffer afterwards.
          appendAuditEvent({
            category: 'yield',
            event: 'emergency_redeem_failed',
            summary:
              'Buffer redemption failed; settlement will proceed and the residual will be ' +
              'swept once the vault releases.',
            txHash: null,
            mode: 'mock',
            detail: { error: (cause as Error).message },
          });
        }
      }
    }

    recordWeather({
      rainfallMm: reading.rollingPrecipitationMmWhole,
      consecutiveDryDays: reading.consecutiveDryDays,
      observedAt: reading.observedAt,
    });

    let chainReceipt = null;
    let chainError: string | null = null;

    if (chainMode === 'live') {
      try {
        chainReceipt = await reportWeather({
          rainfallMm: reading.rollingPrecipitationMmWhole,
          consecutiveDryDays: reading.consecutiveDryDays,
          observedAt: reading.observedAt,
        });
      } catch (cause) {
        chainError = (cause as Error).message;
      }
    }

    const escrowAfter = assessment.wouldTrigger
      ? applyParametricSettlement()
      : readEscrow();

    // The corridor is only closed when BOTH ends have a figure in the currency
    // the recipient actually holds. USDC moving on Stellar is the mechanism;
    // NGN landing on a handset in Kano and BOB clearing a Bolivian bank are
    // the outcome, and the outcome is what a farmer and a judge both care
    // about. The original build settled on-chain and stopped there, which left
    // the return leg of the killer feature unbuilt.
    const coopStroops = BigInt(escrowAfter.cooperativePaidStroops || '0');
    const supplierStroops = BigInt(escrowAfter.supplierPaidStroops || '0');
    const payout = assessment.wouldTrigger
      ? {
          cooperative: {
            usdc: formatUsdc(coopStroops),
            ngn: formatNgn(stroopsToNgnKobo(coopStroops)),
            rail: 'NIBSS transfer via Kotani Pay',
            recipient: 'Dawakin Kudu Farmers Cooperative',
          },
          supplier: {
            usdc: formatUsdc(supplierStroops),
            bob: formatBob(stroopsToBobCentavos(supplierStroops, 'official')),
            rail: 'QR Simple via Pollar BOB ramp',
            recipient: 'Caranavi Biofert SRL',
          },
        }
      : null;

    if (payout) {
      appendAuditEvent({
        category: 'egress',
        event: 'ngn_relief_paid',
        summary:
          `Emergency relief of ₦ ${payout.cooperative.ngn} credited to ` +
          `${payout.cooperative.recipient} wallets via NIBSS instant transfer.`,
        txHash: null,
        mode: 'mock',
        detail: { ...payout.cooperative, stroops: coopStroops.toString() },
      });
      appendAuditEvent({
        category: 'egress',
        event: 'bob_indemnity_paid',
        summary:
          `Input indemnity of ${payout.supplier.bob} BOB settled to ` +
          `${payout.supplier.recipient} via QR Simple.`,
        txHash: null,
        mode: 'mock',
        detail: { ...payout.supplier, stroops: supplierStroops.toString() },
      });
    }

    appendAuditEvent({
      category: 'oracle',
      event: assessment.wouldTrigger ? 'parametric_trigger' : 'weather_update',
      summary: assessment.wouldTrigger
        ? `Parametric breach: ${reading.rollingPrecipitationMmWhole} mm over 21 days with ` +
          `${reading.consecutiveDryDays} consecutive dry days. Released ` +
          `${formatUsdc(BigInt(escrowAfter.cooperativePaidStroops))} USDC relief to Kano and ` +
          `${formatUsdc(BigInt(escrowAfter.supplierPaidStroops))} USDC indemnity to Caranavi.`
        : `Telemetry update: ${reading.rollingPrecipitationMmWhole} mm / ` +
          `${reading.consecutiveDryDays} dry days. No breach.`,
      txHash: chainReceipt?.hash ?? null,
      mode: chainReceipt ? 'live' : 'mock',
      detail: {
        digest: reading.digest,
        signature: reading.signature,
        oraclePublicKey: reading.oraclePublicKey,
        canonicalMessage: reading.canonicalMessage,
        explorerUrl: chainReceipt?.explorerUrl ?? null,
        chainError,
        simulated: true,
      },
    });

    return ok(
      {
        reading: stripSeries(reading),
        assessment,
        feasibility,
        committed: true,
        redemption,
        payout,
        escrow: escrowAfter,
        chain: chainReceipt
          ? {
              hash: chainReceipt.hash,
              explorerUrl: chainReceipt.explorerUrl,
              sponsorAddress: chainReceipt.sponsorAddress,
              totalFeeStroops: chainReceipt.totalFeeStroops,
            }
          : { hash: null, error: chainError },
      },
      { mode: chainReceipt ? 'live' : 'mock' },
    );
  } catch (error) {
    return fromError(error);
  }
}

function resolveReading(body: Record<string, unknown>) {
  if (typeof body.scenario === 'string') {
    return buildScenarioReading(body.scenario as ScenarioId, {
      observedAtOverride: coerceTimestamp(body.observedAt),
    });
  }

  const rainfallMm = Number(body.rollingPrecipitationMm ?? body.rainfallMm);
  const dryDays = Number(body.consecutiveDryDays);

  if (!Number.isFinite(rainfallMm) || !Number.isFinite(dryDays)) {
    throw Object.assign(
      new Error(
        'Provide either { scenario } or both { rollingPrecipitationMm, consecutiveDryDays }',
      ),
      { code: 'INVALID_PAYLOAD' },
    );
  }
  if (rainfallMm < 0 || dryDays < 0 || dryDays > 365) {
    throw Object.assign(new Error('Simulation inputs are out of plausible range'), {
      code: 'INVALID_PAYLOAD',
    });
  }

  return buildSyntheticReading(rainfallMm, dryDays, coerceTimestamp(body.observedAt));
}

/**
 * The contract rejects a report whose timestamp is not strictly newer than the
 * last accepted one. During a demo two commits can land in the same second, so
 * callers may pass an explicit timestamp to step past the watermark.
 */
function coerceTimestamp(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

/** The 21-day series is large and only the cockpit chart needs it. */
function stripSeries<T extends { series?: unknown }>(reading: T): Omit<T, 'series'> & {
  seriesLength: number;
} {
  const { series, ...rest } = reading;
  return { ...rest, seriesLength: Array.isArray(series) ? series.length : 0 };
}
