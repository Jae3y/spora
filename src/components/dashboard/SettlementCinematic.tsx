'use client';

import { useEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '@/components/ui/usePrefersReducedMotion';

/**
 * The settlement cinematic.
 *
 * ## What it is
 *
 * The moment the parametric breach fires, this takes the screen. Two handsets
 * fly in from opposite edges -- a NIBSS phone in Kano and a bank app in
 * Caranavi -- the Stellar transaction hash prints between them, and both
 * receive their notification *in the same beat*.
 *
 * This is the demo's whole argument compressed into four seconds: one signed
 * weather reading, two continents, no claim form. Everything else in the
 * product exists to make this moment true.
 *
 * ## Why the two arrivals are simultaneous, not sequential
 *
 * They settle in one on-chain transaction. Animating Nigeria first and Bolivia
 * second would imply a sequence that does not exist and would quietly
 * misrepresent how the contract works. They land together because they *are*
 * together.
 *
 * ## Choreography
 *
 * ```
 *  0ms   backdrop fades, cockpit dims
 *  260   verdict line resolves
 *  520   both handsets fly in from their own edges
 *  1150  the wire between them draws
 *  1500  hash prints, character by character
 *  2300  both notifications drop, together
 *  3100  amounts count up
 * ```
 *
 * Driven by one `requestAnimationFrame` clock rather than seven nested
 * `setTimeout`s: a single timeline can be scrubbed, replayed and cancelled
 * coherently, and it cannot drift out of order if the main thread stalls
 * mid-sequence.
 */

export interface SettlementPayload {
  /** Emergency relief to the Nigerian cooperative, USDC display string. */
  cooperativeUsdc: string;
  /** Equivalent Naira the farmers actually receive in their wallets. */
  cooperativeNgn: string;
  /** Indemnity to the Bolivian supplier, USDC display string. */
  supplierUsdc: string;
  /** Equivalent BOB settled through the QR rail. */
  supplierBob: string;
  /** Stellar transaction hash, or null in mock mode. */
  txHash: string | null;
  explorerUrl: string | null;
  rainfallMm: number;
  dryDays: number;
}

const BEATS = {
  verdict: 260,
  handsets: 520,
  wire: 1150,
  hash: 1500,
  notify: 2300,
  amounts: 3100,
  done: 4200,
} as const;

export function SettlementCinematic({
  payload,
  onClose,
  onReplay,
}: {
  payload: SettlementPayload;
  onClose: () => void;
  onReplay: () => void;
}) {
  const reduced = usePrefersReducedMotion();
  const [t, setT] = useState(0);
  const raf = useRef<number | null>(null);
  const started = useRef<number>(0);
  const dialogRef = useRef<HTMLDivElement>(null);

  // One clock for the whole sequence.
  useEffect(() => {
    if (reduced) {
      // Skip straight to the resolved state: the information still lands, only
      // the choreography is dropped. Deferred by one frame rather than set
      // synchronously here, which would schedule a second render before paint.
      raf.current = requestAnimationFrame(() => {
        setT(BEATS.done);
        raf.current = null;
      });
      return () => {
        if (raf.current !== null) cancelAnimationFrame(raf.current);
      };
    }

    started.current = performance.now();
    const tick = (now: number) => {
      const elapsed = now - started.current;
      setT(elapsed);
      if (elapsed < BEATS.done) raf.current = requestAnimationFrame(tick);
      else raf.current = null;
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [reduced]);

  // Escape closes. Focus moves into the dialog so the sequence is reachable
  // by keyboard and a screen reader announces it rather than leaving focus
  // stranded on the button that fired it.
  useEffect(() => {
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const after = (ms: number) => t >= ms;
  /** 0→1 progress through a beat, eased. */
  const prog = (start: number, dur: number) => {
    const p = Math.max(0, Math.min(1, (t - start) / dur));
    return 1 - Math.pow(1 - p, 3); // easeOutCubic
  };

  const hashChars = payload.txHash
    ? Math.floor(prog(BEATS.hash, 700) * payload.txHash.length)
    : 0;

  return (
    <div
      className="modal-backdrop fixed inset-0 z-[80] flex items-center justify-center overflow-y-auto p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Parametric settlement executed"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative w-full max-w-5xl outline-none"
      >
        {/* ---------------------------------------------------- verdict */}
        <div
          className="mb-5 text-center transition-all lg:mb-8"
          style={{
            opacity: after(BEATS.verdict) ? 1 : 0,
            transform: `translateY(${after(BEATS.verdict) ? 0 : 14}px)`,
            transitionDuration: '520ms',
            transitionTimingFunction: 'var(--ease-out)',
          }}
        >
          <div className="badge badge-breach mx-auto mb-4">
            <span className="pulse-dot" aria-hidden />
            PARAMETRIC BREACH
          </div>
          <h2 className="display text-[clamp(1.7rem,4.6vw,2.9rem)]">
            The rain stopped. The money moved.
          </h2>
          <p className="numeric mt-3 text-sm text-[var(--ink-muted)]">
            {payload.rainfallMm} mm over 21 days &nbsp;·&nbsp; {payload.dryDays}{' '}
            consecutive dry days &nbsp;·&nbsp; threshold breached
          </p>
        </div>

        {/* ---------------------------------------------------- handsets */}
        <div className="grid items-center gap-3 sm:gap-5 lg:grid-cols-[1fr_auto_1fr] lg:gap-6">
          <Handset
            side="left"
            visible={after(BEATS.handsets)}
            carrier="TRANSFER"
            carrierTone="land"
            place="Kano, Nigeria"
            person="Amina Yusuf Dantata"
            notified={after(BEATS.notify)}
            title="You have received"
            amount={payload.cooperativeNgn}
            currency="₦"
            sub={`${payload.cooperativeUsdc} USDC emergency relief`}
            body="Confirmed. Funds available now. No claim required."
            showAmount={after(BEATS.amounts)}
          />

          {/* ------------------------------------------------------ wire */}
          <div className="relative flex min-w-0 flex-col items-center gap-3 py-2 lg:min-w-[13rem] lg:py-4">
            <div
              className="h-px w-full origin-left"
              style={{
                background:
                  'linear-gradient(90deg, var(--green) 0%, var(--amber) 50%, var(--blue) 100%)',
                transform: `scaleX(${prog(BEATS.wire, 620)})`,
              }}
              aria-hidden
            />
            <div
              className="text-center transition-opacity duration-500"
              style={{ opacity: after(BEATS.hash) ? 1 : 0 }}
            >
              <div className="panel-heading mb-1.5">Stellar settlement</div>
              {payload.txHash ? (
                <a
                  href={payload.explorerUrl ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="numeric block break-all text-[0.6875rem] leading-relaxed text-[var(--amber-bright)] underline decoration-dotted underline-offset-2"
                >
                  {payload.txHash.slice(0, hashChars)}
                  {hashChars < payload.txHash.length && (
                    <span className="opacity-50">▍</span>
                  )}
                </a>
              ) : (
                <span className="numeric text-[0.6875rem] text-[var(--ink-dim)]">
                  simulated settlement
                </span>
              )}
              <div className="numeric mt-2 text-[0.625rem] text-[var(--ink-dim)]">
                one transaction &nbsp;·&nbsp; two continents
              </div>
            </div>
            <div
              className="h-px w-full origin-right"
              style={{
                background:
                  'linear-gradient(90deg, var(--green) 0%, var(--amber) 50%, var(--blue) 100%)',
                transform: `scaleX(${prog(BEATS.wire, 620)})`,
              }}
              aria-hidden
            />
          </div>

          <Handset
            side="right"
            visible={after(BEATS.handsets)}
            carrier="BANCO"
            carrierTone="water"
            place="Caranavi, Bolivia"
            person="Caranavi Biofert SRL"
            notified={after(BEATS.notify)}
            title="Pago recibido"
            amount={payload.supplierBob}
            currency="BOB"
            sub={`${payload.supplierUsdc} USDC input indemnity`}
            body="QR Simple liquidado. Fondos disponibles."
            showAmount={after(BEATS.amounts)}
          />
        </div>

        {/* ----------------------------------------------------- actions */}
        <div
          className="mt-6 flex flex-wrap items-center justify-center gap-3 transition-opacity duration-500 lg:mt-9"
          style={{ opacity: after(BEATS.amounts) ? 1 : 0 }}
        >
          <button
            type="button"
            onClick={onReplay}
            className="rounded-full border border-[var(--edge-bright)] px-5 py-2.5 text-sm text-[var(--ink-muted)] transition-transform active:scale-[0.97] hover:text-[var(--ink)]"
          >
            Replay
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full px-5 py-2.5 text-sm font-semibold text-[#04140d] transition-transform active:scale-[0.97]"
            style={{
              background: 'linear-gradient(100deg, var(--green) 0%, var(--blue) 150%)',
            }}
          >
            Back to the cockpit
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * One handset.
 *
 * Flies in from its own side of the screen, which is what makes the two feel
 * like two ends of a corridor rather than two cards in a row.
 */
function Handset({
  side,
  visible,
  carrier,
  carrierTone,
  place,
  person,
  notified,
  title,
  amount,
  currency,
  sub,
  body,
  showAmount,
}: {
  side: 'left' | 'right';
  visible: boolean;
  carrier: string;
  carrierTone: 'land' | 'water';
  place: string;
  person: string;
  notified: boolean;
  title: string;
  amount: string;
  currency: string;
  sub: string;
  body: string;
  showAmount: boolean;
}) {
  const tone = carrierTone === 'land' ? 'var(--green)' : 'var(--blue)';
  const offset = side === 'left' ? -60 : 60;

  return (
    <div
      className="mx-auto w-[11rem] sm:w-[13rem] lg:w-[15.5rem]"
      style={{
        opacity: visible ? 1 : 0,
        transform: `translateX(${visible ? 0 : offset}px) scale(${visible ? 1 : 0.94})`,
        transition:
          'opacity 700ms var(--ease-out), transform 700ms var(--ease-out)',
      }}
    >
      <div className="handset p-2">
        <div className="handset-screen relative flex min-h-[15rem] flex-col p-3 sm:min-h-[18rem] lg:min-h-[21rem]">
          <div className="mx-auto mb-2 h-1 w-12 rounded-full bg-[#2a2219]" aria-hidden />

          <div className="flex items-center justify-between px-1 text-[0.625rem] text-[var(--ink-dim)]">
            <span className="font-semibold" style={{ color: tone }}>
              {carrier}
            </span>
            <span className="numeric">
              {new Date().toLocaleTimeString('en-GB', {
                hour: '2-digit',
                minute: '2-digit',
              })}
            </span>
          </div>

          <div className="flex flex-1 items-center justify-center py-3 lg:py-5">
            {notified ? (
              <div
                className="w-full rounded-xl p-3.5 text-[0.6875rem] leading-relaxed"
                style={{
                  background: `color-mix(in srgb, ${tone} 12%, #04100e)`,
                  boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${tone} 34%, transparent)`,
                  animation: 'fade-rise 420ms var(--ease-out) both',
                }}
              >
                <div
                  className="mb-1.5 text-[0.625rem] font-bold uppercase tracking-wider"
                  style={{ color: tone }}
                >
                  {title}
                </div>

                <div className="flex items-baseline gap-1.5">
                  <span
                    className="numeric text-2xl font-semibold transition-opacity duration-500"
                    style={{ color: tone, opacity: showAmount ? 1 : 0 }}
                  >
                    {amount}
                  </span>
                  <span className="text-[0.625rem] text-[var(--ink-dim)]">
                    {currency}
                  </span>
                </div>

                <div className="numeric mt-1 text-[0.5625rem] text-[var(--ink-dim)]">
                  {sub}
                </div>
                <p className="mt-2.5 text-[var(--ink-muted)]">{body}</p>
              </div>
            ) : (
              <span className="text-[0.625rem] text-[var(--ink-dim)]">
                awaiting settlement…
              </span>
            )}
          </div>

          <div className="mx-auto h-1 w-16 rounded-full bg-[#2a2219]" aria-hidden />
        </div>
      </div>

      <div className="mt-3 text-center">
        <div className="text-xs font-medium text-[var(--ink)]">{person}</div>
        <div className="text-[0.6875rem] text-[var(--ink-dim)]">{place}</div>
      </div>
    </div>
  );
}
