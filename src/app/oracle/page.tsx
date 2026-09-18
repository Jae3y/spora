'use client';

import { useEffect, useState } from 'react';
import { SettlementCinematic, type SettlementPayload } from '@/components/dashboard/SettlementCinematic';
import { WeatherCockpit } from '@/components/dashboard/WeatherCockpit';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { Panel } from '@/components/ui/primitives';
import { COOPERATIVE, ORIGIN, POLICY } from '@/lib/corridor';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The oracle route.
 *
 * ## Why three models and not an average
 *
 * ECMWF IFS, NOAA GFS and DWD ICON are operated by three separate agencies on
 * three continents with different assimilation pipelines. Averaging them would
 * produce a number that is always available and sometimes meaningless -- a
 * 33 mm reading and a 3 mm reading average to a confident-looking 18 mm that
 * no model actually believes.
 *
 * So disagreement *blocks* instead. If the sources spread wider than the
 * tolerance, the oracle refuses to sign. A parametric contract that pays on a
 * number nobody can corroborate is worse than one that occasionally declines
 * to act, because the failure mode is a wrong payout rather than a delayed one.
 */

/**
 * Mirrors `ConsensusResult` from the oracle module and the policy block the
 * route wraps it in. Restated rather than imported because the module is
 * `server-only` -- importing it here would drag Node built-ins into the client
 * bundle.
 */
interface SourceReading {
  id: string;
  label: string;
  agency: string;
  ok: boolean;
  rollingMm: number | null;
  dryDays: number | null;
  wouldTrigger: boolean | null;
  error: string | null;
}

interface ConsensusPayload {
  consensus: {
    sources: SourceReading[];
    respondedCount: number;
    agreeingCount: number;
    quorumMet: boolean;
    consensusRainfallMm: number | null;
    consensusDryDays: number | null;
    wouldTrigger: boolean;
    blockedReason: string | null;
    spreadMm: number | null;
  };
  policy: { quorum: number; totalSources: number; agreementToleranceMm: number };
}

