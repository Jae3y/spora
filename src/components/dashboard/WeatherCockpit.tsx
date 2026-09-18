'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CaretUp } from '@phosphor-icons/react';
import { Button, Panel, Spinner, Stat } from '@/components/ui/primitives';
import type { SettlementPayload } from './SettlementCinematic';

/**
 * Parametric weather cockpit.
 *
 * Two gauges and one slider. The slider is the demo's centrepiece: dragging it
 * past the 21-day dry-run boundary crosses into the red zone and arms the
 * circuit breaker.
 *
 * ## Dry run vs. commit
 *
 * Dragging issues *dry-run* evaluations (`commit: false`) — the server signs a
 * synthetic reading and reports what would happen, touching no state. Only the
 * explicit "Execute parametric settlement" button sends `commit: true`, which
 * submits the signed reading to `report_weather` on chain.
 *
 * Separating these matters. A slider that settled on every drag would fire
 * dozens of irreversible transactions while the operator was still deciding,
 * and the contract's stale-timestamp guard would reject most of them — making
 * the UI look broken while behaving correctly.
 *
 * Dry-run requests are debounced and superseded: a drag produces many
 * evaluations and only the newest is meaningful, so in-flight ones are aborted
 * rather than allowed to resolve out of order and paint a stale verdict.
 */

export interface PolicyShape {
  thresholdMm: number;
  dryDayTrigger: number;
  rollingWindowDays: number;
  reliefCooperativeBps: number;
  indemnitySupplierBps: number;
}

interface Assessment {
  severity: 'nominal' | 'elevated' | 'critical';
  wouldTrigger: boolean;
  reason: string;
}

interface Feasibility {
  feasible: boolean;
  constraint: string | null;
  requestedRainfallMm: number;
  evaluatedRainfallMm: number;
}

interface Scenario {
  id: string;
  label: string;
  description: string;
  rollingPrecipitationMm: number;
  consecutiveDryDays: number;
  severity: string;
}

