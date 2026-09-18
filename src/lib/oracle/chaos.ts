import 'server-only';

/**
 * The Chaos Engine.
 *
 * Parametric insurance has an inconvenient property for a live demo: the event
 * it pays out on is, by design, rare. A judge cannot wait 21 days for a Nigerian
 * drought. This module injects deterministic weather anomalies so the circuit
 * breaker can be exercised on demand.
 *
 * ## Why injected readings are still signed
 *
 * A simulated reading travels the *same* path as a real one -- canonicalised,
 * Ed25519-signed, submitted to `report_weather` through the sponsored gas
 * wallet. Nothing downstream is bypassed or stubbed. The only thing that
 * changes is the provenance of the numbers, and that provenance is recorded
 * explicitly in `source: 'synthetic'` and in the `simulated` flag on every
 * emitted audit event.
 *
 * That honesty is the point. A demo that fakes the *settlement* proves
 * nothing; a demo that fakes only the *weather* proves the entire settlement
 * pipeline works.
 */

import { PARAMETRIC_POLICY } from '@/lib/config';
import {
  reduceSeries,
  signReading,
  type DailyPrecipitation,
  type SignedWeatherReading,
  type WeatherReading,
} from './weather';

export type ScenarioId = 'normal' | 'dry_spell' | 'severe_drought' | 'recovery';

export interface Scenario {
  id: ScenarioId;
  label: string;
  description: string;
  /** Target cumulative precipitation over the 21-day window, in mm. */
  rollingPrecipitationMm: number;
  /** Target consecutive dry-day run. */
  consecutiveDryDays: number;
  severity: 'nominal' | 'elevated' | 'critical';
}

export const SCENARIOS: Record<ScenarioId, Scenario> = {
  normal: {
    id: 'normal',
    label: 'Normal season',
    description:
      'Long-rains pattern holding. Escrow proceeds to delivery on the standard milestone path.',
    rollingPrecipitationMm: 65,
    consecutiveDryDays: 2,
    severity: 'nominal',
  },
  dry_spell: {
    id: 'dry_spell',
    label: 'Dry spell',
    description:
      'Rainfall below the parametric floor, but the dry run has not reached 21 days. ' +
      'Breach is armed on one axis only, so no payout fires.',
    rollingPrecipitationMm: 14.2,
    consecutiveDryDays: 16,
    severity: 'elevated',
  },
  severe_drought: {
    id: 'severe_drought',
    label: 'Severe drought',
    description:
      'Both conditions satisfied. The circuit breaker fires: 60% emergency relief to Kano, ' +
      '40% input indemnity to Caranavi.',
    rollingPrecipitationMm: 8.4,
    consecutiveDryDays: 24,
    severity: 'critical',
  },
  recovery: {
    id: 'recovery',
    label: 'Post-drought recovery',
    description:
      'Rain returns and resets the dry-day counter. Demonstrates that the breaker re-arms ' +
      'rather than latching.',
    rollingPrecipitationMm: 41.8,
    consecutiveDryDays: 0,
    severity: 'nominal',
  },
};

/**
 * The maximum 21-day cumulative rainfall that can coexist with a dry-day run
 * of `dryDays`.
 *
 * The two parametric axes are **not independent**. A "dry day" is defined as
 * strictly below `dryDayRainfallCeilingMm` (1.0 mm), so once the dry run covers
 * the whole rolling window, every day in that window is capped at 1.0 mm and
 * the cumulative total cannot exceed `window x ceiling` = 21 mm.
 *
 * Requesting, say, 41.8 mm alongside 25 dry days therefore describes weather
 * that cannot physically occur. Surfacing that as an explicit bound -- rather
 * than silently satisfying one axis and dropping the other -- is what keeps the
 * Chaos Engine honest.
 */
export function maxFeasibleRainfallMm(dryDays: number): number {
  const window = PARAMETRIC_POLICY.rollingWindowDays;
  const ceiling = PARAMETRIC_POLICY.dryDayRainfallCeilingMm;
  const dryInWindow = Math.min(Math.max(0, Math.round(dryDays)), window);

  // Any day outside the dry run is unconstrained, so the bound only bites once
  // the run covers the entire window.
  if (dryInWindow < window) return Number.POSITIVE_INFINITY;

  // Strictly below the ceiling on every day; step just under it so the
  // synthesised days still classify as dry.
  return Number((window * (ceiling - 0.01)).toFixed(2));
}

export interface SynthesisResult {
  series: DailyPrecipitation[];
  requestedRainfallMm: number;
  achievedRainfallMm: number;
  /** False when the requested pair was physically impossible and got clamped. */
  feasible: boolean;
  /** Human-readable explanation, non-null exactly when `feasible` is false. */
  constraint: string | null;
}

