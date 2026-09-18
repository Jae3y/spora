'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuthState, EarnOpportunity, PollarClient } from '@pollar/core';
import { Button, Panel, Spinner } from '@/components/ui/primitives';

/**
 * Pollar wallet, running where Pollar is actually designed to run.
 *
 * ## Why this is a client component and the rest of the corridor is not
 *
 * The server-side integration could authenticate as an *application* but could
 * not call a single user-scoped endpoint: `/earn/*`, `/ramps/*`, `/swap/*` and
 * `/kyc/*` all answer `401 SDK_AUTH_INVALID_TOKEN` to an application key,
 * because they are scoped to an end user and require a DPoP-bound session.
 *
 * That is not a misconfiguration. Pollar is a client-side wallet SDK: it
 * creates an embedded wallet for a real person, binds tokens to a keypair held
 * in that browser, and proves possession of that key on every request. A
 * server holding an application key is, correctly, not that person.
 *
 * So the escrow, the oracle and the settlement logic stay on the server where
 * signing keys belong, and the wallet lives here — which is the only place it
 * can hold a session at all.
 *
 * ## Why email OTP rather than Google
 *
 * OAuth needs a popup and a redirect allow-list. Email OTP completes inside
 * this panel, which means a judge on a conference network can reach an
 * authenticated embedded wallet without leaving the page or owning an account
 * anywhere.
 *
 * ## The key here is publishable by design
 *
 * `pub_testnet_…` is meant to ship to browsers. It is scoped to this
 * application and to an origin allow-list, and it cannot move funds on its
 * own — every privileged action is bound to the user's DPoP key. The secret
 * key never leaves the server.
 */

type Phase = 'loading' | 'ready' | 'email' | 'code' | 'working' | 'authed' | 'error';

interface EarnState {
  opportunities: EarnOpportunity[];
  error: string | null;
  loading: boolean;
}

