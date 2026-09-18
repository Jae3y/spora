'use client';

import { ArrowUpRight } from '@phosphor-icons/react';
import { CorridorMap } from '@/components/dashboard/CorridorMap';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { ModeBadge, Panel, Stat, StatusBadge } from '@/components/ui/primitives';
import { COOPERATIVE, DESTINATION, ORIGIN, RAILS, SUPPLIER } from '@/lib/corridor';
import { FX_RATES } from '@/lib/money';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The corridor route.
 *
 * Answers one question in detail: what physically happens to a farmer's naira
 * between the moment they dial `*737#` and the moment a Bolivian exporter is
 * paid in bolivianos.
 *
 * Each leg is stated with the rail that carries it and the settlement time it
 * actually takes. A corridor diagram that hides the rails is a marketing
 * graphic; naming NIBSS, Stellar and ASFI QR Simple is what makes it a
 * payments document.
 */

interface Leg {
  id: string;
  from: string;
  to: string;
  instrument: string;
  rail: string;
  settles: string;
  note: string;
  tone: 'green' | 'blue' | 'amber';
}

const LEGS: Leg[] = [
  {
    id: 'ngn',
    from: `Farmer handset · ${ORIGIN.city}`,
    to: 'Kotani Pay collection account',
    instrument: 'NGN',
    rail: `${RAILS.ingress.rail} · ${RAILS.ingress.ussdCode}`,
    settles: 'seconds',
    note: `Authorised inside the SIM applet. The PIN never leaves the handset, so no server on this corridor can hold it. Wallet apps built on the same rail — ${RAILS.ingress.wallets.join(', ')} — reach the identical NIBSS endpoint.`,
    tone: 'green',
  },
  {
    id: 'usdc',
    from: 'Kotani Pay',
    to: 'Spora escrow contract',
    instrument: 'NGN → USDC',
    rail: 'Stellar · Soroban invocation',
    settles: '~5 seconds',
    note: 'Kotani signs the settlement callback with HMAC-SHA256 over the raw body. Three independent defences guard this hop: signature verification stops forgery, an idempotency ledger stops replay, and a freshness window stops a captured-but-delayed callback landing days later.',
    tone: 'blue',
  },
  {
    id: 'split',
    from: 'Escrow deposit',
    to: 'Inputs 90% · climate buffer 10%',
    instrument: 'USDC',
    rail: 'Contract-enforced allocation',
    settles: 'same transaction',
    note: 'The split is integer arithmetic in the contract, not a display convention. The buffer is computed by subtraction from the total rather than by a second multiplication, which is what makes it lossless — the two parts always re-sum to the deposit exactly, with no stranded stroop.',
    tone: 'amber',
  },
  {
    id: 'float',
    from: 'Climate buffer',
    to: 'Blend or DeFindex',
    instrument: 'USDC',
    rail: 'Pollar Earn',
    settles: 'continuous',
    note: 'Idle buffer earns while the shipment is in transit. The provider is chosen by live APY at deployment time rather than hardcoded, and the position is redeemed in full before any terminal settlement so yield can never be stranded behind a closed escrow.',
    tone: 'amber',
  },
  {
    id: 'bob',
    from: 'Escrow',
    to: `${SUPPLIER.name} · ${DESTINATION.city}`,
    instrument: 'USDC → BOB',
    rail: `Pollar ${RAILS.egress.rail}`,
    settles: 'minutes',
    note: 'Bolivia has no card rails worth using for this and a parallel FX market that moves daily. QR Simple is the ASFI-mandated interoperable standard every Bolivian bank app reads, which makes a payload the only artefact the supplier needs.',
    tone: 'blue',
  },
];

const TONE: Record<Leg['tone'], string> = {
  green: 'var(--green)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
};

