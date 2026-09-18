'use client';

import { useEffect } from 'react';

/**
 * Reveals `.reveal` elements as they enter the viewport.
 *
 * ## Why IntersectionObserver and not a scroll listener
 *
 * This dashboard re-renders its whole tree every six seconds from a poll. A
 * `scroll` handler on top of that would run layout-reading work on the main
 * thread during exactly the frames the poll is already competing for.
 * IntersectionObserver does the work off the main thread and fires once.
 *
 * ## Why elements are unobserved after revealing
 *
 * The class swap is one-way. Without unobserving, a panel scrolled out and
 * back would replay its entrance — and because the poll re-renders anyway, a
 * re-triggering reveal would make the page appear to flicker on a timer.
 *
 * Runs against a `MutationObserver` too, so panels that mount later (the QR
 * result, the settlement partition) are picked up without the caller having
 * to re-register anything.
 */
export function useReveal(): void {
  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;

    const reveal = (el: Element) => {
      el.classList.add('reveal-in');
      el.classList.remove('reveal');
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          reveal(entry.target);
          observer.unobserve(entry.target);
        }
      },
      // Fire slightly before the panel's top edge clears the fold, so the
      // motion has finished by the time it is comfortably in view.
      { rootMargin: '0px 0px -8% 0px', threshold: 0.06 },
    );

    const attach = () => {
      for (const el of document.querySelectorAll('.reveal')) {
        observer.observe(el);
      }
    };

    attach();

    // Anything already on screen at mount reveals immediately rather than
    // waiting for a scroll that may never come on a short viewport.
    const mutations = new MutationObserver(attach);
    mutations.observe(document.body, { childList: true, subtree: true });

    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, []);
}
