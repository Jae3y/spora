'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { AuditDrawer, type AuditEvent } from '@/components/dashboard/AuditDrawer';
import { CockpitSkeleton } from '@/components/dashboard/CockpitSkeleton';
import { CorridorMap, type CorridorStage } from '@/components/dashboard/CorridorMap';
import { FloatVault } from '@/components/dashboard/FloatVault';
import { PoolingMatrix, type Member } from '@/components/dashboard/PoolingMatrix';
import {
  SettlementCinematic,
  type SettlementPayload,
} from '@/components/dashboard/SettlementCinematic';
import { SupplierPortal } from '@/components/dashboard/SupplierPortal';
import { WeatherCockpit, type PolicyShape } from '@/components/dashboard/WeatherCockpit';
import { StoryLayer } from '@/components/hero/StoryLayer';
import { Button, Panel, Spinner, Stat, StatusBadge } from '@/components/ui/primitives';
import { useReveal } from '@/components/ui/useReveal';

/**
 * Spora.
 *
 * ## One page, two audiences
 *
 * A farmer, a judge and a Stellar engineer land on the same URL. The page is
 * ordered so each of them stops where their understanding does:
 *
 * ```
 *   hero        "when the rain fails, the money moves"   <- anyone
 *   four steps   plain language, technical line demoted  <- anyone
 *   ── cockpit ──────────────────────────────────────────
 *   treasury     live figures, exact to the stroop       <- operator
 *   oracle       consensus, signatures, chaos slider     <- engineer
 *   audit        every ledger event, explorer links      <- auditor
 * ```
 *
 * Nobody has to choose a mode or find a toggle. Depth arrives by scrolling,
 * which is the one interaction every visitor already knows.
 *
 * ## One snapshot, one poll
 *
 * The whole cockpit renders from a single `/api/escrow/state` response, so
 * every panel describes the same instant. Polling four endpoints would let a
 * settled escrow render beside a pre-settlement balance for one frame, which
 * in a financial interface reads as a real discrepancy rather than a render
 * artefact. Polling pauses when the tab is hidden.
 */

interface EscrowShape {
  status: string;
  totalDepositedStroops: string;
  inputAllocationStroops: string;
  bufferAllocationStroops: string;
  totalDisbursedStroops: string;
  cooperativePaidStroops?: string;
  supplierPaidStroops?: string;
  currentRainfallMm: number;
  consecutiveDryDays: number;
  thresholdMm: number;
  oracleReportCount: number;
}

interface DashboardState {
  escrow: EscrowShape;
  chainError: string | null;
  corridor: { stages: CorridorStage[] };
  pooling: {
    members: Member[];
    pledgedUsdc: string;
    settledUsdc: string;
    progressBps: number;
  };
  policy: PolicyShape;
  revenue: {
    underwritingFeeUsdc: string;
    yieldShareUsdc: string;
    totalUsdc: string;
    cooperativeYieldNetUsdc: string;
    policy: { underwritingFeeBps: number; yieldPerformanceBps: number };
  };
  identities: {
    oraclePublicKey: string;
    gasWallet: { mode: 'live' | 'mock'; address: string | null };
    contractId: string | null;
    contractExplorerUrl: string | null;
    network: string;
  };
  rails: Array<{ rail: string; mode: 'live' | 'mock'; detail: string }>;
  events: AuditEvent[];
}

const POLL_INTERVAL_MS = 6_000;

