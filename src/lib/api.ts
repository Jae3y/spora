import { NextResponse } from 'next/server';

/**
 * Uniform API envelope.
 *
 * Two problems every route in this app shares:
 *
 * 1. **`BigInt` is not JSON-serialisable.** `JSON.stringify(1n)` throws
 *    outright. Since every monetary value in this system is a `bigint`, a
 *    naive `NextResponse.json()` would 500 on the happy path. {@link jsonSafe}
 *    coerces them to strings, preserving exactness -- a `Number` coercion
 *    would silently lose precision above 2^53, which is only ~900 million
 *    USDC and well inside the range a real corridor could reach.
 *
 * 2. **Mode disclosure.** Every response states which rails were live, so a
 *    reviewer never has to guess whether a result came from a real settlement
 *    or a mock engine.
 */

export interface ApiMeta {
  mode?: 'live' | 'mock';
  [key: string]: unknown;
}

export interface ApiSuccess<T> {
  ok: true;
  data: T;
  meta: ApiMeta;
}

export interface ApiFailure {
  ok: false;
  error: { code: string; message: string; detail?: unknown };
  meta: ApiMeta;
}

/**
 * Recursively replace `bigint` with its decimal string form.
 *
 * Applied at the response boundary rather than at each call site so no future
 * route can forget and crash in production.
 */
export function jsonSafe<T>(value: T): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, jsonSafe(v)]),
    );
  }
  return value;
}

export function ok<T>(data: T, meta: ApiMeta = {}, status = 200): NextResponse {
  return NextResponse.json(
    { ok: true, data: jsonSafe(data), meta: jsonSafe(meta) } as ApiSuccess<unknown>,
    { status },
  );
}

export function fail(
  code: string,
  message: string,
  status = 400,
  detail?: unknown,
  meta: ApiMeta = {},
): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: { code, message, detail: jsonSafe(detail) },
      meta: jsonSafe(meta),
    } as ApiFailure,
    { status },
  );
}

/**
 * Convert a thrown value into a response.
 *
 * Errors in this codebase carry a `code` discriminant; anything without one is
 * an unexpected fault and is reported as `INTERNAL` with a 500, never with a
 * misleading 400. The message is passed through because every error raised
 * here is authored by us and contains no secrets -- the one place that could
 * leak (a malformed Stellar seed) is scrubbed at its own throw site.
 */
export function fromError(error: unknown, fallbackStatus = 500): NextResponse {
  if (error && typeof error === 'object' && 'code' in error && 'message' in error) {
    const code = String((error as { code: unknown }).code);
    const message = String((error as { message: unknown }).message);
    const status = statusForCode(code, fallbackStatus);
    return fail(code, message, status);
  }
  return fail('INTERNAL', (error as Error)?.message ?? 'Unexpected error', fallbackStatus);
}

function statusForCode(code: string, fallback: number): number {
  switch (code) {
    case 'INVALID_PHONE':
    case 'INVALID_AMOUNT':
    case 'NonPositiveAmount':
    case 'MALFORMED_ENVELOPE':
      return 400;
    case 'NO_SIGNER':
    case 'NO_SEED':
    case 'NOT_CONFIGURED':
      return 503;
    case 'NOT_DEPLOYED':
    case 'NO_OPPORTUNITIES':
      return 409;
    case 'TIMEOUT':
      return 504;
    default:
      return fallback;
  }
}

/** Parse a JSON body, returning `null` rather than throwing on malformed input. */
export async function readJson(request: Request): Promise<unknown | null> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
