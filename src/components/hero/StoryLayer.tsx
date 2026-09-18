'use client';

import { useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import { usePrefersReducedMotion } from '@/components/ui/usePrefersReducedMotion';

/**
 * The story layer.
 *
 * ## What this is for
 *
 * A smallholder farmer, a judge, and a Stellar engineer all land on the same
 * URL. The cockpit below answers the engineer. This answers the other two, in
 * plain words, before any jargon appears.
 *
 * The rule enforced throughout: **no technical term is used before it has
 * been earned.** "Parametric" does not appear until after the reader has been
 * told, in ordinary language, that a contract pays out when the rain stops.
 * "Soroban", "stroops" and "fee-bump" never appear here at all -- they live
 * in the cockpit, where the audience for them already is.
 *
 * ## Motion budget
 *
 * Scroll-linked motion is the one place this product spends generously,
 * because here the motion *is* the explanation: the corridor filling in as
 * you scroll teaches the four-step flow faster than the four captions do.
 * Everything is `transform`/`opacity` only, and the whole layer collapses to
 * static under `prefers-reduced-motion`.
 */

// The globe is a client-only WebGL scene, and it is heavy. Loading it lazily
// keeps it out of the server bundle and off the critical path; the copy and
// the CTA paint first and the planet arrives a beat later.
const CorridorGlobe = dynamic(
  () => import('./CorridorGlobe').then((m) => m.CorridorGlobe),
  { ssr: false },
);

const STEPS = [
  {
    n: '01',
    side: 'land' as const,
    place: 'Kano, Nigeria',
    title: 'Farmers pool what they can',
    plain:
      'Eight families each send a few thousand shillings from the phone in their pocket. Together it becomes a real order.',
    tech: 'NIBSS transfer → Kotani Pay → Stellar USDC',
  },
  {
    n: '02',
    side: 'water' as const,
    place: 'On the Stellar network',
    title: 'The money is held, not spent',
    plain:
      'It sits in a locked account that nobody can quietly empty. Nine tenths buys the inputs. One tenth is kept back for a bad season.',
    tech: '90 / 10 split, enforced on-chain and lossless to the stroop',
  },
  {
    n: '03',
    side: 'water' as const,
    place: 'Caranavi, Bolivia',
    title: 'Inputs ship, the spare tenth earns',
    plain:
      'Bolivian growers send biological inputs across the Atlantic. While the crates are at sea, the money set aside is quietly earning.',
    tech: 'Blend / DeFindex vaults via Pollar Earn',
  },
  {
    n: '04',
    side: 'breach' as const,
    place: 'When the rain fails',
    title: 'Nobody files a claim',
    plain:
      'Satellites watch the rain over Kano. If it stops for three weeks, the money moves on its own. Farmers get cash the same minute. No forms, no inspector, no waiting.',
    tech: 'Signed oracle reading → automatic 60 / 40 settlement',
  },
];

export function StoryLayer({ breached }: { breached: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  // Read during render rather than set from an effect, so a visitor who asked
  // for reduced motion never sees a frame of the animation they opted out of.
  const reduced = usePrefersReducedMotion();

  useEffect(() => {
    if (reduced || !root.current) return;
    gsap.registerPlugin(ScrollTrigger);

    // `gsap.context` scopes every selector to this subtree and gives one
    // `revert()` that cleans up every tween and trigger. Without it, a React
    // remount leaves orphaned ScrollTriggers that fight the new ones.
    const ctx = gsap.context(() => {
      // Hero copy resolves on load, staggered.
      gsap.from('[data-hero-line]', {
        y: 34,
        opacity: 0,
        duration: 1.1,
        ease: 'power3.out',
        stagger: 0.09,
        delay: 0.15,
      });

      // The hero recedes as the reader leaves it, so the story below arrives
      // on a clean stage rather than colliding with the headline.
      gsap.to('[data-hero-inner]', {
        y: -70,
        opacity: 0,
        ease: 'none',
        scrollTrigger: {
          trigger: '[data-hero]',
          start: 'top top',
          end: 'bottom top',
          scrub: 0.6,
        },
      });

      // Each step resolves on entry. `once: true` matters: the page polls
      // every six seconds, and a re-triggering reveal would make the story
      // flicker on a timer.
      //
      // `start: 'top 92%'` is deliberately forgiving. A tighter threshold left
      // steps stranded at opacity 0 on short viewports where the element never
      // reached the stricter line.
      gsap.utils.toArray<HTMLElement>('[data-step]').forEach((el) => {
        gsap.from(el, {
          y: 56,
          opacity: 0,
          duration: 0.85,
          ease: 'power3.out',
          scrollTrigger: { trigger: el, start: 'top 92%', once: true },
        });
      });

      // The spine draws itself as the reader descends. This is the one piece
      // of pure scroll-scrubbing here, and it earns its place: it is the
      // corridor, and watching it complete is the point of the section.
      gsap.fromTo(
        '[data-spine-fill]',
        { scaleY: 0 },
        {
          scaleY: 1,
          ease: 'none',
          transformOrigin: 'top',
          scrollTrigger: {
            trigger: '[data-steps]',
            start: 'top 70%',
            end: 'bottom 80%',
            scrub: 0.5,
          },
        },
      );
    }, root);

    /**
     * Recompute every trigger position once the page has settled.
     *
     * This is not defensive padding; it fixes a real failure. The globe is a
     * lazily-imported WebGL canvas, so the hero's height changes *after*
     * ScrollTrigger has already measured the document. Every start/end offset
     * below the hero is then computed against a stale layout, the step
     * triggers never fire, and the steps stay stuck at `opacity: 0` — a blank
     * section where the story should be.
     *
     * Refreshing on `load`, and again on the next frame for the case where
     * `load` already fired before this effect ran, re-measures against the
     * final layout.
     */
    const refresh = () => ScrollTrigger.refresh();
    const raf = requestAnimationFrame(refresh);
    window.addEventListener('load', refresh);

    // The canvas can also resize after mount on a DPR change or an orientation
    // flip; ResizeObserver catches what `load` cannot.
    const ro = new ResizeObserver(refresh);
    if (root.current) ro.observe(root.current);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('load', refresh);
      ro.disconnect();
      ctx.revert();
    };
  }, [reduced]);

  return (
    <div ref={root}>
      {/* ---------------------------------------------------------- hero */}
      <section
        data-hero
        className="relative flex min-h-[100dvh] items-center justify-center overflow-hidden px-5"
      >
        <CorridorGlobe breached={breached} />

        {/* Legibility scrim. The globe is beautiful and the headline still
            has to be readable over it at every rotation angle. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              'radial-gradient(ellipse 52rem 34rem at 50% 52%, rgba(3,16,15,0.86) 0%, rgba(3,16,15,0.55) 45%, transparent 72%)',
          }}
        />

        <div data-hero-inner className="relative z-10 max-w-3xl text-center">
          <div
            data-hero-line
            className="badge badge-quiet mx-auto mb-7"
          >
            <span className="status-dot" aria-hidden />
            Kano, Nigeria &nbsp;·&nbsp; Caranavi, Bolivia
          </div>

          <h1
            data-hero-line
            className="display text-[clamp(2.6rem,8.5vw,5.6rem)]"
          >
            When the rain fails,
            <br />
            <span className="corridor-text">the money moves.</span>
          </h1>

          <p
            data-hero-line
            className="mx-auto mt-7 max-w-xl text-[clamp(1rem,2.2vw,1.2rem)] leading-relaxed text-[var(--ink-muted)]"
          >
            Maize farmers in Kano buy what they need from growers in Bolivia.
            If drought hits before the harvest, they are paid back
            automatically. No claim form. No inspector. No waiting.
          </p>

          <div
            data-hero-line
            className="mt-9 flex flex-wrap items-center justify-center gap-3"
          >
            <a
              href="#cockpit"
              className="group inline-flex items-center gap-2.5 rounded-full py-2 pl-5 pr-2 text-sm font-semibold text-[#04140d] transition-transform active:scale-[0.97]"
              style={{
                background: 'linear-gradient(100deg, var(--green) 0%, var(--blue) 140%)',
                transitionDuration: 'var(--dur-press)',
                transitionTimingFunction: 'var(--ease-out)',
              }}
            >
              See it working
              <span
                className="flex h-7 w-7 items-center justify-center rounded-full bg-black/15 transition-transform group-hover:[transform:translate(2px,-1px)]"
                style={{
                  transitionDuration: 'var(--dur-fast)',
                  transitionTimingFunction: 'var(--ease-out)',
                }}
                aria-hidden
              >
                ↓
              </span>
            </a>
            <a
              href="#how"
              className="rounded-full border border-[var(--edge-bright)] px-5 py-2.5 text-sm text-[var(--ink-muted)] transition-colors hover:text-[var(--ink)]"
            >
              How it works
            </a>
          </div>
        </div>
      </section>

      {/* --------------------------------------------------------- steps */}
      <section id="how" data-steps className="relative mx-auto max-w-5xl px-5 py-24">
        <div className="mb-16 text-center">
          <h2 className="display text-[clamp(1.9rem,4.6vw,3rem)]">
            Four steps, one corridor
          </h2>
          <p className="mx-auto mt-4 max-w-lg text-[var(--ink-muted)]">
            Every line below is also a live number in the cockpit underneath.
          </p>
        </div>

        <div className="relative">
          {/* The spine. Sits behind the cards on desktop, hidden on mobile
              where the cards already stack in a single column. */}
          <div
            className="absolute left-1/2 top-0 hidden h-full w-px -translate-x-1/2 bg-[var(--edge)] md:block"
            aria-hidden
          >
            <div
              data-spine-fill
              className="h-full w-full origin-top"
              style={{
                background:
                  'linear-gradient(180deg, var(--green) 0%, var(--blue) 72%, var(--drought) 100%)',
              }}
            />
          </div>

          <ol className="space-y-6 md:space-y-16">
            {STEPS.map((s, i) => (
              <li
                key={s.n}
                data-step
                className={`relative md:flex md:items-center md:gap-10 ${
                  i % 2 ? 'md:flex-row-reverse' : ''
                }`}
              >
                <div className="md:w-1/2">
                  <div className="panel">
                    <div className="panel-core p-6">
                      <div className="flex items-center gap-3">
                        <span
                          className={`numeric text-xs font-bold ${
                            s.side === 'land'
                              ? 'text-[var(--green-bright)]'
                              : s.side === 'water'
                                ? 'text-[var(--blue-bright)]'
                                : 'text-[var(--drought-bright)]'
                          }`}
                        >
                          {s.n}
                        </span>
                        <span className="panel-heading">{s.place}</span>
                      </div>

                      <h3 className="mt-3 text-xl font-semibold tracking-tight">
                        {s.title}
                      </h3>
                      <p className="mt-2.5 leading-relaxed text-[var(--ink-muted)]">
                        {s.plain}
                      </p>

                      {/* The technical line is deliberately demoted: smaller,
                          monospace, dimmer. An engineer will find it; a farmer
                          will correctly read it as "not for me". */}
                      <p className="numeric mt-4 border-t border-[var(--edge)] pt-3 text-[0.6875rem] leading-relaxed text-[var(--ink-dim)]">
                        {s.tech}
                      </p>
                    </div>
                  </div>
                </div>

                {/* Node on the spine */}
                <span
                  className="absolute left-1/2 hidden h-3 w-3 -translate-x-1/2 rounded-full ring-4 ring-[var(--bg)] md:block"
                  style={{
                    top: '50%',
                    background:
                      s.side === 'land'
                        ? 'var(--green)'
                        : s.side === 'water'
                          ? 'var(--blue)'
                          : 'var(--drought)',
                  }}
                  aria-hidden
                />
                <div className="hidden md:block md:w-1/2" />
              </li>
            ))}
          </ol>
        </div>
      </section>
    </div>
  );
}
