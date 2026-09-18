'use client';

import type { ReactNode } from 'react';
import Link from 'next/link';
import { Button } from '@/components/ui/primitives';
import { useReveal } from '@/components/ui/useReveal';

/**
 * Shell for every route below the homepage.
 *
 * ## Why the top padding is a constant here
 *
 * The nav is `position: fixed`, so it contributes nothing to layout. Every
 * interior route therefore has to reserve the same headroom, and doing that
 * per page guarantees one of them eventually reserves a different amount and
 * has its first heading clipped behind the pill. It is declared once.
 *
 * ## Why the eyebrow carries a corridor leg
 *
 * Seven routes in a dark interface start to look alike after the third. The
 * eyebrow states which end of the corridor you are standing at -- Kano,
 * Caranavi, or the chain in between -- so the page announces its own position
 * before the heading has to.
 */
export function PageShell({
  eyebrow,
  title,
  lede,
  aside,
  children,
}: {
  eyebrow: string;
  title: ReactNode;
  lede: string;
  /** Optional right-hand block: a status badge, a figure, an action. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  useReveal();

  return (
    <main id="content" className="mx-auto max-w-[1600px] px-4 pb-16 pt-28 sm:px-6 sm:pt-32">
      <header className="mb-10 border-b border-[var(--edge)] pb-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-2xl">
            <p className="panel-heading">{eyebrow}</p>
            <h1 className="mt-3 text-[clamp(1.875rem,4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.025em] text-[var(--ink)]">
              {title}
            </h1>
            <p className="mt-4 text-[0.9375rem] leading-relaxed text-[var(--ink-muted)]">
              {lede}
            </p>
          </div>
          {aside && <div className="shrink-0">{aside}</div>}
        </div>
      </header>

      {children}
    </main>
  );
}

/**
 * Failure state shared by every data-backed route.
 *
 * A blank panel with a spinner that never resolves is the worst outcome for a
 * judge on a flaky conference network: it is indistinguishable from a product
 * that does not work. The reason and a retry are always shown.
 */
export function RouteError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <main
      id="content"
      className="mx-auto flex min-h-[70dvh] max-w-md items-center justify-center px-6 pt-28"
    >
      <div className="panel w-full">
        <div className="panel-core p-6 text-center">
          <p className="text-sm font-semibold text-[var(--drought-bright)]">
            Could not reach the corridor API
          </p>
          <p className="mt-2 text-sm leading-relaxed text-[var(--ink-muted)]">{message}</p>
          <div className="mt-5 flex items-center justify-center gap-2">
            <Button onClick={onRetry}>Retry</Button>
            <Link href="/">
              <Button variant="ghost">Back to overview</Button>
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * Loading state for an interior route.
 *
 * Skeletons match the shape of what is coming rather than showing a spinner,
 * so the layout does not jump when data lands.
 */
export function RouteSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <main id="content" className="mx-auto max-w-[1600px] px-4 pb-16 pt-28 sm:px-6 sm:pt-32">
      <div className="mb-10 border-b border-[var(--edge)] pb-8">
        <div className="skeleton h-3 w-28 rounded" />
        <div className="skeleton mt-4 h-9 w-2/3 max-w-lg rounded" />
        <div className="skeleton mt-4 h-4 w-full max-w-2xl rounded" />
      </div>
      <div className="space-y-6">
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} className="panel">
            <div className="panel-core p-5">
              <div className="skeleton h-3 w-32 rounded" />
              <div className="skeleton mt-4 h-24 w-full rounded" />
            </div>
          </div>
        ))}
      </div>
    </main>
  );
}
