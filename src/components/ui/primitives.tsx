import type { ReactNode } from 'react';
import { ArrowUpRight } from '@phosphor-icons/react';
import { CountUpUsdc } from './CountUp';

/** Shared presentational primitives for the cockpit. */

/**
 * Double-bezel panel: outer tray, inner plate.
 *
 * The nesting is structural, not decorative — the `.panel` shell carries the
 * hairline and the ambient shadow, the `.panel-core` inside carries the fill
 * and the inner highlight, and their radii are concentric. Encapsulating it
 * here means no call site can accidentally ship a flat single-layer card that
 * breaks the material language.
 */
export function Panel({
  title,
  subtitle,
  action,
  children,
  className = '',
  reveal = true,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Opt out of the scroll-reveal for above-the-fold panels. */
  reveal?: boolean;
}) {
  return (
    <section className={`panel ${reveal ? 'reveal' : ''} ${className}`} data-reveal={reveal}>
      <div className="panel-core p-5">
        {(title || action) && (
          <header className="mb-4 flex items-start justify-between gap-4">
            <div className="min-w-0">
              {title && <h2 className="panel-heading">{title}</h2>}
              {subtitle && (
                <p className="mt-1.5 text-sm leading-snug text-[var(--ink-muted)]">
                  {subtitle}
                </p>
              )}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </header>
        )}
        {children}
      </div>
    </section>
  );
}

export function ModeBadge({ mode }: { mode: 'live' | 'mock' }) {
  const live = mode === 'live';
  return (
    <span className={live ? 'badge badge-land' : 'badge badge-quiet'}>
      {/* Only a live rail pulses. A pulsing "mock" badge would claim activity
          on a rail that is, by definition, not carrying any. */}
      <span className={live ? 'pulse-dot' : 'status-dot'} aria-hidden />
      {live ? 'LIVE' : 'MOCK'}
    </span>
  );
}

/**
 * A labelled figure.
 *
 * `tone` is doing semantic work, not decoration: amber marks value currently
 * at risk or in motion, emerald marks value safely settled, crimson marks a
 * parametric breach.
 */
export function Stat({
  label,
  value,
  stroops,
  unit,
  hint,
  tone = 'default',
  size = 'md',
}: {
  label: string;
  /** Pre-formatted display value. Ignored when `stroops` is supplied. */
  value?: string;
  /**
   * Raw stroop amount. Supplying this instead of `value` animates the figure
   * when it changes, which is what makes a settlement read as an event rather
   * than as a number that was always there.
   */
  stroops?: string;
  unit?: string;
  hint?: string;
  tone?: 'default' | 'amber' | 'emerald' | 'crimson' | 'muted';
  size?: 'sm' | 'md' | 'lg';
}) {
  const toneClass = {
    default: 'text-[var(--ink)]',
    amber: 'text-[var(--amber-bright)]',
    emerald: 'text-[var(--green)]',
    crimson: 'text-[var(--drought-bright)]',
    muted: 'text-[var(--ink-muted)]',
  }[tone];

  const sizeClass = { sm: 'text-lg', md: 'text-2xl', lg: 'text-4xl' }[size];

  return (
    <div className="min-w-0">
      <div className="panel-heading">{label}</div>
      {/* The tone transition matters as much as the count: a figure turning
          crimson as it climbs says "this is relief being paid out" in a way
          the number alone does not. */}
      <div
        className={`mt-1.5 flex items-baseline gap-1.5 transition-colors duration-300 ${toneClass}`}
        style={{ transitionTimingFunction: 'var(--ease-out)' }}
      >
        {stroops !== undefined ? (
          <CountUpUsdc stroops={stroops} className={`numeric font-semibold ${sizeClass}`} />
        ) : (
          <span className={`numeric font-semibold ${sizeClass}`}>{value}</span>
        )}
        {unit && (
          <span className="text-xs font-medium text-[var(--ink-dim)]">{unit}</span>
        )}
      </div>
      {hint && (
        <div className="mt-1 text-xs leading-snug text-[var(--ink-dim)]">{hint}</div>
      )}
    </div>
  );
}

const STATUS_TONE: Record<string, string> = {
  Initialized: 'badge-quiet',
  Funded: 'badge-land',
  InTransit: 'badge-motion',
  ParametricTriggered: 'badge-breach',
  Completed: 'badge-land',
  Refunded: 'badge-quiet',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={`badge ${STATUS_TONE[status] ?? 'badge-quiet'}`}>
      {status.replace(/([a-z])([A-Z])/g, '$1 $2')}
    </span>
  );
}