export function WeatherCockpit({
  policy,
  liveRainfallMm,
  liveDryDays,
  oraclePublicKey,
  settled,
  onCommitted,
}: {
  policy: PolicyShape;
  liveRainfallMm: number;
  liveDryDays: number;
  oraclePublicKey: string;
  settled: boolean;
  /** Raised with the server's own payout record once a settlement executes. */
  onCommitted: (payload: SettlementPayload) => void;
}) {
  const [rainfall, setRainfall] = useState(liveRainfallMm || 65);
  const [dryDays, setDryDays] = useState(liveDryDays || 2);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [feasibility, setFeasibility] = useState<Feasibility | null>(null);
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [evaluating, setEvaluating] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [signature, setSignature] = useState<{ digest: string; signature: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fetch('/api/oracle/simulate')
      .then((r) => r.json())
      .then((j) => {
        if (j?.ok) setScenarios(j.data.scenarios ?? []);
      })
      .catch(() => {
        /* Scenario presets are a convenience; the slider works without them. */
      });
  }, []);

  const evaluate = useCallback(async (mm: number, days: number) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setEvaluating(true);

    try {
      const response = await fetch('/api/oracle/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rollingPrecipitationMm: mm,
          consecutiveDryDays: days,
          commit: false,
        }),
        signal: controller.signal,
      });
      const json = await response.json();
      if (json?.ok) {
        setAssessment(json.data.assessment);
        setFeasibility(json.data.feasibility ?? null);
        setSignature({
          digest: json.data.reading.digest,
          signature: json.data.reading.signature,
        });
        setError(null);
      }
    } catch (cause) {
      // An aborted request is the expected outcome of a superseded drag, not a
      // failure worth showing the operator.
      if ((cause as Error).name !== 'AbortError') {
        setError((cause as Error).message);
      }
    } finally {
      if (!controller.signal.aborted) setEvaluating(false);
    }
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => evaluate(rainfall, dryDays), 180);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rainfall, dryDays, evaluate]);

  async function commit() {
    setCommitting(true);
    setError(null);
    try {
      const response = await fetch('/api/oracle/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          rollingPrecipitationMm: rainfall,
          consecutiveDryDays: dryDays,
          commit: true,
          // Step past the contract's stale-report watermark so repeated demo
          // runs in the same second are not rejected as replays.
          observedAt: Math.floor(Date.now() / 1000),
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'Settlement failed');
      }

      // The cinematic is driven by the server's own payout record, never by a
      // client-side recomputation. Recomputing here would let the figures on
      // the handsets drift from the figures that actually settled, which is
      // the one inconsistency this demo cannot afford.
      const d = json.data;
      if (d?.payout) {
        onCommitted({
          cooperativeUsdc: d.payout.cooperative.usdc,
          cooperativeNgn: d.payout.cooperative.ngn,
          supplierUsdc: d.payout.supplier.usdc,
          supplierBob: d.payout.supplier.bob,
          txHash: d.chain?.hash ?? null,
          explorerUrl: d.chain?.explorerUrl ?? null,
          rainfallMm: d.reading?.rollingPrecipitationMmWhole ?? Math.floor(rainfall),
          dryDays: d.reading?.consecutiveDryDays ?? dryDays,
        });
      }
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setCommitting(false);
    }
  }

  const severity = assessment?.severity ?? 'nominal';

  // Where the red zone begins on the dry-day track, as a percentage.
  const dryZoneStart = useMemo(
    () => (policy.dryDayTrigger / 40) * 100,
    [policy.dryDayTrigger],
  );

  return (
    <Panel
      title="Parametric weather cockpit"
      subtitle={`Kano savanna belt · ${policy.rollingWindowDays}-day rolling window · breach at <${policy.thresholdMm} mm AND ≥${policy.dryDayTrigger} dry days`}
      action={
        <span
          className={
            severity === 'critical'
              ? 'badge badge-breach'
              : severity === 'elevated'
                ? 'badge badge-motion'
                : 'badge badge-land'
          }
        >
          {/* A nominal season is not an event. The pulse is reserved for a
              parametric condition that is actually arming. */}
          <span
            className={severity === 'nominal' ? 'status-dot' : 'pulse-dot'}
            aria-hidden
          />
          {severity.toUpperCase()}
        </span>
      }
    >
      {/* Gauges */}
      <div className="grid gap-4 sm:grid-cols-2">
        <Gauge
          label={`${policy.rollingWindowDays}-day rainfall`}
          value={rainfall}
          max={120}
          unit="mm"
          threshold={policy.thresholdMm}
          thresholdLabel={`${policy.thresholdMm} mm floor`}
          inverted
          tone={Math.floor(rainfall) < policy.thresholdMm ? 'crimson' : 'emerald'}
        />
        <Gauge
          label="Consecutive dry days"
          value={dryDays}
          max={40}
          unit="days"
          threshold={policy.dryDayTrigger}
          thresholdLabel={`${policy.dryDayTrigger}-day trigger`}
          tone={dryDays >= policy.dryDayTrigger ? 'crimson' : 'emerald'}
        />
      </div>

      {/* Chaos slider */}
      <div className="panel-sunken mt-5 p-4">
        <div className="flex items-center justify-between">
          <h3 className="panel-heading">Simulate climate volatility</h3>
          {evaluating && (
            <span className="flex items-center gap-1.5 text-xs text-[var(--ink-dim)]">
              <Spinner /> evaluating
            </span>
          )}
        </div>

        <div className="mt-4 space-y-5">
          <SliderRow
            label="Cumulative rainfall"
            value={rainfall}
            min={0}
            max={120}
            step={0.5}
            unit="mm"
            onChange={setRainfall}
            // Below the floor is dangerous, so the danger band is on the LEFT.
            gradient={`linear-gradient(to right, var(--drought) 0%, var(--drought) ${(policy.thresholdMm / 120) * 100}%, var(--green-deep) ${(policy.thresholdMm / 120) * 100}%, var(--green) 100%)`}
          />
          <SliderRow
            label="Consecutive dry days"
            value={dryDays}
            min={0}
            max={40}
            step={1}
            unit="days"
            onChange={setDryDays}
            markerPct={dryZoneStart}
            markerLabel="Red drought zone"
            gradient={`linear-gradient(to right, var(--green) 0%, var(--green-deep) ${dryZoneStart}%, var(--drought) ${dryZoneStart}%, var(--drought) 100%)`}
          />
        </div>

        {/* The two axes are physically coupled: a dry day is by definition
            below 1.0 mm, so a dry run covering the whole window caps the
            cumulative total. Say so rather than silently evaluating a reading
            the operator did not request. */}
        {feasibility && !feasibility.feasible && (
          <p className="fade-rise mt-4 rounded-lg bg-[color-mix(in_srgb,var(--amber)_12%,transparent)] px-3 py-2.5 text-sm leading-relaxed text-[var(--amber-bright)] ring-1 ring-[color-mix(in_srgb,var(--amber)_40%,transparent)]">
            <span className="font-semibold">Physically impossible combination, clamped.</span>{' '}
            {feasibility.constraint}
          </p>
        )}

        {assessment && (
          <p
            className={`mt-4 rounded-lg px-3 py-2.5 text-sm leading-relaxed ${
              assessment.wouldTrigger
                ? 'bg-[color-mix(in_srgb,var(--drought)_14%,transparent)] text-[var(--drought-bright)] ring-1 ring-[color-mix(in_srgb,var(--drought)_40%,transparent)]'
                : 'bg-[var(--panel-raised)] text-[var(--ink-muted)]'
            }`}
          >
            {assessment.reason}
          </p>
        )}

        {/* Scenario presets */}
        {scenarios.length > 0 && (
          <div className="mt-4">
            <div className="panel-heading mb-2">Preset scenarios</div>
            <div className="flex flex-wrap gap-2">
              {scenarios.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  title={s.description}
                  onClick={() => {
                    setRainfall(s.rollingPrecipitationMm);
                    setDryDays(s.consecutiveDryDays);
                  }}
                  className="rounded-lg border border-[var(--edge-bright)] bg-[var(--panel-raised)] px-2.5 py-1.5 text-xs transition-colors hover:border-[var(--amber)] hover:text-[var(--amber-bright)]"
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Settlement projection + commit */}
      {assessment?.wouldTrigger && !settled && (
        <div className="fade-rise mt-4 rounded-xl border border-[color-mix(in_srgb,var(--drought)_40%,transparent)] bg-[color-mix(in_srgb,var(--drought)_8%,transparent)] p-4">
          <h3 className="text-sm font-semibold text-[var(--drought-bright)]">
            Emergency fund partition
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-4">
            <Stat
              label="Kano farmer relief"
              value={`${policy.reliefCooperativeBps / 100}%`}
              tone="crimson"
              size="sm"
              hint="Immediate cash to the cooperative"
            />
            <Stat
              label="Caranavi indemnity"
              value={`${policy.indemnitySupplierBps / 100}%`}
              tone="amber"
              size="sm"
              hint="Partial cover for inputs already shipped"
            />
          </div>
          <Button variant="danger" className="mt-4 w-full" onClick={commit} disabled={committing}>
            {committing ? (
              <>
                <Spinner /> Submitting signed reading…
              </>
            ) : (
              'Execute parametric settlement'
            )}
          </Button>
        </div>
      )}

      {error && (
        <p className="mt-3 text-sm text-[var(--drought-bright)]">{error}</p>
      )}

      {/* Oracle provenance */}
      <div className="mt-4 space-y-1 border-t border-[var(--edge)] pt-3 text-xs">
        <div className="flex items-center justify-between gap-3">
          <span className="text-[var(--ink-dim)]">Oracle key</span>
          <span className="numeric truncate text-[var(--ink-muted)]" title={oraclePublicKey}>
            {oraclePublicKey.slice(0, 8)}…{oraclePublicKey.slice(-8)}
          </span>
        </div>
        {signature && (
          <div className="flex items-center justify-between gap-3">
            <span className="text-[var(--ink-dim)]">Reading digest</span>
            <span className="numeric truncate text-[var(--ink-muted)]" title={signature.digest}>
              {signature.digest.slice(0, 16)}…
            </span>
          </div>
        )}
      </div>
    </Panel>
  );
}

function Gauge({
  label,
  value,
  max,
  unit,
  threshold,
  thresholdLabel,
  tone,
  inverted = false,
}: {
  label: string;
  value: number;
  max: number;
  unit: string;
  threshold: number;
  thresholdLabel: string;
  tone: 'emerald' | 'crimson';
  inverted?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const thresholdPct = (threshold / max) * 100;
  const color = tone === 'crimson' ? 'var(--drought)' : 'var(--green)';

  // Semi-circular arc: radius 60, centred at (70, 70), sweeping 180°.
  const circumference = Math.PI * 60;
  const dash = (pct / 100) * circumference;

  return (
    <div className="panel-sunken p-4">
      <div className="panel-heading">{label}</div>
      <div className="mt-2 flex items-center gap-4">
        <svg viewBox="0 0 140 80" className="h-20 w-36 shrink-0" aria-hidden>
          <path
            d="M 10 70 A 60 60 0 0 1 130 70"
            fill="none"
            stroke="var(--panel-raised)"
            strokeWidth="10"
            strokeLinecap="round"
          />
          <path
            d="M 10 70 A 60 60 0 0 1 130 70"
            fill="none"
            stroke={color}
            strokeWidth="10"
            strokeLinecap="round"
            strokeDasharray={`${dash} ${circumference}`}
            className="transition-[stroke-dasharray] duration-300 ease-out"
          />
          {/* Threshold tick */}
          <g
            transform={`rotate(${(thresholdPct / 100) * 180 - 90} 70 70)`}
            opacity="0.9"
          >
            <line
              x1="70"
              y1="4"
              x2="70"
              y2="16"
              stroke="var(--amber-bright)"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </g>
        </svg>
        <div className="min-w-0">
          <div className="flex items-baseline gap-1">
            <span
              className="numeric text-3xl font-semibold"
              style={{ color }}
            >
              {Number.isInteger(value) ? value : value.toFixed(1)}
            </span>
            <span className="text-xs text-[var(--ink-dim)]">{unit}</span>
          </div>
          <div className="mt-1 text-[0.6875rem] leading-tight text-[var(--ink-dim)]">
            <span
              className="mr-1 inline-block h-2.5 w-px align-middle bg-[var(--amber-bright)]"
              aria-hidden
            />
            {thresholdLabel}
            <br />
            {inverted
              ? value < threshold
                ? 'Below floor, condition met'
                : 'Above floor, safe'
              : value >= threshold
                ? 'At or past trigger, condition met'
                : 'Below trigger, safe'}
          </div>
        </div>
      </div>
    </div>
  );
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
  gradient,
  markerPct,
  markerLabel,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit: string;
  onChange: (v: number) => void;
  gradient: string;
  markerPct?: number;
  markerLabel?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between">
        <label className="text-xs text-[var(--ink-muted)]">{label}</label>
        <span className="numeric text-sm text-[var(--ink)]">
          {Number.isInteger(value) ? value : value.toFixed(1)}{' '}
          <span className="text-xs text-[var(--ink-dim)]">{unit}</span>
        </span>
      </div>
      <div className="relative">
        <input
          type="range"
          className="chaos-slider"
          min={min}
          max={max}
          step={step}
          value={value}
          aria-label={label}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ background: gradient }}
        />
        {markerPct !== undefined && (
          <div
            className="pointer-events-none absolute -bottom-4 -translate-x-1/2 whitespace-nowrap text-[0.625rem] text-[var(--drought-bright)]"
            style={{ left: `${markerPct}%` }}
          >
            <CaretUp size={9} weight="fill" className="mr-0.5 inline-block align-middle" aria-hidden />
            {markerLabel}
          </div>
        )}
      </div>
      {markerPct !== undefined && <div className="h-4" />}
    </div>
  );
}
