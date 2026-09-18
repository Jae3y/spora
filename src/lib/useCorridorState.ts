'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEvent } from '@/components/dashboard/AuditDrawer';
import type { CorridorStage } from '@/components/dashboard/CorridorMap';
import type { Member } from '@/components/dashboard/PoolingMatrix';
import type { PolicyShape } from '@/components/dashboard/WeatherCockpit';

/**
 * Shared corridor state.
 *
 * Every page reads the same `/api/escrow/state` snapshot through this hook, so
 * the treasury figure on `/cooperative` and the one on `/` can never disagree.
 * When the state lived inside the single page component, splitting the product
 * into routes would have meant each route inventing its own fetch, its own
 * poll interval and its own idea of "now" -- and a judge clicking between two
 * tabs would see two different balances.
 *
 * Polling pauses when the tab is hidden. A demo left open in a background tab
 * otherwise hammers the Soroban RPC and Open-Meteo's free tier for nothing.
 */

export interface EscrowShape {
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
  accruedYieldStroops?: string;
  bufferDeployedStroops?: string;
}

export interface CorridorState {
  escrow: EscrowShape;
  chainError: string | null;
  corridor: { stages: CorridorStage[] };
  pooling: {
    members: Member[];
    pledgedUsdc: string;
    settledUsdc: string;
    pledgedStroops: string;
    settledStroops: string;
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
    supplierDeferred: {
      publicKey: string;
      status: string;
      committedReserveXlm: number;
      derivationPath: string;
    };
    contractId: string | null;
    contractExplorerUrl: string | null;
    network: string;
  };
  rails: Array<{ rail: string; mode: 'live' | 'mock'; detail: string }>;
  events: AuditEvent[];
}

const POLL_INTERVAL_MS = 6_000;

export interface CorridorStateResult {
  state: CorridorState | null;
  error: string | null;
  busy: string | null;
  reload: () => Promise<void>;
  dispatch: (action: string) => Promise<void>;
  /** Convenience flags every page needs. */
  breached: boolean;
  settled: boolean;
  explorerBase: string;
}

export function useCorridorState(): CorridorStateResult {
  const [state, setState] = useState<CorridorState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  /** Guards against a poll resolving after unmount. */
  const mounted = useRef(true);

  const reload = useCallback(async () => {
    try {
      const response = await fetch('/api/escrow/state', { cache: 'no-store' });
      const json = await response.json();
      if (!mounted.current) return;
      if (!json?.ok) throw new Error(json?.error?.message ?? 'Failed to load state');
      setState(json.data as CorridorState);
      setError(null);
    } catch (cause) {
      if (mounted.current) setError((cause as Error).message);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    // `reload` awaits a network round trip before it calls setState, so no
    // state update happens synchronously in this effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reload();

    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(reload, POLL_INTERVAL_MS);
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
        reload();
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
  }, [reload]);

  const dispatch = useCallback(
    async (action: string) => {
      setBusy(action);
      try {
        const response = await fetch('/api/escrow/state', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
        });
        const json = await response.json();
        if (!json?.ok) throw new Error(json?.error?.message ?? `${action} failed`);
        await reload();
      } catch (cause) {
        setError((cause as Error).message);
      } finally {
        setBusy(null);
      }
    },
    [reload],
  );

  const status = state?.escrow.status;
  const breached = status === 'ParametricTriggered';
  const settled = breached || status === 'Completed';
  const explorerBase = `https://stellar.expert/explorer/${
    state?.identities.network === 'mainnet' ? 'public' : 'testnet'
  }/tx/`;

  return { state, error, busy, reload, dispatch, breached, settled, explorerBase };
}

/** Stroops to a 2-dp display string, truncating rather than rounding. */
export function usdc(stroops: string | undefined): string {
  const value = BigInt(stroops || '0');
  const whole = value / 10_000_000n;
  const cents = (value % 10_000_000n) / 100_000n;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}