export default function Spora() {
  useReveal();

  const [state, setState] = useState<DashboardState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [cinematic, setCinematic] = useState<SettlementPayload | null>(null);
  const [replayKey, setReplayKey] = useState(0);

  /** Guards against a poll resolving after unmount. */
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/escrow/state', { cache: 'no-store' });
      const json = await response.json();
      if (!mounted.current) return;
      if (!json?.ok) throw new Error(json?.error?.message ?? 'Failed to load state');
      setState(json.data as DashboardState);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // `load` awaits a network round trip before it calls setState, so nothing
    // updates synchronously in this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    let timer: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (timer === null) timer = setInterval(load, POLL_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        load();
        start();
      }
    };

    start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      mounted.current = false;
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [load]);

  async function dispatchAction(action: string) {
    setBusy(action);
    try {
      const response = await fetch('/api/escrow/state', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await response.json();
      if (!json?.ok) throw new Error(json?.error?.message ?? `${action} failed`);
      await load();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  /**
   * Raised by the cockpit when a settlement actually executes. The cinematic
   * is driven by the server's own payout record rather than recomputed here,
   * so the figures on the handsets are the figures that settled.
   */
  const onSettled = useCallback(
    (payload: SettlementPayload) => {
      setCinematic(payload);
      setReplayKey((k) => k + 1);
      load();
    },
    [load],
  );

  if (!state) {
    if (error) {
      return (
        <main className="flex min-h-[100dvh] items-center justify-center px-6">
          <div className="panel max-w-md">
            <div className="panel-core p-6 text-center">
              <p className="text-sm font-semibold text-[var(--drought-bright)]">
                Could not reach the corridor API
              </p>
              <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">
                {error}
              </p>
              <Button className="mt-4" onClick={load}>
                Retry
              </Button>
            </div>
          </div>
        </main>
      );
    }
    return <CockpitSkeleton />;
  }

  const { escrow, policy, identities, pooling, rails, events, corridor, revenue } = state;
  const breached = escrow.status === 'ParametricTriggered';
  const settled = breached || escrow.status === 'Completed';

  const activeStage =
    escrow.status === 'Initialized'
      ? 'ngn'
      : escrow.status === 'Funded'
        ? 'usdc'
        : escrow.status === 'InTransit'
          ? 'float'
          : 'bob';

  const explorerBase = `https://stellar.expert/explorer/${
    identities.network === 'mainnet' ? 'public' : 'testnet'
  }/tx/`;

  return (
    <>
      {/* ═══════════════════════════ the story ═══════════════════════════ */}
      <StoryLayer breached={breached} />

      {/* ═══════════════════════════ the cockpit ═════════════════════════ */}
      <main
        id="cockpit"
        className="mx-auto max-w-[1600px] scroll-mt-4 px-4 pb-28 pt-10 sm:px-6"
      >
        {/* Threshold between the two worlds. Everything above is plain
            language; everything below assumes you want the numbers. */}
        <div className="mb-10 flex items-center gap-4">
          <span className="panel-heading whitespace-nowrap">Live cockpit</span>
          <span
            className="h-px flex-1"
            style={{
              background:
                'linear-gradient(90deg, var(--green) 0%, var(--blue) 50%, transparent 100%)',
            }}
            aria-hidden
          />
          <StatusBadge status={escrow.status} />
        </div>

        <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold tracking-tight">
              Spora<span className="text-[var(--green)]">.</span>
            </h2>
            <p className="mt-1 max-w-2xl text-sm text-[var(--ink-muted)]">
              Every figure below is read from the escrow, exact to the stroop.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {escrow.status === 'Funded' && (
              <Button onClick={() => dispatchAction('set_in_transit')} disabled={busy !== null}>
                {busy === 'set_in_transit' ? <Spinner /> : null} Dispatch shipment
              </Button>
            )}
            {escrow.status === 'InTransit' && (
              <Button
                variant="primary"
                onClick={() => dispatchAction('complete')}
                disabled={busy !== null}
              >
                {busy === 'complete' ? <Spinner /> : null} Confirm delivery
              </Button>
            )}
            <Button variant="ghost" onClick={() => dispatchAction('reset')} disabled={busy !== null}>
              Reset demo
            </Button>
          </div>
        </header>

        {/* ---- rail status ---- */}
        <div className="mb-6 grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
          {rails.map((r) => (
            <div key={r.rail} className="panel-sunken px-3 py-2.5">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-[var(--ink)]">
                  {r.rail}
                </span>
                <span
                  className={
                    r.mode === 'live' ? 'badge badge-land scale-90' : 'badge badge-quiet scale-90'
                  }
                >
                  {r.mode}
                </span>
              </div>
              <p className="mt-1 line-clamp-2 text-[0.6875rem] leading-tight text-[var(--ink-dim)]">
                {r.detail}
              </p>
            </div>
          ))}
        </div>

        {state.chainError && (
          <div className="mb-6 rounded-lg border border-[color-mix(in_srgb,var(--amber)_40%,transparent)] bg-[color-mix(in_srgb,var(--amber)_10%,transparent)] px-4 py-2.5 text-sm text-[var(--amber-bright)]">
            Contract read failed. Showing the local mirror. {state.chainError}
          </div>
        )}

        {/* ---- treasury ---- */}
        <Panel className="mb-6" title="Escrow treasury" reveal={false}>
          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-5">
            <Stat
              label="Total deposited"
              stroops={escrow.totalDepositedStroops}
              unit="USDC"
              size="lg"
            />
            <Stat
              label="Input allocation (90%)"
              stroops={escrow.inputAllocationStroops}
              unit="USDC"
              tone="muted"
            />
            <Stat
              label="Climate buffer (10%)"
              stroops={escrow.bufferAllocationStroops}
              unit="USDC"
              tone="amber"
            />
            <Stat
              label="Kano relief paid"
              stroops={escrow.cooperativePaidStroops ?? '0'}
              unit="USDC"
              tone={breached ? 'crimson' : 'muted'}
            />
            <Stat
              label="Caranavi paid"
              stroops={escrow.supplierPaidStroops ?? '0'}
              unit="USDC"
              tone={settled ? 'emerald' : 'muted'}
            />
          </div>

          {/* Revenue. Small, factual, and next to the capital it is charged
              on, rather than hidden in a deck. */}
          <div className="mt-5 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-[var(--edge)] pt-4 text-xs">
            <span className="panel-heading">Protocol revenue</span>
            <span className="text-[var(--ink-dim)]">
              Underwriting{' '}
              <span className="numeric text-[var(--ink-muted)]">
                {revenue.underwritingFeeUsdc}
              </span>{' '}
              ({revenue.policy.underwritingFeeBps / 100}% of inputs)
            </span>
            <span className="text-[var(--ink-dim)]">
              Yield share{' '}
              <span className="numeric text-[var(--ink-muted)]">{revenue.yieldShareUsdc}</span>{' '}
              ({revenue.policy.yieldPerformanceBps / 100}% of accrual)
            </span>
            <span className="text-[var(--ink-dim)]">
              Total{' '}
              <span className="numeric text-[var(--green-bright)]">{revenue.totalUsdc}</span> USDC
            </span>
          </div>

          {identities.contractExplorerUrl && (
            <a
              href={identities.contractExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="numeric mt-4 inline-flex items-center gap-1 text-xs text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
            >
              {identities.contractId}
              <ArrowUpRight size={11} weight="bold" aria-hidden />
            </a>
          )}
        </Panel>

        {/* ---- corridor ---- */}
        <div className="mb-6">
          <CorridorMap
            stages={corridor.stages}
            activeStageId={activeStage}
            status={escrow.status}
            breached={breached}
          />
        </div>

        {/* ---- two-column body ---- */}
        <div className="grid gap-6 xl:grid-cols-2">
          <div className="space-y-6">
            <PoolingMatrix
              members={pooling.members}
              pledgedUsdc={pooling.pledgedUsdc}
              settledUsdc={pooling.settledUsdc}
              progressBps={pooling.progressBps}
              inputAllocationUsdc={usdc(escrow.inputAllocationStroops)}
              bufferAllocationUsdc={usdc(escrow.bufferAllocationStroops)}
              onRefresh={load}
            />
            <FloatVault escrowStatus={escrow.status} onChanged={load} />
          </div>

          <div className="space-y-6">
            <WeatherCockpit
              policy={policy}
              liveRainfallMm={escrow.currentRainfallMm}
              liveDryDays={escrow.consecutiveDryDays}
              oraclePublicKey={identities.oraclePublicKey}
              settled={settled}
              onCommitted={onSettled}
            />
            <SupplierPortal
              settlementStroops={
                settled ? (escrow.supplierPaidStroops ?? '0') : escrow.inputAllocationStroops
              }
              status={escrow.status}
            />
          </div>
        </div>

        <AuditDrawer events={events} explorerBase={explorerBase} />
      </main>

      {/* ══════════════════════ the settlement moment ═══════════════════ */}
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

/** Stroops to a 2-dp display string, truncating rather than rounding. */
function usdc(stroops: string): string {
  const value = BigInt(stroops || '0');
  const whole = value / 10_000_000n;
  const cents = (value % 10_000_000n) / 100_000n;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}
