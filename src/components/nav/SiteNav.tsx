'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { List, X } from '@phosphor-icons/react';
import { ROUTES, type NavRoute } from './routes';

export { ROUTES };
export type { NavRoute };

/**
 * Corridor navigation.
 *
 * ## Why a floating pill rather than a full-width bar
 *
 * The homepage opens on a full-bleed globe. A conventional edge-to-edge navbar
 * glued to `top: 0` would cut a hard horizontal line across it and kill the
 * one moment of the interface that has no chrome at all. A detached pill sits
 * *over* the scene instead of cropping it.
 *
 * ## Why the active indicator is a background, not an underline
 *
 * An underline needs a measured width and a resize observer to stay aligned.
 * A pill-shaped background inherits the link's own box, so it can never drift
 * out of registration with its label -- including when a font is still
 * swapping in and the label is 12px wider than it will finally be.
 *
 * ## Frequency budget
 *
 * Navigation is used tens of times in a session, which per the motion budget
 * means *near-imperceptible* movement or none. The indicator crossfades at
 * 200ms; nothing slides, scales or bounces. The mobile overlay is the one
 * exception -- it is opened rarely and is a genuine spatial change, so it
 * earns a staggered reveal.
 */

export function SiteNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [lifted, setLifted] = useState(false);

  /**
   * The pill only takes its heavier shadow once the page has moved. At scroll
   * zero it floats over the hero with almost no weight, which keeps the globe
   * the loudest thing on screen.
   */
  useEffect(() => {
    const onScroll = () => setLifted(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * Route change closes the overlay. Without this, tapping a link on mobile
   * navigates behind a menu that is still covering the screen.
   *
   * Adjusted during render rather than in an effect. React discards an
   * in-progress render that calls `setState` and restarts it before anything
   * reaches the DOM, so the closed menu is the only thing ever committed. An
   * effect would paint the new route *underneath* the open overlay for one
   * frame and then close it, which is visible as a flash.
   *
   * Closing in the link's `onClick` would miss browser back and forward, which
   * change the pathname with no click involved.
   */
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setOpen(false);
  }

  /** Escape closes, and the body locks while the overlay owns the viewport. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const isActive = (href: string) =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <>
      {/* Skip link. The cockpit routes are long and keyboard users should not
          have to tab through seven nav items to reach the content. */}
      <a
        href="#content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-[var(--panel-raised)] focus:px-4 focus:py-2 focus:text-sm focus:text-[var(--ink)] focus:outline-none focus:ring-2 focus:ring-[var(--blue)]"
      >
        Skip to content
      </a>

      <header className="pointer-events-none fixed inset-x-0 top-0 z-50 flex justify-center px-4 pt-4 sm:pt-5">
        <nav
          aria-label="Primary"
          data-lifted={lifted}
          className="glass pointer-events-auto flex w-full max-w-[1100px] items-center gap-2 rounded-full py-1.5 pl-2 pr-1.5 transition-[box-shadow,background-color] duration-[var(--dur-base)] ease-[var(--ease-out)] data-[lifted=true]:bg-[rgba(8,32,49,0.86)]"
        >
          <Link
            href="/"
            className="group flex shrink-0 items-center gap-2 rounded-full px-3 py-1.5 transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] active:scale-[0.97]"
          >
            <SporaMark />
            <span className="text-[0.9375rem] font-semibold tracking-tight text-[var(--ink)]">
              Spora
            </span>
          </Link>

          {/* Desktop links */}
          <ul className="ml-1 hidden flex-1 items-center gap-0.5 lg:flex">
            {ROUTES.map((route) => {
              const active = isActive(route.href);
              return (
                <li key={route.href}>
                  <Link
                    href={route.href}
                    aria-current={active ? 'page' : undefined}
                    data-active={active}
                    className="relative block rounded-full px-3 py-1.5 text-[0.8125rem] font-medium text-[var(--ink-dim)] transition-colors duration-[var(--dur-fast)] ease-[var(--ease-out)] hover:text-[var(--ink)] data-[active=true]:text-[var(--ink)]"
                  >
                    {active && (
                      <span
                        className="absolute inset-0 rounded-full bg-[color-mix(in_srgb,var(--blue)_18%,transparent)] shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--blue)_34%,transparent)]"
                        aria-hidden
                      />
                    )}
                    <span className="relative">{route.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>

          <div className="flex-1 lg:hidden" />

          <Link
            href="/cooperative"
            className="group hidden shrink-0 items-center gap-2 rounded-full bg-[var(--ink)] py-1.5 pl-4 pr-1.5 text-[0.8125rem] font-semibold text-[var(--void)] transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] active:scale-[0.97] sm:flex"
          >
            Contribute
            {/* Button-in-button: the arrow gets its own well rather than
                floating naked beside the label. */}
            <span className="flex h-6 w-6 items-center justify-center rounded-full bg-[color-mix(in_srgb,var(--void)_12%,transparent)] transition-transform duration-[var(--dur-fast)] ease-[var(--ease-out)] group-hover:translate-x-0.5 group-hover:-translate-y-px">
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden>
                <path
                  d="M1.5 8.5 8.5 1.5M8.5 1.5H3.2M8.5 1.5v5.3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </span>
          </Link>

          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-[var(--ink-muted)] transition-transform duration-[var(--dur-press)] ease-[var(--ease-out)] hover:text-[var(--ink)] active:scale-[0.94] lg:hidden"
          >
            {open ? <X size={18} weight="bold" /> : <List size={18} weight="bold" />}
          </button>
        </nav>
      </header>

      {/* Mobile overlay */}
      {open && (
        <div
          className="fixed inset-0 z-40 flex flex-col justify-end bg-[rgba(3,13,20,0.86)] px-4 pb-8 pt-24 backdrop-blur-2xl lg:hidden"
          onClick={() => setOpen(false)}
        >
          <ul className="space-y-1" onClick={(e) => e.stopPropagation()}>
            {ROUTES.map((route, index) => (
              <li
                key={route.href}
                className="fade-rise"
                style={{ animationDelay: `${index * 45}ms` }}
              >
                <Link
                  href={route.href}
                  data-active={isActive(route.href)}
                  className="block rounded-[var(--r-well)] px-4 py-3 transition-colors duration-[var(--dur-fast)] data-[active=true]:bg-[color-mix(in_srgb,var(--blue)_14%,transparent)]"
                >
                  <span className="block text-lg font-semibold tracking-tight text-[var(--ink)]">
                    {route.label}
                  </span>
                  <span className="mt-0.5 block text-[0.8125rem] text-[var(--ink-dim)]">
                    {route.blurb}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}

/**
 * The mark: a seed splitting into two paths.
 *
 * Green stroke for the land leg, blue for the water leg -- the same semantic
 * the whole interface runs on, stated once at the smallest possible size. The
 * orbit is broken rather than closed: a complete ring reads as a generic
 * badge, and the gap is where the corridor is still in flight.
 *
 * Geometry is shared with `public/spora-mark.svg`, which is the source for the
 * favicon and every exported PNG, so the nav and the browser tab can never
 * drift into being two different logos.
 */
function SporaMark() {
  return (
    <svg width="22" height="22" viewBox="0 0 512 512" fill="none" aria-hidden>
      <circle
        cx="256" cy="256" r="196"
        fill="none" stroke="var(--edge-bright)" strokeWidth="14"
        strokeLinecap="round" strokeDasharray="64 44" opacity="0.6"
      />
      <path
        d="M256 398 C256 306 288 268 352 236"
        fill="none" stroke="var(--blue)" strokeWidth="42" strokeLinecap="round"
      />
      <path
        d="M256 398 C256 306 224 268 160 236"
        fill="none" stroke="var(--green)" strokeWidth="42" strokeLinecap="round"
      />
      <circle cx="256" cy="142" r="52" fill="var(--green-bright)" />
    </svg>
  );
}
