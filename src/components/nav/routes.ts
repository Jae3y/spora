/**
 * The site's route table.
 *
 * ## Why this is not in `SiteNav.tsx`
 *
 * It was, and it broke every page with
 * `ROUTES.map is not a function`.
 *
 * `SiteNav` is a `'use client'` module. When a Server Component -- the footer,
 * in this case -- imports a *value* from a client module, the bundler does not
 * give it the value. It gives it a client-reference proxy, because the only
 * things that cross that boundary are component references and serialisable
 * props. So `ROUTES` arrived as an opaque object with no `.map`.
 *
 * TypeScript cannot catch this: the types are entirely correct, and only the
 * runtime module graph differs. Shared data therefore lives in a module with
 * no directive at all, which both environments can import for real.
 */

export interface NavRoute {
  href: string;
  label: string;
  /** Shown in the mobile overlay and the homepage route index, where there
      is room to say what the page is for. */
  blurb: string;
}

export const ROUTES: readonly NavRoute[] = [
  { href: '/', label: 'Overview', blurb: 'The corridor, end to end' },
  { href: '/corridor', label: 'Corridor', blurb: 'Kano to Caranavi, stage by stage' },
  { href: '/cooperative', label: 'Cooperative', blurb: 'Eight farmers in Dawakin Kudu' },
  { href: '/oracle', label: 'Oracle', blurb: 'Three satellites, one verdict' },
  { href: '/wallet', label: 'Wallet', blurb: 'Pollar embedded wallet, live session' },
  { href: '/supplier', label: 'Supplier', blurb: 'Bolivian payout and QR egress' },
  { href: '/audit', label: 'Audit', blurb: 'Every event, every signature' },
  { href: '/how-it-works', label: 'How it works', blurb: 'The contract and the economics' },
] as const;
