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

/**
 * Pollar's authentication scheme, read off the SDK rather than guessed.
 *
 * `@pollar/core` sets `x-pollar-api-key` on every outbound request -- it does
 * not use `Authorization: Bearer`. A Bearer probe answers
 * `401 API_KEY_NOT_FOUND` no matter how valid the key is, which would have
 * shown this rail as permanently dead while the key was perfectly good.
 *
 * The two key types are not interchangeable. Public reads such as
 * `/ramps/countries` want the **publishable** key and answer
 * `403 API_KEY_TYPE_NOT_ALLOWED` to a secret one; the secret key is for the
 * privileged server surface. The probe therefore tries the publishable key
 * first and falls back, so a half-configured app still reports something
 * actionable instead of a flat "not live".
 */
function pollarHeaders(key: string): HeadersInit {
  return {
    accept: 'application/json',
    'x-pollar-api-key': key,
    // Pollar allow-lists origins per application and treats a missing Origin
    // as disallowed, so a server-side call must present one explicitly.
    Origin: pollarConfig.appOrigin,
  };
}

async function probe(): Promise<RailHealth> {
  const now = new Date().toISOString();

  const key = pollarConfig.publishableKey ?? pollarConfig.apiKey;

  if (!key) {
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
      headers: pollarHeaders(key),
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
      detail: explain(response.status, code),
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

/**
 * Turn Pollar's error code into the fix, not just the symptom.
 *
 * Each of these fails the same way from the dashboard's point of view -- no
 * green badge -- but they need completely different actions, and a judge
 * reading "not live" learns nothing. Naming the remedy is the difference
 * between a broken demo and a demo that is honest about its configuration.
 */
function explain(status: number, code: string): string {
  if (code.includes('ORIGIN_NOT_ALLOWED')) {
    return (
      `Key accepted, origin refused${code}. Add ${pollarConfig.appOrigin} to the ` +
      `application's allowed origins at dashboard.pollar.xyz and set ` +
      `POLLAR_APP_ORIGIN to the deployed URL in production.`
    );
  }
  if (code.includes('API_KEY_TYPE_NOT_ALLOWED')) {
    return (
      `Wrong key type for this endpoint${code}. Public reads need the ` +
      `pub_… publishable key; sec_… is for the privileged server surface.`
    );
  }
  if (code.includes('API_KEY_NOT_FOUND') || status === 401) {
    return (
      `Key rejected with HTTP ${status}${code}. Pollar authenticates with the ` +
      `x-pollar-api-key header and a pub_/sec_ application key -- a pat_… ` +
      `personal access token is not accepted here.`
    );
  }
  return `Pollar answered HTTP ${status}${code}.`;
}