export function PollarWallet({ publishableKey }: { publishableKey: string | null }) {
  const clientRef = useRef<PollarClient | null>(null);

  /**
   * A missing key is knowable at first render, so it is initial state rather
   * than something an effect discovers. Deriving it in an effect would render
   * a spinner for one frame and then replace it with an error, which reads as
   * a failed load rather than as a configuration gap.
   */
  const [phase, setPhase] = useState<Phase>(publishableKey ? 'loading' : 'error');
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(
    publishableKey ? null : 'No Pollar publishable key configured for this deployment.',
  );
  const [wallet, setWallet] = useState<string | null>(null);
  const [earn, setEarn] = useState<EarnState>({
    opportunities: [],
    error: null,
    loading: false,
  });

  /**
   * The SDK is imported dynamically.
   *
   * `@pollar/core` touches `window`, `localStorage` and `crypto.subtle` at
   * construction. A static import would pull all of that into the server
   * render and fail the build, so the module is only fetched once this
   * component is running in a browser.
   */
  useEffect(() => {
    if (!publishableKey) return;

    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    (async () => {
      try {
        const { PollarClient: Client } = await import('@pollar/core');
        if (disposed) return;

        const client = new Client({
          apiKey: publishableKey,
          stellarNetwork: 'testnet',
        });
        clientRef.current = client;

        unsubscribe = client.onAuthStateChange((state) => {
          if (disposed) return;
          setAuthState(state);

          if (state.step === 'authenticated') {
            setWallet(state.session.wallet?.address ?? null);
            setPhase('authed');
            setError(null);
          } else if (state.step === 'entering_email') {
            setPhase('email');
          } else if (state.step === 'entering_code') {
            setPhase('code');
          } else if (state.step === 'error') {
            setError(state.message);
            setPhase('error');
          }
        });

        await client.ready();
        if (disposed) return;
        // `ready()` restores a stored session, so a returning judge is already
        // signed in and the auth callback has already moved us to `authed`.
        setPhase((p) => (p === 'loading' ? 'ready' : p));
      } catch (cause) {
        if (!disposed) {
          setError((cause as Error).message);
          setPhase('error');
        }
      }
    })();

    return () => {
      disposed = true;
      unsubscribe?.();
      clientRef.current?.destroy?.();
      clientRef.current = null;
    };
  }, [publishableKey]);

  /** Load Earn venues with the user's own session — the call the server cannot make. */
  const loadEarn = useCallback(async () => {
    const client = clientRef.current;
    if (!client) return;

    setEarn((e) => ({ ...e, loading: true, error: null }));
    try {
      // Both providers are requested and merged: Blend is a lending pool and
      // DeFindex is a vault, and which one yields more changes by the day. A
      // corridor that hardcoded one would be leaving the cooperative's climate
      // buffer in whichever venue happened to be worse.
      const results = await Promise.allSettled([
        client.getEarnOpportunities('blend'),
        client.getEarnOpportunities('defindex'),
      ]);

      const opportunities = results
        .filter((r): r is PromiseFulfilledResult<EarnOpportunity[]> => r.status === 'fulfilled')
        .flatMap((r) => r.value);

      const firstError = results.find((r) => r.status === 'rejected') as
        | PromiseRejectedResult
        | undefined;

      setEarn({
        opportunities,
        loading: false,
        error:
          opportunities.length === 0 && firstError
            ? String((firstError.reason as Error)?.message ?? firstError.reason)
            : null,
      });
    } catch (cause) {
      setEarn({ opportunities: [], loading: false, error: (cause as Error).message });
    }
  }, []);

  useEffect(() => {
    if (phase === 'authed') void loadEarn();
  }, [phase, loadEarn]);

  function begin() {
    setError(null);
    clientRef.current?.beginEmailLogin();
  }

  function sendCode() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      setError('Enter a valid email address.');
      return;
    }
    setError(null);
    setPhase('working');
    clientRef.current?.sendEmailCode(email.trim());
  }

  function verify() {
    if (!/^\d{4,8}$/.test(code)) {
      setError('The code is the digits Pollar emailed you.');
      return;
    }
    setError(null);
    setPhase('working');
    clientRef.current?.verifyEmailCode(code.trim());
  }

  async function signOut() {
    await clientRef.current?.logout();
    setWallet(null);
    setEarn({ opportunities: [], error: null, loading: false });
    setPhase('ready');
  }

  const busy = phase === 'working' || phase === 'loading';

  return (
    <Panel
      title="Pollar embedded wallet"
      subtitle="Signed in here, in your browser, with a DPoP-bound session. This is the only place these calls can be made."
      action={
        phase === 'authed' ? (
          <span className="badge badge-land">
            <span className="pulse-dot" aria-hidden />
            SESSION LIVE
          </span>
        ) : (
          <span className="badge badge-quiet">
            <span className="status-dot" aria-hidden />
            SIGNED OUT
          </span>
        )
      }
    >
      {/* ---- explanation ---- */}
      <p className="mb-5 text-sm leading-relaxed text-[var(--ink-muted)]">
        The corridor&apos;s server authenticates to Pollar as an{' '}
        <em>application</em>, which is enough to read this deployment&apos;s own
        configuration and nothing else. Earn, ramps and swap are scoped to a{' '}
        <em>person</em> and answer <code className="numeric text-[var(--ink-dim)]">401</code>{' '}
        to an application key, because their tokens are bound to a keypair that
        never leaves the user&apos;s browser. Sign in below and the same calls
        succeed.
      </p>

      {error && (
        <div className="mb-4 rounded-lg border border-[color-mix(in_srgb,var(--drought)_45%,transparent)] bg-[color-mix(in_srgb,var(--drought)_12%,transparent)] px-3.5 py-2.5 text-sm text-[var(--drought-bright)]">
          {error}
        </div>
      )}

      {/* ---- signed out ---- */}
      {(phase === 'ready' || phase === 'error') && (
        <Button variant="primary" onClick={begin} disabled={!publishableKey}>
          Connect a wallet
        </Button>
      )}

      {phase === 'loading' && (
        <div className="flex items-center gap-2 text-sm text-[var(--ink-dim)]">
          <Spinner /> Initialising Pollar…
        </div>
      )}

      {/* ---- email ---- */}
      {phase === 'email' && (
        <div className="space-y-3">
          <label className="block">
            <span className="panel-heading">Email</span>
            <input
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && sendCode()}
              type="email"
              autoComplete="email"
              placeholder="you@example.com"
              className="mt-1.5 w-full rounded-lg border border-[var(--edge-bright)] bg-[var(--panel-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--blue)]"
            />
          </label>
          <Button variant="primary" onClick={sendCode} disabled={busy}>
            Send code
          </Button>
        </div>
      )}

      {/* ---- code ---- */}
      {phase === 'code' && (
        <div className="space-y-3">
          <label className="block">
            <span className="panel-heading">Code sent to {email || 'your email'}</span>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              onKeyDown={(e) => e.key === 'Enter' && verify()}
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="000000"
              className="numeric mt-1.5 w-full rounded-lg border border-[var(--edge-bright)] bg-[var(--panel-sunken)] px-3 py-2.5 text-sm tracking-[0.3em] outline-none focus:border-[var(--blue)]"
            />
          </label>
          <Button variant="primary" onClick={verify} disabled={busy}>
            Verify
          </Button>
        </div>
      )}

      {phase === 'working' && (
        <div className="flex items-center gap-2 text-sm text-[var(--ink-dim)]">
          <Spinner /> {authState?.step.replace(/_/g, ' ') ?? 'Working'}…
        </div>
      )}

      {/* ---- authenticated ---- */}
      {phase === 'authed' && (
        <div className="space-y-5">
          <div className="panel-sunken px-4 py-3.5">
            <p className="panel-heading">Embedded Stellar wallet</p>
            <p className="numeric mt-1.5 break-all text-sm text-[var(--green-bright)]">
              {wallet ?? 'address unavailable'}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-[var(--ink-dim)]">
              Created by Pollar for this session. The farmer never installed a
              wallet, wrote down a seed phrase, or acquired XLM to pay a fee.
            </p>
          </div>

          <div>
            <div className="mb-2.5 flex items-center justify-between gap-3">
              <p className="panel-heading">Earn venues, read with this session</p>
              {earn.loading && <Spinner />}
            </div>

            {earn.error && (
              <p className="text-xs leading-relaxed text-[var(--amber-bright)]">
                {earn.error}
              </p>
            )}

            {!earn.loading && !earn.error && earn.opportunities.length === 0 && (
              <p className="text-xs text-[var(--ink-dim)]">
                No venues returned for this network.
              </p>
            )}

            <ul className="space-y-2">
              {earn.opportunities.map((o, i) => {
                const row = o as unknown as Record<string, unknown>;
                const name = String(row.name ?? row.id ?? `Venue ${i + 1}`);
                const apyRaw = Number(row.apy ?? 0);
                // Providers disagree about whether APY is a fraction or a
                // percentage. Anything at or below 1 is treated as a fraction,
                // which is the only reading that makes 0.0742 mean 7.42%.
                const apy = apyRaw <= 1 ? apyRaw * 100 : apyRaw;
                return (
                  <li key={`${name}-${i}`} className="panel-sunken px-3.5 py-2.5">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="text-sm font-medium text-[var(--ink)]">{name}</span>
                      <span className="numeric text-sm text-[var(--amber-bright)]">
                        {apy.toFixed(2)}% APY
                      </span>
                    </div>
                    {row.provider ? (
                      <p className="mt-0.5 text-[0.6875rem] uppercase tracking-[0.1em] text-[var(--ink-dim)]">
                        {String(row.provider)}
                      </p>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>

          <div className="flex gap-2 border-t border-[var(--edge)] pt-4">
            <Button onClick={loadEarn} disabled={earn.loading}>
              Refresh venues
            </Button>
            <Button variant="ghost" onClick={signOut}>
              Sign out
            </Button>
          </div>
        </div>
      )}
    </Panel>
  );
}
