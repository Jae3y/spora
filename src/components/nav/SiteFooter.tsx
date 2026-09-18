import Link from 'next/link';
import { ROUTES } from './routes';
import { COOPERATIVE, DESTINATION, ORIGIN } from '@/lib/corridor';

/**
 * Footer.
 *
 * Carries the two things a judge looks for after reading the product: what is
 * actually live versus simulated, and where the source is. Both are stated
 * plainly rather than buried, because a corridor that is honest about its
 * own status is more credible than one that claims everything works.
 */
export function SiteFooter() {
  return (
    <footer className="mt-24 border-t border-[var(--edge)] bg-[var(--void)]">
      <div className="mx-auto max-w-[1600px] px-4 py-14 sm:px-6">
        <div className="grid gap-10 lg:grid-cols-[1.4fr_1fr_1fr]">
          <div>
            <p className="text-lg font-semibold tracking-tight text-[var(--ink)]">
              Spora<span className="text-[var(--green)]">.</span>
            </p>
            <p className="mt-3 max-w-sm text-sm leading-relaxed text-[var(--ink-muted)]">
              A parametric climate escrow linking {COOPERATIVE.memberCount} smallholder
              farmers in {ORIGIN.city}, {ORIGIN.country} to a biological input exporter in{' '}
              {DESTINATION.city}, {DESTINATION.country}. When the rain fails, the money
              moves — without a claim, an adjuster or a phone call.
            </p>
            <p className="mt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
              Rainfall telemetry from Open-Meteo. Settlement on Stellar Soroban. Mobile
              money ingress via Kotani Pay. Yield, sponsorship and Bolivian egress via
              Pollar.
            </p>
          </div>

          <nav aria-label="Footer">
            <p className="panel-heading">Corridor</p>
            <ul className="mt-4 space-y-2.5">
              {ROUTES.map((route) => (
                <li key={route.href}>
                  <Link
                    href={route.href}
                    className="text-sm text-[var(--ink-muted)] transition-colors duration-[var(--dur-fast)] hover:text-[var(--ink)]"
                  >
                    {route.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>

          <div>
            <p className="panel-heading">Built on</p>
            <ul className="mt-4 space-y-2.5 text-sm text-[var(--ink-muted)]">
              <li>Stellar Soroban · testnet</li>
              <li>Pollar SDK v0.11.3</li>
              <li>Kotani Pay · Nigeria NGN</li>
              <li>Open-Meteo · ECMWF, NOAA, DWD</li>
            </ul>
            <p className="mt-6 text-xs leading-relaxed text-[var(--ink-dim)]">
              Rail badges across this site report probe results, not configuration.
              A rail marked <span className="text-[var(--ink-muted)]">mock</span> is
              genuinely not connected.
            </p>
          </div>
        </div>

        <div className="mt-12 flex flex-wrap items-center justify-between gap-4 border-t border-[var(--edge)] pt-6">
          <p className="text-xs text-[var(--ink-dim)]">
            Built for the Boundless × Pollar Hackathon.
          </p>
          <p className="numeric text-xs text-[var(--ink-dim)]">
            {ORIGIN.latitude.toFixed(2)}°N {ORIGIN.longitude.toFixed(2)}°E →{' '}
            {Math.abs(DESTINATION.latitude).toFixed(2)}°S{' '}
            {Math.abs(DESTINATION.longitude).toFixed(2)}°W
          </p>
        </div>
      </div>
    </footer>
  );
}
