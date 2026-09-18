import { fromError, ok } from '@/lib/api';
import { KANO_COORDINATES, PARAMETRIC_POLICY } from '@/lib/config';
import { classify } from '@/lib/oracle/chaos';
import { fetchSignedReading, verifyReadingSignature } from '@/lib/oracle/weather';

/**
 * Live satellite precipitation reading for the Kano savanna belt.
 *
 * Read-only: it fetches, reduces and signs, but never submits to the contract.
 * Committing a reading is the Chaos Engine's job (`/api/oracle/simulate`),
 * which keeps the one endpoint that can move money explicit rather than
 * something a `GET` might trigger by accident — including from a link
 * prefetch or a crawler.
 *
 * `sourceLagDays` is surfaced prominently because the reading's *age* is as
 * decisive as its value: a drought breach computed from six-day-old telemetry
 * is a different risk statement from one computed today.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const reading = await fetchSignedReading();
    const assessment = classify(reading.rollingPrecipitationMm, reading.consecutiveDryDays);

    return ok(
      {
        location: KANO_COORDINATES,
        policy: PARAMETRIC_POLICY,
        reading: {
          rollingPrecipitationMm: reading.rollingPrecipitationMm,
          rollingPrecipitationMmWhole: reading.rollingPrecipitationMmWhole,
          consecutiveDryDays: reading.consecutiveDryDays,
          observationDate: reading.observationDate,
          observedAt: reading.observedAt,
          sourceLagDays: reading.sourceLagDays,
          source: reading.source,
          wouldTrigger: reading.wouldTrigger,
          series: reading.series,
        },
        assessment,
        attestation: {
          canonicalMessage: reading.canonicalMessage,
          digest: reading.digest,
          signature: reading.signature,
          oraclePublicKey: reading.oraclePublicKey,
          // Self-verified before leaving the server, so a consumer never has
          // to trust that the signature and the message actually correspond.
          verified: verifyReadingSignature(reading),
        },
      },
      { mode: 'live' },
    );
  } catch (error) {
    return fromError(error, 502);
  }
}
