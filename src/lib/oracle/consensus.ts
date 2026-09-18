import 'server-only';

/**
 * Multi-source oracle consensus.
 *
 * ## The risk this closes
 *
 * A parametric contract that trusts one feed has a single point of failure
 * that is also a single point of *attack*: whoever controls that endpoint
 * controls whether farmers get paid. The mitigation is quorum — read several
 * independent sources and require them to agree before the breaker is allowed
 * to fire.
 *
 * ## Where the independence actually comes from
 *
 * These are not three calls to the same number. Open-Meteo serves several
 * genuinely distinct numerical weather models, each run by a different
 * meteorological agency on its own assimilation pipeline:
 *
 * | Model      | Operated by                                   |
 * |------------|-----------------------------------------------|
 * | ECMWF IFS  | European Centre for Medium-Range Weather      |
 * | NOAA GFS   | US National Oceanic and Atmospheric Admin.    |
 * | DWD ICON   | Deutscher Wetterdienst                        |
 *
 * They disagree in the normal course of events, which is the point: agreement
 * between three independently-produced analyses is evidence, where three reads
 * of one number is just the same number three times.
 *
 * It is honest to be precise about what this does and does not buy. Sharing
 * Open-Meteo as a *transport* means a compromise of Open-Meteo itself is still
 * a common-mode failure. What quorum removes is the far likelier case: one
 * model producing a bad grid cell, a stale run, or a localised artefact.
 * Eliminating the transport risk needs a second provider on a different
 * domain, which is a deployment decision rather than a code one.
 *
 * ## Why disagreement blocks rather than averages
 *
 * Averaging three sources when one is wildly wrong produces a number no model
 * actually reported, and quietly launders the outlier into a payout. Quorum
 * refuses instead: if the sources do not agree, the contract is not called and
 * the disagreement is surfaced for a human. Refusing to pay on bad data is
 * recoverable. Paying on bad data is not.
 */

import { KANO_COORDINATES, PARAMETRIC_POLICY } from '@/lib/config';
import { reduceSeries, type DailyPrecipitation, type WeatherReading } from './weather';

export type SourceId = 'ecmwf' | 'gfs' | 'icon';

interface SourceSpec {
  id: SourceId;
  label: string;
  agency: string;
  /** Open-Meteo `models=` identifier. */
  model: string;
}

export const SOURCES: SourceSpec[] = [
  { id: 'ecmwf', label: 'ECMWF IFS', agency: 'European Centre for Medium-Range Weather Forecasts', model: 'ecmwf_ifs025' },
  { id: 'gfs', label: 'NOAA GFS', agency: 'US National Oceanic and Atmospheric Administration', model: 'gfs_seamless' },
  { id: 'icon', label: 'DWD ICON', agency: 'Deutscher Wetterdienst', model: 'icon_seamless' },
];

/**
 * Sources must agree on rainfall to within this many millimetres for the
 * reading to be considered corroborated.
 *
 * 6 mm over a 21-day window is roughly a quarter of the 20 mm threshold. Tight
 * enough that a genuinely divergent model is caught; loose enough that normal
 * inter-model spread over a tropical highland does not block every payout.
 */
export const AGREEMENT_TOLERANCE_MM = 6;

/** Minimum sources that must both respond AND agree. */
export const QUORUM = 2;

export interface SourceReading {
  id: SourceId;
  label: string;
  agency: string;
  ok: boolean;
  rollingMm: number | null;
  dryDays: number | null;
  wouldTrigger: boolean | null;
  error: string | null;
}

export interface ConsensusResult {
  sources: SourceReading[];
  respondedCount: number;
  /** Sources whose rainfall sits within tolerance of the median. */
  agreeingCount: number;
  quorumMet: boolean;
  /** Median across agreeing sources. Median, not mean: one wild outlier
      cannot drag it, where a mean would be pulled toward the bad reading. */
  consensusRainfallMm: number | null;
  consensusDryDays: number | null;
  /** True only when quorum is met AND the agreed reading breaches. */
  wouldTrigger: boolean;
  /** Non-null when the breaker is blocked; explains why, for a human. */
  blockedReason: string | null;
  spreadMm: number | null;
}