/** Progress bar with an explicit, readable percentage. */
export function Meter({
  value,
  max = 10_000,
  tone = 'amber',
  label,
}: {
  value: number;
  max?: number;
  tone?: 'amber' | 'emerald' | 'crimson';
  label?: string;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const fill = {
    amber: 'var(--amber)',
    emerald: 'var(--green)',
    crimson: 'var(--drought)',
  }[tone];

  return (
    <div>
      {label && (
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-[var(--ink-muted)]">{label}</span>
          <span className="numeric text-[var(--ink)]">{pct.toFixed(1)}%</span>
        </div>
      )}
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-[var(--panel-sunken)] ring-1 ring-[var(--edge)]"
        role="progressbar"
        aria-valuenow={Number(pct.toFixed(1))}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label ?? 'progress'}
      >
        {/* Scales on `transform`, not `width`. A width transition forces a
            layout pass every frame; this page polls every six seconds and
            re-renders the whole tree, so the cheap version is the only one
            that stays smooth while the rest of the dashboard updates. */}
        <div
          className="h-full w-full origin-left rounded-full"
          style={{
            transform: `scaleX(${pct / 100})`,
            background: fill,
            transition: 'transform 500ms var(--ease-out)',
          }}
        />
      </div>
    </div>
  );
}

/** Monospace address with head/tail truncation and a copy affordance. */
export function AddressChip({
  address,
  label,
  href,
}: {
  address: string;
  label?: string;
  href?: string;
}) {
  const short =
    address.length > 16 ? `${address.slice(0, 6)}…${address.slice(-6)}` : address;

  const body = (
    <span className="numeric text-xs text-[var(--ink-muted)]" title={address}>
      {short}
    </span>
  );

  return (
    <div className="flex items-center gap-2">
      {label && <span className="text-xs text-[var(--ink-dim)]">{label}</span>}
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-dotted underline-offset-2 hover:text-[var(--amber-bright)]"
        >
          {body}
        </a>
      ) : (
        body
      )}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = 'default',
  disabled,
  type = 'button',
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
  disabled?: boolean;
  type?: 'button' | 'submit';
  className?: string;
}) {
  const variants = {
    default:
      'bg-[var(--panel-raised)] text-[var(--ink)] border-[var(--edge-bright)] hover:bg-[#12402f]',
    primary:
      'bg-[var(--amber)] text-[#1a1000] border-[var(--amber-bright)] hover:bg-[var(--amber-bright)] font-semibold',
    danger:
      'bg-[color-mix(in_srgb,var(--drought)_18%,transparent)] text-[var(--drought-bright)] border-[color-mix(in_srgb,var(--drought)_45%,transparent)] hover:bg-[color-mix(in_srgb,var(--drought)_28%,transparent)]',
    ghost:
      'bg-transparent text-[var(--ink-muted)] border-transparent hover:bg-[var(--panel-raised)] hover:text-[var(--ink)]',
  }[variant];

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      // `active:scale-[0.97]` is the whole press affordance. At tens of
      // presses per session it has to be near-imperceptible — anything
      // larger, or slower, and the control starts to feel laggy rather than
      // responsive. Disabled buttons deliberately do not react.
      className={`inline-flex items-center justify-center gap-2 rounded-lg border px-3.5 py-2 text-sm transition-[background-color,border-color,color,transform] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${variants} ${className}`}
      style={{
        transitionDuration: 'var(--dur-press)',
        transitionTimingFunction: 'var(--ease-out)',
      }}
    >
      {children}
    </button>
  );
}

/**
 * Primary call-to-action with a nested trailing glyph.
 *
 * The arrow sits inside its own circular well rather than floating beside the
 * label. On hover the well translates and brightens while the button itself
 * stays put, which creates kinetic tension *inside* the control — it reads as
 * a mechanism with a moving part rather than a rectangle that changes colour.
 *
 * The hover choreography is gated to fine pointers. On touch there is no hover
 * state to enter, so the effect would either never fire or fire stuck-on after
 * a tap.
 */
export function ActionButton({
  children,
  onClick,
  disabled,
  className = '',
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`group inline-flex items-center gap-2.5 rounded-full border border-[var(--amber-bright)] bg-[var(--amber)] py-1.5 pl-4 pr-1.5 text-sm font-semibold text-[#1a1000] transition-[transform,background-color] active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 hover:bg-[var(--amber-bright)] ${className}`}
      style={{
        transitionDuration: 'var(--dur-press)',
        transitionTimingFunction: 'var(--ease-out)',
      }}
    >
      <span>{children}</span>
      <span
        aria-hidden
        className="flex h-7 w-7 items-center justify-center rounded-full bg-[#1a1000]/15 text-xs transition-transform group-hover:[transform:translate(2px,-1px)_scale(1.06)]"
        style={{
          transitionDuration: 'var(--dur-fast)',
          transitionTimingFunction: 'var(--ease-out)',
        }}
      >
        <ArrowUpRight size={13} weight="bold" />
      </span>
    </button>
  );
}

export function Spinner({ className = '' }: { className?: string }) {
  return (
    <span
      className={`inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent ${className}`}
      aria-hidden
    />
  );
}
