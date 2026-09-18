'use client';

import { useMemo, useState } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import type { AuditEvent } from '@/components/dashboard/AuditDrawer';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { ModeBadge, Panel } from '@/components/ui/primitives';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The audit route.
 *
 * ## Why this is a page and not only a drawer
 *
 * The cockpit's drawer is for glancing at the last few events without losing
 * your place. An auditor does something different: they filter by category,
 * expand a payload, and follow a hash to an explorer. That is a reading task,
 * and reading tasks do not belong in a 60%-height overlay.
 *
 * ## Why every event carries its own mode
 *
 * A ledger where live and simulated events are visually identical is worse
 * than no ledger, because it invites a reader to assume the whole trail is
 * real. Each row states which it is.
 */

const CATEGORY_COLOR: Record<AuditEvent['category'], string> = {
  ingress: 'var(--green)',
  chain: 'var(--amber)',
  oracle: 'var(--blue)',
  yield: '#a78bfa',
  egress: '#fb923c',
  sponsorship: '#2dd4bf',
  system: 'var(--ink-dim)',
};

const CATEGORY_LABEL: Record<AuditEvent['category'], string> = {
  ingress: 'Ingress',
  chain: 'Chain',
  oracle: 'Oracle',
  yield: 'Yield',
  egress: 'Egress',
  sponsorship: 'Sponsorship',
  system: 'System',
};

type Filter = AuditEvent['category'] | 'all';