async function fetchModel(spec: SourceSpec, pastDays: number): Promise<SourceReading> {
  const base: Omit<SourceReading, 'ok' | 'rollingMm' | 'dryDays' | 'wouldTrigger' | 'error'> = {
    id: spec.id,
    label: spec.label,
    agency: spec.agency,
  };

  try {
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(KANO_COORDINATES.latitude));
    url.searchParams.set('longitude', String(KANO_COORDINATES.longitude));
    url.searchParams.set('daily', 'precipitation_sum');
    url.searchParams.set('past_days', String(Math.min(pastDays, 92)));
    url.searchParams.set('forecast_days', '1');
    url.searchParams.set('timezone', KANO_COORDINATES.timezone);
    url.searchParams.set('models', spec.model);

    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { accept: 'application/json' },
      next: { revalidate: 900 },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const body = (await response.json()) as {
      daily?: { time?: unknown; precipitation_sum?: unknown };
    };
    const time = body?.daily?.time;
    const sums = body?.daily?.precipitation_sum;
    if (!Array.isArray(time) || !Array.isArray(sums)) {
      throw new Error('malformed daily series');
    }

    const series: DailyPrecipitation[] = time
      .map((d, i) => ({
        date: String(d),
        precipitationMm: typeof sums[i] === 'number' ? (sums[i] as number) : Number.NaN,
      }))
      .filter((d) => Number.isFinite(d.precipitationMm));

    if (!series.length) throw new Error('empty series after filtering');

    const reduced: WeatherReading = reduceSeries(series, 'forecast');
    return {
      ...base,
      ok: true,
      rollingMm: reduced.rollingPrecipitationMm,
      dryDays: reduced.consecutiveDryDays,
      wouldTrigger: reduced.wouldTrigger,
      error: null,
    };
  } catch (cause) {
    return {
      ...base,
      ok: false,
      rollingMm: null,
      dryDays: null,
      wouldTrigger: null,
      error: (cause as Error).message,
    };
  }
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Read every source, then decide whether they corroborate each other.
 *
 * Sources are fetched concurrently and failures are tolerated: one agency
 * being down must not stop the other two from reaching quorum. A source that
 * errors simply does not vote.
 */
export async function readConsensus(
  options: { pastDays?: number } = {},
): Promise<ConsensusResult> {
  const pastDays = options.pastDays ?? 31;
  const sources = await Promise.all(SOURCES.map((s) => fetchModel(s, pastDays)));

  const responded = sources.filter((s) => s.ok && s.rollingMm !== null);
  const respondedCount = responded.length;

  if (respondedCount < QUORUM) {
    return {
      sources,
      respondedCount,
      agreeingCount: 0,
      quorumMet: false,
      consensusRainfallMm: null,
      consensusDryDays: null,
      wouldTrigger: false,
      blockedReason:
        `Only ${respondedCount} of ${SOURCES.length} weather sources responded; ` +
        `${QUORUM} are required before the circuit breaker may fire.`,
      spreadMm: null,
    };
  }

  const rainfalls = responded.map((s) => s.rollingMm as number);
  const centre = median(rainfalls);
  const agreeing = responded.filter(
    (s) => Math.abs((s.rollingMm as number) - centre) <= AGREEMENT_TOLERANCE_MM,
  );
  const spreadMm = Number((Math.max(...rainfalls) - Math.min(...rainfalls)).toFixed(2));

  if (agreeing.length < QUORUM) {
    return {
      sources,
      respondedCount,
      agreeingCount: agreeing.length,
      quorumMet: false,
      consensusRainfallMm: null,
      consensusDryDays: null,
      wouldTrigger: false,
      blockedReason:
        `Sources disagree by ${spreadMm} mm, beyond the ${AGREEMENT_TOLERANCE_MM} mm ` +
        `tolerance. Settlement is held for review rather than executed on a ` +
        `reading only one model supports.`,
      spreadMm,
    };
  }

  const consensusRainfallMm = Number(
    median(agreeing.map((s) => s.rollingMm as number)).toFixed(2),
  );
  const consensusDryDays = Math.round(median(agreeing.map((s) => s.dryDays as number)));

  const wouldTrigger =
    Math.floor(consensusRainfallMm) < PARAMETRIC_POLICY.thresholdMm &&
    consensusDryDays >= PARAMETRIC_POLICY.dryDayTrigger;

  return {
    sources,
    respondedCount,
    agreeingCount: agreeing.length,
    quorumMet: true,
    consensusRainfallMm,
    consensusDryDays,
    wouldTrigger,
    blockedReason: null,
    spreadMm,
  };
}
