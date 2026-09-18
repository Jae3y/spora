import 'server-only';

/**
 * Satellite precipitation oracle for the Kano savanna belt.
 *
 * ## Endpoint choice
 *
 * Open-Meteo exposes two relevant APIs and they are *not* interchangeable
 * here:
 *
 * - `archive-api.open-meteo.com/v1/archive` is the reanalysis archive. It is
 *   authoritative, but it lags real time by roughly five days.
 * - `api.open-meteo.com/v1/forecast` with `past_days` returns recent observed
 *   and analysed precipitation right up to today.
 *
 * A drought circuit breaker that reads five-day-old data would keep paying a
 * supplier through the first five days of a failing season. This module
 * therefore reads the **forecast endpoint with `past_days`** for the live
 * parametric window, and falls back to the archive only if that fails --
 * accepting stale data is better than accepting none, but the staleness is
 * reported in `sourceLag` so the contract call can be held back if a human
 * decides the lag is unacceptable.
 *
 * ## The two derived quantities
 *
 * - `P_rolling`: cumulative precipitation over the trailing 21 days, in mm.
 * - `D_consecutive`: length of the *current* run of days below 1.0 mm,
 *   counted backwards from the most recent complete observation.
 */

import { Keypair } from '@stellar/stellar-sdk';
import { createHash } from 'node:crypto';
import { KANO_COORDINATES, PARAMETRIC_POLICY, stellarConfig } from '@/lib/config';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const ARCHIVE_URL = 'https://archive-api.open-meteo.com/v1/archive';

export interface DailyPrecipitation {
  date: string;
  precipitationMm: number;
}

export interface WeatherReading {
  /** Cumulative precipitation over the trailing 21 days, in mm. */
  rollingPrecipitationMm: number;
  /** Rounded down to whole mm for the contract, which takes a `u32`. */
  rollingPrecipitationMmWhole: number;
  /** Current run of consecutive days below 1.0 mm. */
  consecutiveDryDays: number;
  /** Unix seconds of the most recent observation. */
  observedAt: number;
  observationDate: string;
  latitude: number;
  longitude: number;
  /** Days between the last observation and now. */
  sourceLagDays: number;
  source: 'forecast' | 'archive' | 'synthetic';
  series: DailyPrecipitation[];
  thresholdMm: number;
  wouldTrigger: boolean;
}

export interface SignedWeatherReading extends WeatherReading {
  /** Canonical string the signature covers. */
  canonicalMessage: string;
  /** SHA-256 of the canonical message, hex. */
  digest: string;
  /** Ed25519 signature, base64. */
  signature: string;
  /** Oracle's Stellar public key. */
  oraclePublicKey: string;
}

export class OracleError extends Error {
  constructor(
    message: string,
    readonly code: 'FETCH_FAILED' | 'MALFORMED_RESPONSE' | 'NO_ORACLE_KEY',
  ) {
    super(message);
    this.name = 'OracleError';
  }
}

/**
 * Fetch and reduce the trailing precipitation window.
 *
 * `past_days` is requested slightly wider than the 21-day rolling window so a
 * missing trailing day (common at the boundary of a reporting period) still
 * leaves a full 21 observations to sum.
 */
export async function fetchKanoPrecipitation(
  options: { pastDays?: number } = {},
): Promise<WeatherReading> {
  const pastDays = options.pastDays ?? 31;

  try {
    const series = await fetchForecastSeries(pastDays);
    return reduceSeries(series, 'forecast');
  } catch (forecastError) {
    console.warn(
      `[spora/oracle] Forecast endpoint unavailable, trying archive: ` +
        `${(forecastError as Error).message}`,
    );
    try {
      const series = await fetchArchiveSeries(pastDays);
      return reduceSeries(series, 'archive');
    } catch (archiveError) {
      throw new OracleError(
        `Both Open-Meteo endpoints failed. forecast=${(forecastError as Error).message}; ` +
          `archive=${(archiveError as Error).message}`,
        'FETCH_FAILED',
      );
    }
  }
}