/**
 * Synthesise a 21-day daily series realising the requested aggregates, clamping
 * to what is physically representable and reporting any clamp.
 *
 * Working backwards from the aggregates -- rather than emitting them directly
 * -- means the injected reading passes through {@link reduceSeries}, the same
 * reduction the live path uses. If that reduction ever regresses, the chaos
 * scenarios break with it, which is precisely the coupling we want.
 *
 * Construction:
 * - the most recent `dryDays` entries each get a sub-ceiling value;
 * - when some days are wet, one "wet wall" day is inserted before the run so
 *   the backwards scan terminates at exactly `dryDays` and cannot over-count;
 * - the remaining budget is spread over the earlier days.
 */
export function synthesiseSeries(
  rollingMm: number,
  dryDays: number,
  anchor: Date = new Date(),
): SynthesisResult {
  const window = PARAMETRIC_POLICY.rollingWindowDays;
  const ceiling = PARAMETRIC_POLICY.dryDayRainfallCeilingMm;
  const clampedDry = Math.max(0, Math.min(Math.round(dryDays), window));

  const maxFeasible = maxFeasibleRainfallMm(dryDays);
  const feasible = rollingMm <= maxFeasible;
  const targetMm = feasible ? rollingMm : maxFeasible;

  const values: number[] = [];
  // Index of a day that can absorb the rounding residual. In the mixed case
  // this is the unbounded "wall" day; in the all-dry case every day is
  // ceiling-bound, so the residual is spread instead.
  let absorberIndex = -1;

  if (clampedDry >= window) {
    // Every day in the window is dry. Spread the (clamped) budget evenly, each
    // day staying strictly below the ceiling so it still counts as dry.
    const per = Math.min(targetMm / window, ceiling - 0.01);
    for (let i = 0; i < window; i += 1) values.push(round2(per));
  } else {
    // Fixed sub-ceiling filler keeps the series reproducible run to run.
    const dryValue = 0.2;
    const dryTotal = clampedDry * dryValue;
    const wetDayCount = window - clampedDry;
    const wetBudget = Math.max(0, targetMm - dryTotal);

    // The day immediately preceding the run must be at or above the ceiling,
    // or the backwards scan would continue past it and over-report the streak.
    const wall = Math.max(ceiling, wetBudget / wetDayCount);
    const earlierCount = wetDayCount - 1;
    const perEarlier = earlierCount > 0 ? Math.max(0, wetBudget - wall) / earlierCount : 0;

    for (let i = 0; i < earlierCount; i += 1) values.push(round2(perEarlier));
    absorberIndex = values.push(round2(wall)) - 1;
    for (let i = 0; i < clampedDry; i += 1) values.push(dryValue);
  }

  // Rounding each day to 2 dp independently loses up to 0.005 mm per day, or
  // ~0.1 mm across a 21-day window. That is enough to turn a request for
  // exactly 20.0 mm into 19.95 mm, which floors to 19 and fires a breach the
  // operator explicitly did not ask for -- the boundary is `< 20`, not `<= 20`.
  // Pushing the residual into a single absorbing day makes the series sum to
  // the target exactly.
  const residual = round2(targetMm - values.reduce((s, v) => s + v, 0));
  if (residual !== 0) {
    if (absorberIndex >= 0) {
      values[absorberIndex] = round2(values[absorberIndex] + residual);
    } else {
      // All-dry window: no day may reach the ceiling, so distribute the
      // residual one hundredth at a time across days with headroom.
      const step = residual > 0 ? 0.01 : -0.01;
      let remaining = Math.round(Math.abs(residual) * 100);
      for (let i = 0; remaining > 0 && i < values.length * 2; i += 1) {
        const idx = i % values.length;
        const next = round2(values[idx] + step);
        if (next >= 0 && next < ceiling) {
          values[idx] = next;
          remaining -= 1;
        }
      }
    }
  }

  const series = values.map((precipitationMm, index) => {
    const date = new Date(anchor);
    date.setUTCDate(date.getUTCDate() - (values.length - 1 - index));
    return { date: date.toISOString().slice(0, 10), precipitationMm };
  });

  const achievedRainfallMm = Number(
    values.reduce((sum, v) => sum + v, 0).toFixed(2),
  );

  return {
    series,
    requestedRainfallMm: rollingMm,
    achievedRainfallMm,
    feasible,
    constraint: feasible
      ? null
      : `A ${clampedDry}-day dry run covers the entire ${window}-day window, so every day is ` +
        `capped at ${ceiling} mm and cumulative rainfall cannot exceed ${maxFeasible} mm. ` +
        `Requested ${rollingMm} mm was clamped to ${achievedRainfallMm} mm.`,
  };
}

/**
 * Build a signed, synthetic reading for a named scenario.
 *
 * `observedAtOverride` exists because the contract rejects any report whose
 * timestamp is not strictly newer than the last accepted one. Firing two
 * scenarios in the same second during a demo would otherwise be rejected as a
 * replay -- correct behaviour, but a confusing thing to watch happen.
 */
