import { fromError, ok } from '@/lib/api';
import { readConsensus, AGREEMENT_TOLERANCE_MM, QUORUM, SOURCES } from '@/lib/oracle/consensus';

/**
 * Multi-source oracle consensus.
 *
 * Read-only. It reports whether three independently-operated weather models
 * corroborate each other, and refuses to endorse a trigger when they do not.
 *
 * Deliberately separate from the endpoint that can move money: a `GET` should
 * never be able to settle a contract, and keeping the quorum check on its own
 * route means the dashboard can display the corroboration status continuously
 * without any risk of firing something.
 */
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  try {
    const consensus = await readConsensus();
    return ok(
      {
        consensus,
        policy: {
          quorum: QUORUM,
          totalSources: SOURCES.length,
          agreementToleranceMm: AGREEMENT_TOLERANCE_MM,
        },
      },
      { mode: 'live' },
    );
  } catch (error) {
    return fromError(error, 502);
  }
}