async function fetchForecastSeries(pastDays: number): Promise<DailyPrecipitation[]> {
  const url = new URL(FORECAST_URL);
  url.searchParams.set('latitude', String(KANO_COORDINATES.latitude));
  url.searchParams.set('longitude', String(KANO_COORDINATES.longitude));
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('past_days', String(Math.min(pastDays, 92)));
  url.searchParams.set('forecast_days', '1');
  url.searchParams.set('timezone', KANO_COORDINATES.timezone);
  return parseDailyResponse(await getJson(url));
}

async function fetchArchiveSeries(pastDays: number): Promise<DailyPrecipitation[]> {
  const end = new Date();
  // The reanalysis archive is not populated for the last ~5 days.
  end.setUTCDate(end.getUTCDate() - 5);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - pastDays);

  const url = new URL(ARCHIVE_URL);
  url.searchParams.set('latitude', String(KANO_COORDINATES.latitude));
  url.searchParams.set('longitude', String(KANO_COORDINATES.longitude));
  url.searchParams.set('daily', 'precipitation_sum');
  url.searchParams.set('start_date', isoDate(start));
  url.searchParams.set('end_date', isoDate(end));
  url.searchParams.set('timezone', KANO_COORDINATES.timezone);
  return parseDailyResponse(await getJson(url));
}

async function getJson(url: URL): Promise<unknown> {
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15_000),
    headers: { accept: 'application/json' },
    // Precipitation updates hourly at best; a short cache avoids hammering a
    // free public API while keeping the reading operationally fresh.
    next: { revalidate: 900 },
  });
  if (!response.ok) {
    throw new OracleError(
      `Open-Meteo responded HTTP ${response.status} for ${url.pathname}`,
      'FETCH_FAILED',
    );
  }
  return response.json();
}

function parseDailyResponse(body: unknown): DailyPrecipitation[] {
  const daily = (body as { daily?: { time?: unknown; precipitation_sum?: unknown } })?.daily;
  const time = daily?.time;
  const sums = daily?.precipitation_sum;

  if (!Array.isArray(time) || !Array.isArray(sums) || time.length !== sums.length) {
    throw new OracleError(
      'Open-Meteo response did not contain aligned daily.time / daily.precipitation_sum arrays',
      'MALFORMED_RESPONSE',
    );
  }

  return time
    .map((date, i) => ({
      date: String(date),
      // Open-Meteo emits `null` for days with no observation. Treating null as
      // 0 mm would manufacture an artificial dry day and could fire the
      // breaker on a data gap, so those days are dropped instead.
      precipitationMm: typeof sums[i] === 'number' ? (sums[i] as number) : Number.NaN,
    }))
    .filter((d) => Number.isFinite(d.precipitationMm));
}

/**
 * Reduce a daily series to the two parametric quantities.
 *
 * Exported so the chaos engine and the tests can exercise the exact same
 * reduction the live path uses.
 */
export function reduceSeries(
  series: DailyPrecipitation[],
  source: WeatherReading['source'],
): WeatherReading {
  if (!series.length) {
    throw new OracleError('Precipitation series is empty after filtering', 'MALFORMED_RESPONSE');
  }

  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const window = sorted.slice(-PARAMETRIC_POLICY.rollingWindowDays);

  const rolling = window.reduce((sum, d) => sum + d.precipitationMm, 0);

  // Walk backwards from the most recent day; the run ends at the first day
  // that met or exceeded the dry-day ceiling.
  let consecutiveDryDays = 0;
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    if (sorted[i].precipitationMm < PARAMETRIC_POLICY.dryDayRainfallCeilingMm) {
      consecutiveDryDays += 1;
    } else {
      break;
    }
  }

  const last = sorted[sorted.length - 1];
  const observedAt = Math.floor(Date.parse(`${last.date}T12:00:00Z`) / 1000);
  const sourceLagDays = Math.max(
    0,
    Math.round((Date.now() / 1000 - observedAt) / 86_400),
  );

  // Floor rather than round: the contract compares `rainfall < threshold`, and
  // rounding 19.6 up to 20 would suppress a breach that genuinely occurred.
  const rollingWhole = Math.floor(rolling);

  return {
    rollingPrecipitationMm: Number(rolling.toFixed(2)),
    rollingPrecipitationMmWhole: rollingWhole,
    consecutiveDryDays,
    observedAt,
    observationDate: last.date,
    latitude: KANO_COORDINATES.latitude,
    longitude: KANO_COORDINATES.longitude,
    sourceLagDays,
    source,
    series: sorted,
    thresholdMm: PARAMETRIC_POLICY.thresholdMm,
    wouldTrigger:
      rollingWhole < PARAMETRIC_POLICY.thresholdMm &&
      consecutiveDryDays >= PARAMETRIC_POLICY.dryDayTrigger,
  };
}

