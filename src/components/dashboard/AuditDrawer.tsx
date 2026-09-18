'use client';

import { useEffect, useState } from 'react';
import { ArrowUpRight, CaretUp } from '@phosphor-icons/react';

/**
 * On-chain audit drawer.
 *
 * A persistent bottom drawer carrying every ledger event, with direct links to
 * Stellar Expert. Collapsed to a summary bar by default so it never competes
 * with the cockpit for attention, but always one click from the full trail.
 *
 * Events are colour-coded by *rail* rather than by severity. In a corridor
 * spanning four asynchronous systems, "which system did this come from" is the
 * question an auditor asks first, and severity is already legible from the
 * text.
 */

export interface AuditEvent {
  id: string;
  at: string;
  category: 'ingress' | 'chain' | 'oracle' | 'yield' | 'egress' | 'sponsorship' | 'system';
  event: string;
  summary: string;
  txHash: string | null;
  mode: 'live' | 'mock';
  detail: Record<string, unknown>;
}

const CATEGORY_COLOR: Record<AuditEvent['category'], string> = {
  ingress: 'var(--green)',
  chain: 'var(--amber)',
  oracle: 'var(--blue)',
  yield: '#a78bfa',
  egress: '#fb923c',
  sponsorship: '#2dd4bf',
  system: 'var(--ink-dim)',
};

