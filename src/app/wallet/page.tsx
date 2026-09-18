'use client';

import { PollarWallet } from '@/components/pollar/PollarWallet';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { ModeBadge, Panel } from '@/components/ui/primitives';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The wallet route.
 *
 * Exists because the Pollar integration has two halves that live in different
 * places, and collapsing them would misrepresent both.
 *
 * The server half authenticates as an *application* and is what the rail badge
 * reports. The client half authenticates as a *person*, holds a DPoP-bound
 * session in the browser, and is the only half that can reach Earn, ramps or
 * swap. Showing them side by side is the honest picture: one page, two
 * identities, and a clear statement of which calls each one can make.
 */
export default function WalletPage() {
  const { state, error, reload } = useCorridorState();

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={2} />;
  }

  const pollarRail = state.rails.find((r) => r.rail.startsWith('Pollar'));
  const publishableKey = process.env.NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY ?? null;

  return (
    <PageShell
      eyebrow="Pollar SDK · two identities"
      title={
        <>
          A wallet the farmer
          <br />
          <span className="text-[var(--blue-bright)]">never had to install</span>.
        </>
      }
      lede="Smallholders in Kano do not hold XLM, have not written down a seed phrase, and are not going to install a browser extension. Pollar creates an embedded Stellar wallet from an email address — and the session it issues is what unlocks every user-scoped call this corridor makes."
    >
      <div className="grid gap-6 xl:grid-cols-[1.15fr_1fr]">
        <PollarWallet publishableKey={publishableKey} />

        <div className="space-y-6">
          <Panel
            title="What the server can and cannot do"
            subtitle="The division is Pollar's, not ours, and it is the correct one."
            action={pollarRail ? <ModeBadge mode={pollarRail.mode} /> : null}
          >
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--edge)] text-left">
                  <th className="pb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-dim)]">
                    Endpoint
                  </th>
                  <th className="pb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-dim)]">
                    App key
                  </th>
                  <th className="pb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-dim)]">
                    User session
                  </th>
                </tr>
              </thead>
              <tbody>
                <Row path="/applications/config" app ok user />
                <Row path="/earn/opportunities" app={false} user />
                <Row path="/earn/position" app={false} user />
                <Row path="/ramps/countries" app={false} user />
                <Row path="/ramps/quote" app={false} user />
                <Row path="/swap/tokens" app={false} user />
              </tbody>
            </table>

            <p className="mt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
              Every row marked unavailable answers{' '}
              <code className="numeric">401 SDK_AUTH_INVALID_TOKEN</code> to an application
              key. The tokens are bound to a DPoP keypair held in the user&apos;s browser,
              so a server presenting an application key is — correctly — not that user.
              This is why the wallet panel is a client component while the escrow, the
              oracle and every signing key stay on the server.
            </p>
          </Panel>

          <Panel title="Why an embedded wallet matters here">
            <ul className="space-y-4 text-sm leading-relaxed text-[var(--ink-muted)]">
              <li>
                <span className="font-semibold text-[var(--ink)]">No seed phrase.</span>{' '}
                A custody model that requires a farmer to safeguard twelve words is a
                custody model that loses farmers&apos; money. Pollar holds the key
                material against an email login.
              </li>
              <li>
                <span className="font-semibold text-[var(--ink)]">No XLM.</span>{' '}
                Contract calls made on a member&apos;s behalf are wrapped in a fee-bump
                envelope paid by the sponsorship wallet, so nobody has to acquire a
                network token before they can receive drought relief.
              </li>
              <li>
                <span className="font-semibold text-[var(--ink)]">No app store.</span>{' '}
                The wallet is created in whatever browser the cooperative secretary
                already has open, on whatever device reached this page.
              </li>
            </ul>
          </Panel>
        </div>
      </div>
    </PageShell>
  );
}

function Row({ path, app, user }: { path: string; app: boolean; user: boolean; ok?: boolean }) {
  return (
    <tr className="border-b border-[var(--edge)] last:border-b-0">
      <td className="numeric py-2.5 pr-3 text-[var(--ink-muted)]">{path}</td>
      <td className="py-2.5">
        <span className={app ? 'badge badge-land scale-90' : 'badge badge-quiet scale-90'}>
          {app ? 'YES' : '401'}
        </span>
      </td>
      <td className="py-2.5">
        <span className={user ? 'badge badge-water scale-90' : 'badge badge-quiet scale-90'}>
          {user ? 'YES' : 'NO'}
        </span>
      </td>
    </tr>
  );
}