// ---------------------------------------------------------------------------
// signing
// ---------------------------------------------------------------------------

/**
 * Canonical serialisation of a reading.
 *
 * Fixed field order and fixed precision are what make the signature
 * reproducible. Signing `JSON.stringify(reading)` would be fragile: key order
 * is insertion-dependent, and a float's shortest round-trip representation can
 * differ across runtimes, so a verifier could reconstruct a byte-different
 * message from semantically identical data and reject a valid signature.
 */
export function canonicaliseReading(reading: WeatherReading): string {
  return [
    'spora.oracle.v1',
    `lat=${reading.latitude.toFixed(4)}`,
    `lon=${reading.longitude.toFixed(4)}`,
    `window=${PARAMETRIC_POLICY.rollingWindowDays}`,
    `rain_mm=${reading.rollingPrecipitationMmWhole}`,
    `dry_days=${reading.consecutiveDryDays}`,
    `observed_at=${reading.observedAt}`,
    `threshold_mm=${reading.thresholdMm}`,
    `source=${reading.source}`,
  ].join('|');
}

/**
 * Sign a reading with the oracle's Ed25519 key.
 *
 * The contract authorises `report_weather` via `oracle.require_auth()`, so the
 * on-chain authority is the transaction signature itself. This detached
 * signature serves a different purpose: it lets any third party verify, off
 * chain and after the fact, that a particular telemetry reading originated
 * from this oracle -- which is what makes the parametric trigger auditable by
 * someone who does not trust our API.
 */
export function signReading(reading: WeatherReading): SignedWeatherReading {
  const canonicalMessage = canonicaliseReading(reading);
  const digest = createHash('sha256').update(canonicalMessage).digest('hex');

  // Without a configured oracle key, a deterministic per-process key still
  // produces a genuinely valid signature over the real payload. The demo
  // exercises the true verification path; only the identity is ephemeral.
  const keypair = stellarConfig.oracleSecret
    ? Keypair.fromSecret(stellarConfig.oracleSecret)
    : ephemeralOracleKeypair();

  const signature = keypair.sign(Buffer.from(canonicalMessage, 'utf8')).toString('base64');

  return {
    ...reading,
    canonicalMessage,
    digest,
    signature,
    oraclePublicKey: keypair.publicKey(),
  };
}

/** Verify a detached oracle signature. */
export function verifyReadingSignature(reading: SignedWeatherReading): boolean {
  try {
    const keypair = Keypair.fromPublicKey(reading.oraclePublicKey);
    return keypair.verify(
      Buffer.from(reading.canonicalMessage, 'utf8'),
      Buffer.from(reading.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

let cachedEphemeral: Keypair | null = null;
function ephemeralOracleKeypair(): Keypair {
  if (!cachedEphemeral) cachedEphemeral = Keypair.random();
  return cachedEphemeral;
}

/** Public key the oracle will sign with, for display in the cockpit. */
export function oraclePublicKey(): string {
  return stellarConfig.oracleSecret
    ? Keypair.fromSecret(stellarConfig.oracleSecret).publicKey()
    : ephemeralOracleKeypair().publicKey();
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Fetch and sign in one step -- the shape API routes actually want. */
export async function fetchSignedReading(): Promise<SignedWeatherReading> {
  return signReading(await fetchKanoPrecipitation());
}
