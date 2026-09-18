'use client';

import { useCallback, useEffect, useState } from 'react';
import { Button, Panel, Spinner, Stat } from '@/components/ui/primitives';

/**
 * Pollar Earn float vault.
 *
 * Shows every yield venue across every enabled provider, ranked by APY, and
 * lets the operator deploy or redeem the 10% climate buffer.
 *
 * ## Why the full venue list is shown, not just the winner
 *
 * The selection rule ("highest APY across Blend *and* DeFindex") is only
 * credible if the alternatives are visible. Showing one number invites the
 * question of what it was compared against; showing the ranked set answers it.
 * It also makes the provider fan-out visible — this panel is the UI proof that
 * both providers were actually queried.
 */

interface Opportunity {
  provider: string;
  id: string;
  name: string;
  kind: 'vault' | 'lending';
  apy: number;
  assetCode: string;
  mode: 'live' | 'mock';
}

interface EarnState {
  opportunities: Opportunity[];
  best: Opportunity | null;
  buffer: {
    usdc: string;
    stroops: string;
    deployedStroops: string;
    accruedStroops: string;
  };
  projection: { windowDays: number; apy: number; usdc: string; model: string };
}

export function FloatVault({
  escrowStatus,
  onChanged,
}: {
  escrowStatus: string;
  onChanged: () => void;
}) {
  const [state, setState] = useState<EarnState | null>(null);
  const [busy, setBusy] = useState<'deploy' | 'redeem' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/pollar/earn');
      const json = await response.json();
      if (json?.ok) setState(json.data as EarnState);
    } catch {
      /* The panel degrades to its empty state; the corridor still works. */
    }
  }, []);

  useEffect(() => {
    // `load` awaits a network round trip before calling setState, so nothing
    // updates synchronously here. The rule cannot see through the async
    // boundary inside the memoised callback.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load, escrowStatus]);

  async function act(action: 'deploy' | 'redeem') {
    setBusy(action);
    setError(null);
    try {
      const response = await fetch('/api/pollar/earn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json?.error?.message ?? `${action} failed`);
      }
      await load();
      onChanged();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const deployed = BigInt(state?.buffer.deployedStroops ?? '0');
  const isDeployed = deployed > 0n;

  return (
    <Panel
      title="Pollar Earn float vault"
      subtitle="The 10% climate buffer earns yield while the shipment is in transit."
      action={
        state?.best && (
          <span className={state.best.mode === 'live' ? 'badge badge-land' : 'badge badge-quiet'}>
            {state.best.mode}
          </span>
        )
      }
    >
      <div className="grid gap-4 sm:grid-cols-3">
        <Stat
          label="Buffer available"
          value={state?.buffer.usdc ?? '0.00'}
          unit="USDC"
          tone="amber"
        />
        <Stat
          label="Deployed"
          value={isDeployed ? (Number(deployed) / 1e7).toFixed(2) : '0.00'}
          unit="USDC"
          tone={isDeployed ? 'emerald' : 'muted'}
        />
        <Stat
          label={`Projected · ${state?.projection.windowDays ?? 28}d`}
          value={state?.projection.usdc ?? '0.00'}
          unit="USDC"
          tone="emerald"
          hint={state?.projection.model}
        />
      </div>

      {/* Venue ranking */}
      <div className="mt-4 space-y-1.5">
        <div className="panel-heading">Venues ranked by APY</div>
        {(state?.opportunities ?? []).map((o, i) => (
          <div
            key={o.id}
            className={`panel-sunken flex items-center justify-between gap-3 px-3 py-2.5 ${
              i === 0 ? 'ring-1 ring-[var(--amber)]' : ''
            }`}
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm text-[var(--ink)]">{o.name}</span>
                {i === 0 && <span className="badge badge-motion scale-90">SELECTED</span>}
              </div>
              <div className="text-[0.6875rem] uppercase tracking-wide text-[var(--ink-dim)]">
                {o.provider} · {o.kind} · {o.assetCode}
              </div>
            </div>
            <span className="numeric shrink-0 text-lg font-semibold text-[var(--green)]">
              {(o.apy * 100).toFixed(2)}%
            </span>
          </div>
        ))}
        {!state?.opportunities.length && (
          <p className="py-4 text-center text-sm text-[var(--ink-dim)]">
            No Earn venues available on this network.
          </p>
        )}
      </div>

      <div className="mt-4 flex gap-2">
        <Button
          variant="default"
          onClick={() => act('deploy')}
          disabled={busy !== null || isDeployed || !state?.best}
        >
          {busy === 'deploy' ? (
            <>
              <Spinner /> Deploying…
            </>
          ) : (
            'Deploy buffer'
          )}
        </Button>
        <Button
          variant="default"
          onClick={() => act('redeem')}
          disabled={busy !== null || !isDeployed}
        >
          {busy === 'redeem' ? (
            <>
              <Spinner /> Redeeming…
            </>
          ) : (
            'Redeem buffer'
          )}
        </Button>
      </div>

      {error && <p className="mt-3 text-sm text-[var(--drought-bright)]">{error}</p>}
    </Panel>
  );
}