export default function AuditPage() {
  const { state, error, reload, explorerBase } = useCorridorState();
  const [filter, setFilter] = useState<Filter>('all');
  const [expanded, setExpanded] = useState<string | null>(null);

  const events = useMemo(() => state?.events ?? [], [state]);

  /**
   * Counts come from the unfiltered set, so a category chip showing `0` tells
   * you that nothing of that kind has happened -- rather than disappearing and
   * leaving you unsure whether the filter exists at all.
   */
  const counts = useMemo(() => {
    const tally = new Map<Filter, number>([['all', events.length]]);
    for (const event of events) {
      tally.set(event.category, (tally.get(event.category) ?? 0) + 1);
    }
    return tally;
  }, [events]);

  const visible = filter === 'all' ? events : events.filter((e) => e.category === filter);

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={3} />;
  }

  const liveCount = events.filter((e) => e.mode === 'live').length;
  const chainedCount = events.filter((e) => e.txHash !== null).length;

  return (
    <PageShell
      eyebrow="Immutable event trail"
      title={
        <>
          Every naira,
          <br />
          <span className="text-[var(--green-bright)]">accounted for</span>.
        </>
      }
      lede="Each event below was written as it happened, with the payload that produced it. Nothing here is reconstructed after the fact, and nothing is summarised — a settlement you cannot trace is a settlement you cannot trust."
      aside={
        <div className="text-right">
          <p className="numeric text-2xl font-semibold tracking-tight text-[var(--ink)]">
            {events.length}
          </p>
          <p className="panel-heading mt-1">Events recorded</p>
        </div>
      }
    >
      {/* ---- on-chain evidence ---- */}
      {state.identities.proofTxHash && (
        <Panel
          className="mb-6"
          title="Verified on chain"
          subtitle="Not a screenshot. Open the hash and read the transfer, the invocation and the state change for yourself."
          action={
            <span className="badge badge-land">
              <span className="pulse-dot" aria-hidden />
              ON CHAIN
            </span>
          }
        >
          <div className="grid gap-5 md:grid-cols-[1.2fr_1fr]">
            <div>
              <p className="text-sm leading-relaxed text-[var(--ink-muted)]">
                <span className="numeric text-[var(--ink)]">20.00 USDC</span> of real
                Stellar testnet USDC moved from the cooperative&apos;s account into the
                escrow contract. <code className="numeric text-[var(--ink-dim)]">deposit_funds</code>{' '}
                performs an actual <code className="numeric text-[var(--ink-dim)]">token::transfer</code> —
                the escrow went from <span className="numeric">Initialized</span> to{' '}
                <span className="numeric">Funded</span> and the contract executed the 90/10
                split itself, to <span className="numeric">18.00</span> and{' '}
                <span className="numeric">2.00</span>.
              </p>
              <p className="mt-3 text-xs leading-relaxed text-[var(--ink-dim)]">
                The invariant was then re-checked against chain state rather than against
                our own arithmetic: input allocation plus climate buffer re-sum to the
                deposit exactly, with no stranded stroop.
              </p>
            </div>

            <dl className="space-y-2.5 text-xs">
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-[var(--ink-dim)]">Transaction</dt>
                <dd className="min-w-0">
                  <a
                    href={`${explorerBase}${state.identities.proofTxHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="numeric break-all text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
                  >
                    {state.identities.proofTxHash}
                  </a>
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-[var(--ink-dim)]">Contract</dt>
                <dd className="numeric min-w-0 break-all text-[var(--ink-muted)]">
                  {state.identities.contractId}
                </dd>
              </div>
              <div className="flex gap-3">
                <dt className="w-20 shrink-0 text-[var(--ink-dim)]">Network</dt>
                <dd className="text-[var(--ink-muted)]">Stellar {state.identities.network}</dd>
              </div>
            </dl>
          </div>
        </Panel>
      )}

      <div className="mb-6 grid gap-4 sm:grid-cols-3">
        <Summary figure={String(events.length)} label="Total events" />
        <Summary
          figure={String(liveCount)}
          label="Against a live rail"
          tone={liveCount > 0 ? 'green' : 'dim'}
        />
        <Summary
          figure={String(chainedCount)}
          label="With an on-chain hash"
          tone={chainedCount > 0 ? 'blue' : 'dim'}
        />
      </div>

      <Panel
        title="Ledger"
        subtitle="Newest first. Expand any row for the full payload as it was recorded."
      >
        {/* ---- category filter ---- */}
        <div className="mb-4 flex flex-wrap gap-1.5">
          {(['all', ...Object.keys(CATEGORY_LABEL)] as Filter[]).map((key) => {
            const active = filter === key;
            const color = key === 'all' ? 'var(--ink)' : CATEGORY_COLOR[key as AuditEvent['category']];
            return (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                data-active={active}
                className="rounded-full px-3 py-1.5 text-xs font-medium transition-[background-color,color] duration-[var(--dur-fast)] ease-[var(--ease-out)] active:scale-[0.97]"
                style={{
                  color: active ? color : 'var(--ink-dim)',
                  background: active
                    ? `color-mix(in srgb, ${color} 14%, transparent)`
                    : 'transparent',
                  boxShadow: active
                    ? `inset 0 0 0 1px color-mix(in srgb, ${color} 34%, transparent)`
                    : 'inset 0 0 0 1px var(--edge)',
                }}
              >
                {key === 'all' ? 'All' : CATEGORY_LABEL[key as AuditEvent['category']]}
                <span className="numeric ml-1.5 opacity-60">{counts.get(key) ?? 0}</span>
              </button>
            );
          })}
        </div>

        {visible.length === 0 ? (
          <div className="panel-sunken px-4 py-10 text-center">
            <p className="text-sm text-[var(--ink-muted)]">
              {events.length === 0
                ? 'No events yet. Contribute from the cooperative page to start the trail.'
                : `No ${CATEGORY_LABEL[filter as AuditEvent['category']].toLowerCase()} events recorded.`}
            </p>
          </div>
        ) : (
          <ul className="space-y-px">
            {visible.map((event) => {
              const isOpen = expanded === event.id;
              const color = CATEGORY_COLOR[event.category];
              return (
                <li key={event.id} className="border-b border-[var(--edge)] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : event.id)}
                    aria-expanded={isOpen}
                    className="flex w-full items-start gap-3 py-3 text-left transition-colors duration-[var(--dur-fast)] hover:bg-[var(--panel-raised)]"
                  >
                    <span
                      className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
                      style={{ background: color }}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1">
                      <span className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <span className="text-sm font-medium text-[var(--ink)]">
                          {event.event.replace(/_/g, ' ')}
                        </span>
                        <span
                          className="numeric rounded-full px-1.5 py-px text-[0.625rem] uppercase tracking-[0.08em]"
                          style={{
                            color,
                            background: `color-mix(in srgb, ${color} 12%, transparent)`,
                          }}
                        >
                          {CATEGORY_LABEL[event.category]}
                        </span>
                        <ModeBadge mode={event.mode} />
                      </span>
                      <span className="mt-1 block text-sm leading-relaxed text-[var(--ink-muted)]">
                        {event.summary}
                      </span>
                    </span>
                    <span className="numeric shrink-0 text-[0.6875rem] text-[var(--ink-dim)]">
                      {new Date(event.at).toLocaleTimeString('en-GB', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </button>

                  {isOpen && (
                    <div className="fade-rise pb-4 pl-5">
                      {event.txHash && (
                        <a
                          href={`${explorerBase}${event.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="numeric mb-2 inline-flex items-center gap-1 break-all text-xs text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
                        >
                          {event.txHash}
                          <ArrowUpRight size={11} weight="bold" aria-hidden />
                        </a>
                      )}
                      <pre className="thin-scroll panel-sunken max-h-72 overflow-auto px-3.5 py-3 text-[0.6875rem] leading-relaxed text-[var(--ink-muted)]">
                        {JSON.stringify(event.detail, null, 2)}
                      </pre>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel className="mt-6" title="What the three webhook defences actually stop">
        <div className="grid gap-5 md:grid-cols-3">
          <Defence
            title="HMAC-SHA256 signature"
            attack="Forgery"
            body="Computed over the raw request body before any parsing. Re-serialising JSON reorders keys and normalises whitespace, producing different bytes and a signature that no longer verifies — so the raw buffer is what gets signed and checked."
          />
          <Defence
            title="Idempotency ledger"
            attack="Replay"
            body="A correctly signed callback is still valid the second time it arrives. Every settlement reference is recorded, and a repeat is acknowledged without crediting the escrow twice."
          />
          <Defence
            title="Freshness window"
            attack="Delayed replay"
            body="A signature captured today stays cryptographically valid forever. A timestamp outside the window is rejected, so a callback held back and released next week cannot settle."
          />
        </div>
        <p className="mt-5 border-t border-[var(--edge)] pt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
          These are three distinct defences because they stop three distinct attacks.
          Any one alone leaves a hole the other two would have closed.
        </p>
      </Panel>
    </PageShell>
  );
}

function Summary({
  figure,
  label,
  tone = 'dim',
}: {
  figure: string;
  label: string;
  tone?: 'green' | 'blue' | 'dim';
}) {
  const color =
    tone === 'green' ? 'var(--green-bright)' : tone === 'blue' ? 'var(--blue-bright)' : 'var(--ink)';
  return (
    <div className="panel-sunken px-4 py-3.5">
      <p className="numeric text-2xl font-semibold tracking-tight" style={{ color }}>
        {figure}
      </p>
      <p className="panel-heading mt-1">{label}</p>
    </div>
  );
}

function Defence({ title, attack, body }: { title: string; attack: string; body: string }) {
  return (
    <div>
      <p className="badge badge-breach scale-90 origin-left">{attack}</p>
      <p className="mt-2.5 text-sm font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
    </div>
  );
}