export default function CorridorPage() {
  const { state, error, reload, breached, settled } = useCorridorState();

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={2} />;
  }

  const { escrow, corridor, rails, identities } = state;

  const activeStage =
    escrow.status === 'Initialized'
      ? 'ngn'
      : escrow.status === 'Funded'
        ? 'usdc'
        : escrow.status === 'InTransit'
          ? 'float'
          : 'bob';

  return (
    <PageShell
      eyebrow={`${ORIGIN.city}, ${ORIGIN.country} → ${DESTINATION.city}, ${DESTINATION.country}`}
      title={
        <>
          One transfer, two continents,
          <br />
          <span className="text-[var(--blue-bright)]">four currencies</span>.
        </>
      }
      lede={`${COOPERATIVE.memberCount} farmers pool naira in ${COOPERATIVE.lga}. It lands as USDC on Stellar, waits out the shipment earning yield, and leaves as bolivianos in the Yungas. Every leg below names the rail that carries it.`}
      aside={<StatusBadge status={escrow.status} />}
    >
      <div className="mb-6">
        <CorridorMap
          stages={corridor.stages}
          activeStageId={activeStage}
          status={escrow.status}
          breached={breached}
        />
      </div>

      {/* ---- the legs ---- */}
      <Panel title="Settlement path" className="mb-6">
        <ol className="space-y-px">
          {LEGS.map((leg, index) => {
            const reached = LEGS.findIndex((l) => l.id === activeStage) >= index;
            return (
              <li
                key={leg.id}
                data-reached={reached}
                className="group relative grid gap-4 border-b border-[var(--edge)] py-5 last:border-b-0 md:grid-cols-[auto_1fr_1.6fr] md:gap-6"
              >
                {/* Rail index. The connecting line is drawn between markers
                    rather than around them, so a leg that has not been
                    reached reads as unlit track rather than as missing. */}
                <div className="flex items-center gap-3 md:w-24 md:flex-col md:items-start md:gap-2">
                  <span
                    className="numeric flex h-7 w-7 items-center justify-center rounded-full text-[0.6875rem] font-semibold transition-colors duration-[var(--dur-base)]"
                    style={{
                      color: reached ? TONE[leg.tone] : 'var(--ink-dim)',
                      boxShadow: `inset 0 0 0 1px ${
                        reached
                          ? `color-mix(in srgb, ${TONE[leg.tone]} 55%, transparent)`
                          : 'var(--edge)'
                      }`,
                      background: reached
                        ? `color-mix(in srgb, ${TONE[leg.tone]} 12%, transparent)`
                        : 'transparent',
                    }}
                  >
                    {index + 1}
                  </span>
                  <span className="numeric text-[0.6875rem] uppercase tracking-[0.12em] text-[var(--ink-dim)]">
                    {leg.settles}
                  </span>
                </div>

                <div className="min-w-0">
                  <p className="text-[0.9375rem] font-semibold leading-snug text-[var(--ink)]">
                    {leg.from}
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 text-[0.9375rem] leading-snug text-[var(--ink-muted)]">
                    <span className="text-[var(--ink-dim)]">↳</span> {leg.to}
                  </p>
                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    <span
                      className="numeric rounded-full px-2 py-0.5 text-[0.6875rem] font-medium"
                      style={{
                        color: TONE[leg.tone],
                        background: `color-mix(in srgb, ${TONE[leg.tone]} 12%, transparent)`,
                      }}
                    >
                      {leg.instrument}
                    </span>
                    <span className="text-[0.6875rem] text-[var(--ink-dim)]">{leg.rail}</span>
                  </div>
                </div>

                <p className="text-sm leading-relaxed text-[var(--ink-muted)]">{leg.note}</p>
              </li>
            );
          })}
        </ol>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[1.1fr_1fr]">
        {/* ---- live position ---- */}
        <Panel title="Capital in the corridor right now">
          <div className="grid gap-5 sm:grid-cols-2">
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
              label="Disbursed"
              stroops={escrow.totalDisbursedStroops}
              unit="USDC"
              tone={settled ? 'emerald' : 'muted'}
            />
          </div>

          <div className="mt-5 border-t border-[var(--edge)] pt-4">
            <p className="panel-heading">Reference rates</p>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
              <FxRow label="NGN / USD" value={FX_RATES.ngnPerUsd.toLocaleString('en-US')} />
              <FxRow
                label="BOB / USD official"
                value={FX_RATES.bobPerUsdOfficial.toFixed(2)}
              />
              <FxRow
                label="BOB / USD parallel"
                value={FX_RATES.bobPerUsdParallel.toFixed(2)}
              />
            </dl>
            <p className="mt-3 text-xs leading-relaxed text-[var(--ink-dim)]">
              Bolivia runs a pegged official rate alongside a parallel market that trades
              around {((FX_RATES.bobPerUsdParallel / FX_RATES.bobPerUsdOfficial - 1) * 100).toFixed(0)}%
              wider. The supplier chooses which rate the QR is cut at, and the choice is
              recorded — pretending only one rate exists would misstate what the exporter
              actually receives.
            </p>
          </div>
        </Panel>

        {/* ---- rails ---- */}
        <Panel
          title="Rail status"
          subtitle="Each badge is a live probe against the provider, not a check for whether an API key string exists."
        >
          <ul className="space-y-2">
            {rails.map((rail) => (
              <li key={rail.rail} className="panel-sunken px-3.5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-[var(--ink)]">{rail.rail}</span>
                  <ModeBadge mode={rail.mode} />
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-dim)]">
                  {rail.detail}
                </p>
              </li>
            ))}
          </ul>

          {identities.contractExplorerUrl && (
            <a
              href={identities.contractExplorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="numeric mt-4 inline-flex items-center gap-1 break-all text-xs text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
            >
              {identities.contractId}
              <ArrowUpRight size={11} weight="bold" aria-hidden />
            </a>
          )}
        </Panel>
      </div>
    </PageShell>
  );
}

function FxRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-[var(--ink-dim)]">{label}</dt>
      <dd className="numeric mt-0.5 text-sm text-[var(--ink)]">{value}</dd>
    </div>
  );
}
