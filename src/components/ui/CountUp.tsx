'use client';

import { useEffect, useRef, useState } from 'react';

/**
 * Animated numeric readout for settlement figures.
 *
 * ## Why this exists
 *
 * When the parametric breach fires, `KANO RELIEF PAID` goes from `0.00` to
 * `1,200.68` on the next poll. That figure is the entire point of the product
 * — the moment capital actually reaches a farmer — and rendering it as an
 * instant swap wastes it. Worse, an instant swap is genuinely ambiguous: with
 * five stat tiles refreshing every six seconds, a value that teleports is
 * indistinguishable from one that was always there.
 *
 * ## Why it counts in stroops, not in display units
 *
 * Interpolating the *display* string would mean parsing "1,200.68" back to a
 * float and re-formatting each frame, reintroducing the floating-point error
 * the whole money layer exists to avoid. This interpolates the underlying
 * integer stroop value with `bigint` arithmetic and formats each frame from
 * that, so every intermediate frame is a real, exactly-representable amount
 * and the final frame is bit-identical to the input.
 *
 * ## Constraints honoured
 *
 * - Only runs on a *change*; the first render paints the final value with no
 *   animation, so a page load never shows numbers scrambling up from zero.
 * - Skipped entirely under `prefers-reduced-motion`.
 * - Cancels cleanly on unmount and on a value that changes mid-flight.
 */

/** Rare, high-emotion moment — outside the 300ms UI budget on purpose. */
const COUNT_DURATION_MS = 900;

export function CountUpUsdc({
  stroops,
  className = '',
}: {
  stroops: string;
  className?: string;
}) {
  const target = safeBigInt(stroops);
  const [display, setDisplay] = useState<bigint>(target);
  const previous = useRef<bigint>(target);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const from = previous.current;
    const to = safeBigInt(stroops);

    if (from === to) return;
    previous.current = to;

    // Respect the user's motion preference, and skip the animation for a
    // change so small it would be invisible anyway.
    const reduced =
      typeof window !== 'undefined' &&
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

    if (reduced) {
      // Jump straight to the target, but do it on the next frame rather than
      // synchronously inside the effect body. A synchronous setState here
      // schedules a second render pass before paint; deferring one frame is
      // imperceptible and keeps the effect free of cascading renders.
      frame.current = requestAnimationFrame(() => {
        setDisplay(to);
        frame.current = null;
      });
      return () => {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
      };
    }

    const start = performance.now();
    const delta = to - from;

    const step = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(1, elapsed / COUNT_DURATION_MS);
      // easeOutExpo: fast commitment, long settle. The value is legible for
      // most of the animation rather than blurring past and snapping.
      const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);

      // Scale the eased fraction to 1e6 so the interpolation stays in bigint
      // space; a float multiply against a bigint delta is not representable.
      const scaled = BigInt(Math.round(eased * 1_000_000));
      setDisplay(from + (delta * scaled) / 1_000_000n);

      if (t < 1) {
        frame.current = requestAnimationFrame(step);
      } else {
        // Land exactly on the target rather than on the interpolated
        // approximation — a settlement figure must be exact.
        setDisplay(to);
        frame.current = null;
      }
    };

    frame.current = requestAnimationFrame(step);
    return () => {
      if (frame.current !== null) cancelAnimationFrame(frame.current);
    };
  }, [stroops]);

  return <span className={className}>{formatStroops(display)}</span>;
}

/** Stroops to a 2-dp display string, truncating rather than rounding. */
function formatStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / 10_000_000n;
  const cents = (abs % 10_000_000n) / 100_000n;
  return `${negative ? '-' : ''}${whole.toLocaleString('en-US')}.${cents
    .toString()
    .padStart(2, '0')}`;
}

/** A malformed figure must render as zero, never crash the dashboard. */
function safeBigInt(value: string): bigint {
  try {
    return BigInt(value || '0');
  } catch {
    return 0n;
  }
}
