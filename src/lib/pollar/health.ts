import 'server-only';

/**
 * Verified rail health.
 *
 * ## Why a probe, not a truthiness check
 *
 * The rail badges originally reported `live` whenever an API key *string was
 * present*. That is not the same claim. A key that is the wrong type, revoked,
 * scoped to the wrong network, or simply mistyped produces a badge that says
 * LIVE over a rail that answers `401` on every call.
 *
 * In a product whose whole pitch is "money actually moved", a green LIVE badge
 * above a dead integration is the single most damaging thing the interface
 * could show a judge. So the badge now has to earn itself: one real
 * authenticated request, cached, and `live` only if the provider answers.
 *
 * The probe is cached for a minute. Long enough that polling the dashboard
 * every six seconds does not hammer the provider or burn rate limit; short
 * enough that pasting a working key is reflected almost immediately.
 */

import { pollarConfig } from '@/lib/config';

export interface RailHealth {
  reachable: boolean;
  authenticated: boolean;
  status: number | null;
  detail: string;
  checkedAt: string;
}

const TTL_MS = 60_000;
let cached: { at: number; value: RailHealth } | null = null;
let inFlight: Promise<RailHealth> | null = null;

async function probe(): Promise<RailHealth> {
  const now = new Date().toISOString();

  if (!pollarConfig.apiKey) {
    return {
      reachable: false,
      authenticated: false,
      status: null,
      detail: 'No Pollar key configured.',
      checkedAt: now,
    };
  }

  try {
    // `/ramps/countries` is the cheapest authenticated read the SDK exposes:
    // no body, no side effects, and it fails closed on a bad key.
    const response = await fetch(`${pollarConfig.baseUrl}/v2/ramps/countries`, {
      headers: {
        accept: 'application/json',
        Authorization: `Bearer ${pollarConfig.apiKey}`,
      },
      signal: AbortSignal.timeout(8_000),
      cache: 'no-store',
    });

    if (response.ok) {
      return {
        reachable: true,
        authenticated: true,
        status: response.status,
        detail: `Authenticated against ${pollarConfig.baseUrl}/v2 (${pollarConfig.network}).`,
        checkedAt: now,
      };
    }

    // Read the provider's own error code so the dashboard can say *why*,
    // rather than just "not live". "Wrong key type" and "network unreachable"
    // need completely different fixes.
    let code = '';
    try {
      const body = (await response.json()) as { code?: string };
      code = body?.code ? ` (${body.code})` : '';
    } catch {
      /* non-JSON error body; the status alone is the signal */
    }

    return {
      reachable: true,
      authenticated: false,
      status: response.status,
      detail:
        response.status === 401
          ? `Key rejected with HTTP 401${code}. The SDK expects a publishable/secret ` +
            `key from dashboard.pollar.xyz, not a dashboard personal access token.`
          : `Pollar answered HTTP ${response.status}${code}.`,
      checkedAt: now,
    };
  } catch (cause) {
    return {
      reachable: false,
      authenticated: false,
      status: null,
      detail: `Could not reach Pollar: ${(cause as Error).message}`,
      checkedAt: now,
    };
  }
}

/**
 * Cached health. Concurrent callers share one in-flight probe rather than each
 * firing their own, which matters because every dashboard poll asks for this.
 */
export async function pollarHealth(): Promise<RailHealth> {
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
