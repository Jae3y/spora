'use client';

import { useSyncExternalStore } from 'react';

/**
 * Whether the visitor has asked for reduced motion.
 *
 * `useSyncExternalStore` rather than `useEffect` + `useState`. A media query is
 * an external, mutable source of truth that React does not own, which is
 * precisely what this hook exists for. The effect-and-state version has two
 * real defects beyond the lint rule that flags it:
 *
 * 1. It calls `setState` synchronously in the effect body, forcing a second
 *    render pass before paint on every mount.
 * 2. It reports `false` on the first render even for a visitor who asked for
 *    reduced motion, so an animation can start playing for one frame before
 *    being switched off. For someone with a vestibular disorder that frame is
 *    the whole problem.
 *
 * `useSyncExternalStore` reads the real value during render and subscribes for
 * changes, so neither happens.
 */

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void): () => void {
  if (typeof window === 'undefined' || !window.matchMedia) return () => {};
  const mql = window.matchMedia(QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}

function getSnapshot(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia(QUERY).matches;
}

/**
 * Server snapshot.
 *
 * `false` is the honest default: the server cannot know the preference, and
 * rendering the reduced variant for everyone would strip motion from visitors
 * who never asked for it. The client corrects on hydration, before paint.
 */
function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
