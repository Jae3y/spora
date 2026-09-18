import 'server-only';

/**
 * Server-side `PollarClient` provisioning.
 *
 * `@pollar/core` is primarily a browser/React-Native wallet SDK: it persists
 * sessions to `localStorage`, mints DPoP proofs via `crypto.subtle`, and
 * assumes a long-lived tab. Running it inside a Next.js route handler needs
 * two accommodations:
 *
 * 1. **Memory-backed storage.** `defaultStorage()` reaches for `localStorage`,
 *    which does not exist in the Node runtime. `createMemoryAdapter()` is the
 *    SDK's own supported substitute.
 * 2. **Never throw at import.** A route that merely *reads* escrow state must
 *    not 500 because Pollar is unreachable. Initialisation failures resolve to
 *    `null` and the caller degrades to its mock engine.
 *
 * The client is memoised per process. Rebuilding it per request would discard
 * the learned DPoP nonce and clock-skew offset, forcing an extra challenge
 * round trip on every single call.
 */

import { PollarClient, createMemoryAdapter } from '@pollar/core';
import { pollarConfig, pollarMode } from '@/lib/config';

let cached: Promise<PollarClient | null> | null = null;

/** How long to wait for `ready()` before giving up and degrading to mock. */
const READY_TIMEOUT_MS = 8_000;

/**
 * Resolve the shared client, or `null` when Pollar is unconfigured or
 * unreachable. Callers must handle `null` -- that is the fail-safe contract,
 * not an exceptional path.
 */
export function getPollarClient(): Promise<PollarClient | null> {
  if (!cached) cached = initialise();
  return cached;
}

async function initialise(): Promise<PollarClient | null> {
  if (pollarMode === 'mock' || !pollarConfig.apiKey) return null;

  try {
    const client = new PollarClient({
      apiKey: pollarConfig.apiKey,
      baseUrl: pollarConfig.baseUrl,
      stellarNetwork: pollarConfig.network,
      // Node has no localStorage; this is the SDK's sanctioned fallback.
      storage: createMemoryAdapter(),
      requestTimeoutMs: 10_000,
      submitTimeoutMs: 30_000,
    });

    // `ready()` resolves once the key manager has initialised and any
    // persisted session has been restored. Bound it: an unreachable Pollar
    // must not hang a route handler until the platform's own timeout.
    await withTimeout(client.ready(), READY_TIMEOUT_MS, 'PollarClient.ready()');
    return client;
  } catch (cause) {
    // Logged once per process, not per request -- the memoised promise means
    // a failed initialisation is not retried in a hot loop.
    console.warn(
      `[spora/pollar] Client unavailable, degrading to mock engines: ${(cause as Error).message}`,
    );
    return null;
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Drop the memoised client, forcing re-initialisation on next access. */
export function resetPollarClient(): void {
  cached = null;
}