export function AuditDrawer({
  events,
  explorerBase,
}: {
  events: AuditEvent[];
  explorerBase: string;
}) {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  /**
   * The drawer belongs to the cockpit, not to the story.
   *
   * Pinned to the viewport unconditionally it sat on top of the hero's primary
   * call to action -- a ledger-inspection tool obscuring the one control a
   * first-time visitor needs. It now stays out of the way until the reader has
   * actually descended into the technical half of the page.
   */
  const [inCockpit, setInCockpit] = useState(false);

  useEffect(() => {
    const cockpit = document.getElementById('cockpit');
    if (!cockpit || typeof IntersectionObserver === 'undefined') {
      // No cockpit anchor or no observer support: show the drawer rather than
      // hide it forever. Deferred a frame so the fallback does not schedule a
      // second render pass before paint.
      const frame = requestAnimationFrame(() => setInCockpit(true));
      return () => cancelAnimationFrame(frame);
    }
    const io = new IntersectionObserver(
      ([entry]) => setInCockpit(entry.isIntersecting || entry.boundingClientRect.top < 0),
      // Arm once the cockpit's top edge is a fifth of the way up the viewport,
      // so the drawer is already in place by the time there is anything to
      // audit on screen.
      { rootMargin: '0px 0px -80% 0px', threshold: 0 },
    );
    io.observe(cockpit);
    return () => io.disconnect();
  }, []);

  const onChainCount = events.filter((e) => e.txHash).length;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 transition-opacity duration-500"
      style={{
        opacity: inCockpit ? 1 : 0,
        visibility: inCockpit ? 'visible' : 'hidden',
        transitionTimingFunction: 'var(--ease-out)',
      }}
      aria-hidden={!inCockpit}
    >
      {/*
        Slides on `transform` rather than growing `max-height` — see
        `.drawer-shell` in globals.css for why. The shell is always full
        height and simply sits below the viewport edge when closed, which is
        also what makes the motion spatially honest: the drawer comes from the
        bottom because it lives at the bottom.
      */}
      <div
        data-open={open}
        className="drawer-shell pointer-events-auto mx-auto flex max-w-[1600px] flex-col border-t border-[var(--edge-bright)] bg-[var(--panel)]/95 backdrop-blur"
        style={{ boxShadow: '0 -20px 50px -30px rgba(0,0,0,0.9)' }}
      >
        {/* Summary bar */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="flex h-14 w-full shrink-0 items-center justify-between gap-4 px-5 text-left transition-colors hover:bg-[var(--panel-raised)]"
        >
          <div className="flex items-center gap-3">
            <span className="panel-heading">On-chain audit trail</span>
            <span className="badge badge-quiet">
              <span className="numeric">{events.length}</span> events
            </span>
            {onChainCount > 0 && (
              <span className="badge badge-motion">
                <span className="numeric">{onChainCount}</span> on chain
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {!open && events[0] && (
              <span className="hidden max-w-xl truncate text-xs text-[var(--ink-dim)] sm:block">
                {events[0].summary}
              </span>
            )}
            {/* One icon that rotates, rather than two that swap. A swap reads
                as a flicker; the rotation shows the same control changing
                direction.

                Phosphor rather than the U+25B4 glyph it replaced: small
                geometric-shape codepoints have patchy font coverage and fall
                back to tofu on systems without a matching glyph. */}
            <CaretUp
              size={14}
              weight="bold"
              className="text-[var(--ink-muted)]"
              style={{
                transform: open ? 'rotate(180deg)' : 'rotate(0deg)',
                transition: 'transform var(--dur-base) var(--ease-out)',
              }}
              aria-hidden
            />
          </div>
        </button>

        {/* Event list. Always mounted: unmounting it would make the drawer
            animate open over an empty box and fill in afterwards. */}
        <div
          className="thin-scroll min-h-0 flex-1 overflow-y-auto border-t border-[var(--edge)] px-5 py-3"
          aria-hidden={!open}
        >
            {events.length === 0 ? (
              <p className="py-8 text-center text-sm text-[var(--ink-dim)]">
                No ledger events yet. Contribute via bank transfer or run a chaos scenario.
              </p>
            ) : (
              <ol className="space-y-1">
                {events.map((e, index) => (
                  // Only the newest row animates in. Applying the entrance to
                  // every row would replay the whole list on each six-second
                  // poll, which is both distracting and the exact "animate
                  // data the user is reading" mistake.
                  <li key={e.id} className={index === 0 ? 'fade-rise' : undefined}>
                    <div
                      className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-[var(--panel-raised)]"
                      onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                    >
                      <span
                        className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: CATEGORY_COLOR[e.category] }}
                        aria-hidden
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                          <span
                            className="numeric text-[0.6875rem] font-semibold uppercase tracking-wide"
                            style={{ color: CATEGORY_COLOR[e.category] }}
                          >
                            {e.event}
                          </span>
                          <span className="numeric text-[0.6875rem] text-[var(--ink-dim)]">
                            {new Date(e.at).toLocaleTimeString('en-GB')}
                          </span>
                          <span
                            className={
                              e.mode === 'live'
                                ? 'badge badge-land scale-90'
                                : 'badge badge-quiet scale-90'
                            }
                          >
                            {e.mode}
                          </span>
                        </div>
                        <p className="mt-0.5 text-sm leading-snug text-[var(--ink-muted)]">
                          {e.summary}
                        </p>

                        {expanded === e.id && (
                          <pre className="thin-scroll fade-rise mt-2 max-h-56 overflow-auto rounded-lg bg-[var(--panel-sunken)] p-3 text-[0.6875rem] leading-relaxed text-[var(--ink-dim)]">
                            {JSON.stringify(e.detail, null, 2)}
                          </pre>
                        )}
                      </div>

                      {e.txHash && (
                        <a
                          href={`${explorerBase}${e.txHash}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          onClick={(ev) => ev.stopPropagation()}
                          className="numeric inline-flex shrink-0 items-center gap-0.5 text-[0.6875rem] text-[var(--amber-bright)] underline decoration-dotted underline-offset-2"
                          title={e.txHash}
                        >
                          {e.txHash.slice(0, 8)}…
                          <ArrowUpRight size={10} weight="bold" aria-hidden />
                        </a>
                      )}
                    </div>
                  </li>
                ))}
              </ol>
            )}
        </div>
      </div>
    </div>
  );
}