export default function OraclePage() {
  const { state, error, reload, settled } = useCorridorState();
  const [payload, setPayload] = useState<ConsensusPayload | null>(null);
  const [consensusError, setConsensusError] = useState<string | null>(null);
  const [cinematic, setCinematic] = useState<SettlementPayload | null>(null);
  const [replayKey, setReplayKey] = useState(0);

  /**
   * The consensus read is deliberately *not* part of the six-second poll.
   * It fans out to three upstream models, and re-running that every six
   * seconds would burn Open-Meteo's free tier for a figure that changes
   * hourly at best.
   */
  useEffect(() => {
    let cancelled = false;
    fetch('/api/oracle/consensus', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (json?.ok) setPayload(json.data as ConsensusPayload);
        else setConsensusError(json?.error?.message ?? 'Consensus unavailable');
      })
      .catch((cause: unknown) => {
        if (!cancelled) setConsensusError((cause as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={2} />;
  }

  const { escrow, policy, identities } = state;

  return (
    <>
      <PageShell
        eyebrow={`${ORIGIN.latitude}°N ${ORIGIN.longitude}°E · ${ORIGIN.timezone}`}
        title={
          <>
            Three satellites.
            <br />
            <span className="text-[var(--blue-bright)]">One verdict</span>, or none.
          </>
        }
        lede={`The contract pays on rainfall over ${COOPERATIVE.lga}, not on an assessor's opinion. Three independently operated forecast models are read, compared, and signed — and if they disagree beyond tolerance, the oracle refuses to sign at all.`}
      >
        {/* ---- consensus ---- */}
        <Panel
          className="mb-6"
          title="Source agreement"
          subtitle="Disagreement blocks settlement rather than being averaged away."
          action={
            payload ? (
              <span
                className={payload.consensus.quorumMet ? 'badge badge-land' : 'badge badge-breach'}
              >
                {payload.consensus.quorumMet ? 'QUORUM MET' : 'BLOCKED'}
              </span>
            ) : null
          }
        >
          {consensusError && (
            <p className="text-sm text-[var(--amber-bright)]">
              Consensus read failed: {consensusError}
            </p>
          )}

          {!payload && !consensusError && (
            <div className="space-y-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="skeleton h-16 w-full rounded-lg" />
              ))}
            </div>
          )}

          {payload && (
            <>
              <ul className="space-y-2">
                {payload.consensus.sources.map((source) => (
                  <li key={source.id} className="panel-sunken px-4 py-3">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--ink)]">
                        {source.label}
                      </span>
                      {source.ok && source.rollingMm !== null ? (
                        <span className="numeric text-sm text-[var(--blue-bright)]">
                          {source.rollingMm.toFixed(1)} mm
                          <span className="ml-3 text-[var(--ink-dim)]">
                            {source.dryDays ?? '—'} dry days
                          </span>
                        </span>
                      ) : (
                        <span className="badge badge-quiet scale-90">NO RESPONSE</span>
                      )}
                    </div>
                    <p className="mt-1 text-[0.6875rem] leading-tight text-[var(--ink-dim)]">
                      {source.error ?? source.agency}
                    </p>
                  </li>
                ))}
              </ul>

              <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--edge)] pt-4 text-xs">
                <span className="text-[var(--ink-dim)]">
                  Spread{' '}
                  <span
                    className="numeric"
                    style={{
                      color: payload.consensus.quorumMet
                        ? 'var(--green-bright)'
                        : 'var(--drought-bright)',
                    }}
                  >
                    {payload.consensus.spreadMm === null
                      ? '—'
                      : `${payload.consensus.spreadMm.toFixed(1)} mm`}
                  </span>{' '}
                  against a {payload.policy.agreementToleranceMm} mm tolerance
                </span>
                <span className="text-[var(--ink-dim)]">
                  Agreeing{' '}
                  <span className="numeric text-[var(--ink-muted)]">
                    {payload.consensus.agreeingCount} of {payload.policy.totalSources}
                  </span>{' '}
                  · quorum {payload.policy.quorum}
                </span>
                {payload.consensus.consensusRainfallMm !== null && (
                  <span className="text-[var(--ink-dim)]">
                    Median{' '}
                    <span className="numeric text-[var(--ink-muted)]">
                      {payload.consensus.consensusRainfallMm.toFixed(1)} mm
                    </span>
                  </span>
                )}
              </div>

              {payload.consensus.blockedReason && (
                <p className="mt-3 rounded-lg border border-[color-mix(in_srgb,var(--amber)_38%,transparent)] bg-[color-mix(in_srgb,var(--amber)_10%,transparent)] px-3.5 py-2.5 text-xs leading-relaxed text-[var(--amber-bright)]">
                  {payload.consensus.blockedReason} This is the system working, not failing.
                </p>
              )}
            </>
          )}
        </Panel>

        <div className="grid gap-6 xl:grid-cols-[1.25fr_1fr]">
          <WeatherCockpit
            policy={policy}
            liveRainfallMm={escrow.currentRainfallMm}
            liveDryDays={escrow.consecutiveDryDays}
            oraclePublicKey={identities.oraclePublicKey}
            settled={settled}
            onCommitted={(payload) => {
              setCinematic(payload);
              setReplayKey((k) => k + 1);
              reload();
            }}
          />

          <div className="space-y-6">
            <Panel title="How a reading becomes a payout">
              <ol className="space-y-4">
                <Step
                  n={1}
                  title="Read"
                  body={`Daily precipitation for ${ORIGIN.latitude}°N ${ORIGIN.longitude}°E over a rolling ${POLICY.rollingWindowDays}-day window, from the forecast endpoint with past days rather than the archive — the archive lags five days, which is five days of relief a farmer does not get.`}
                />
                <Step
                  n={2}
                  title="Compare"
                  body="Three models, independently operated. If the spread exceeds tolerance the pipeline stops here and nothing is signed."
                />
                <Step
                  n={3}
                  title="Sign"
                  body="An Ed25519 detached signature over the canonical reading. The contract verifies the signature and a monotonic timestamp watermark, so a replayed report from last week cannot re-trigger a settlement."
                />
                <Step
                  n={4}
                  title="Settle"
                  body={`If the reading breaches, the contract splits the escrow ${POLICY.reliefCooperativeBps / 100}/${POLICY.indemnitySupplierBps / 100} between relief and indemnity. No human approves this step.`}
                />
              </ol>
            </Panel>

            <Panel title="Oracle identity">
              <p className="panel-heading">Ed25519 public key</p>
              <p className="numeric mt-2 break-all rounded-lg bg-[var(--panel-sunken)] px-3 py-2.5 text-xs text-[var(--blue-bright)]">
                {identities.oraclePublicKey}
              </p>
              <p className="mt-3 text-xs leading-relaxed text-[var(--ink-dim)]">
                Every report this corridor has ever acted on is verifiable against this key.
                The private half signs; the contract only ever verifies. Reports are counted
                on-chain — this escrow has accepted{' '}
                <span className="numeric text-[var(--ink-muted)]">
                  {escrow.oracleReportCount}
                </span>
                .
              </p>
            </Panel>
          </div>
        </div>
      </PageShell>

      {cinematic && (
        <SettlementCinematic
          key={replayKey}
          payload={cinematic}
          onClose={() => setCinematic(null)}
          onReplay={() => setReplayKey((k) => k + 1)}
        />
      )}
    </>
  );
}

function Step({ n, title, body }: { n: number; title: string; body: string }) {
  return (
    <li className="flex gap-4">
      <span className="numeric flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--blue)_14%,transparent)] text-[0.6875rem] font-semibold text-[var(--blue-bright)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--blue)_38%,transparent)]">
        {n}
      </span>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
        <p className="mt-1 text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
      </div>
    </li>
  );
}