export function buildScenarioReading(
  scenarioId: ScenarioId,
  options: { observedAtOverride?: number } = {},
): SyntheticReading & { scenario: Scenario; simulated: true } {
  const scenario = SCENARIOS[scenarioId];
  if (!scenario) {
    throw new Error(`Unknown chaos scenario: ${scenarioId}`);
  }
  return {
    ...buildSyntheticReading(
      scenario.rollingPrecipitationMm,
      scenario.consecutiveDryDays,
      options.observedAtOverride,
    ),
    scenario,
    simulated: true,
  };
}

/**
 * Build a signed synthetic reading from raw slider values.
 *
 * This is what the dashboard's "Simulate Climate Volatility" control calls as
 * the operator drags: arbitrary `(rainfall, dryDays)` pairs, not just the four
 * canned scenarios.
 */
/**
 * A signed synthetic reading, carrying the feasibility verdict alongside the
 * telemetry so no consumer can act on a clamped value without seeing that it
 * was clamped.
 */
export type SyntheticReading = SignedWeatherReading & {
  feasible: boolean;
  constraint: string | null;
  requestedRainfallMm: number;
};

export function buildSyntheticReading(
  rollingMm: number,
  dryDays: number,
  observedAtOverride?: number,
): SyntheticReading {
  const synth = synthesiseSeries(rollingMm, dryDays);
  const reduced = reduceSeries(synth.series, 'synthetic');

  // The reduction recomputes both aggregates from the synthesised series. Pin
  // the dry-day count to the requested value: floating-point accumulation in
  // the series builder can land a filler day a hair either side of the 1.0 mm
  // ceiling, and the operator's slider position is the authoritative intent.
  //
  // Rainfall is NOT pinned the same way. It is taken from the reduction, which
  // reflects what the series can actually represent, so a physically
  // impossible request settles on the achievable value rather than on a number
  // no weather could produce.
  const reading: WeatherReading = {
    ...reduced,
    consecutiveDryDays: Math.max(0, Math.round(dryDays)),
    observedAt: observedAtOverride ?? Math.floor(Date.now() / 1000),
    wouldTrigger:
      reduced.rollingPrecipitationMmWhole < PARAMETRIC_POLICY.thresholdMm &&
      Math.round(dryDays) >= PARAMETRIC_POLICY.dryDayTrigger,
  };

  return {
    ...signReading(reading),
    feasible: synth.feasible,
    constraint: synth.constraint,
    requestedRainfallMm: synth.requestedRainfallMm,
  };
}

/**
 * Classify a slider position for the cockpit gauges.
 *
 * `critical` is returned only when *both* parametric conditions are met, which
 * keeps the UI's red zone exactly congruent with the contract's
 * `would_trigger` predicate. A UI that reddened on rainfall alone would tell
 * an operator a payout was imminent when it was not.
 */
export function classify(
  rollingMm: number,
  dryDays: number,
): { severity: Scenario['severity']; wouldTrigger: boolean; reason: string } {
  const belowThreshold = Math.floor(rollingMm) < PARAMETRIC_POLICY.thresholdMm;
  const dryRunMet = dryDays >= PARAMETRIC_POLICY.dryDayTrigger;

  if (belowThreshold && dryRunMet) {
    return {
      severity: 'critical',
      wouldTrigger: true,
      reason:
        `${Math.floor(rollingMm)} mm < ${PARAMETRIC_POLICY.thresholdMm} mm and ` +
        `${dryDays} >= ${PARAMETRIC_POLICY.dryDayTrigger} dry days -- breach conditions met.`,
    };
  }
  if (belowThreshold) {
    return {
      severity: 'elevated',
      wouldTrigger: false,
      reason:
        `Rainfall is below the floor, but the dry run is ${dryDays} of ` +
        `${PARAMETRIC_POLICY.dryDayTrigger} required days.`,
    };
  }
  if (dryRunMet) {
    return {
      severity: 'elevated',
      wouldTrigger: false,
      reason:
        `Dry run has reached ${dryDays} days, but cumulative rainfall of ` +
        `${Math.floor(rollingMm)} mm is at or above the ${PARAMETRIC_POLICY.thresholdMm} mm floor.`,
    };
  }
  return {
    severity: 'nominal',
    wouldTrigger: false,
    reason: 'Neither parametric condition is met. Escrow proceeds on the delivery path.',
  };
}

export function listScenarios(): Scenario[] {
  return Object.values(SCENARIOS);
}

/**
 * Round to 2 dp through integer hundredths.
 *
 * `Number(x.toFixed(2))` round-trips through a string on every call and still
 * inherits the binary-representation surprises of the input; scaling to
 * hundredths and back keeps the arithmetic in the integer domain where the
 * residual correction above needs it to be exact.
 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
