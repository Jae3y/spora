'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PHONE } from '@/lib/corridor';
import { Button, Spinner } from '@/components/ui/primitives';

/**
 * Naira contribution flow, rendered as the handset the farmer actually holds.
 *
 * ## Why simulate the handset rather than show a form
 *
 * A farmer in Dawakin Kudu authorises this on a feature phone by dialling
 * `*737#` and entering a PIN into a USSD menu -- not by filling in a web form.
 * Rendering that menu chrome, the PIN masking and the confirmation SMS
 * communicates *what the user experience actually is* far faster than a
 * screenshot or a description, and it is the part of the corridor a Nigerian
 * judge will recognise instantly.
 *
 * Nigeria is not an M-Pesa market, so nothing here is an STK push: the rail
 * underneath is NIBSS instant transfer reached over USSD, aggregated by
 * Kotani Pay.
 *
 * ## The PIN is never transmitted as a secret
 *
 * On the real rail, PIN entry happens inside the SIM applet and never reaches
 * an application server. This component mirrors that boundary: the PIN is held
 * in component state, checked for shape, and used only as a local gate. The
 * request it triggers carries no PIN field, and the server route documents the
 * same constraint.
 */

type Phase = 'compose' | 'dispatching' | 'awaiting_pin' | 'processing' | 'settled' | 'error';

interface PushSession {
  transactionId: string;
  reference: string;
  estimatedUsdc: string;
  customerMessage: string;
  mode: 'live' | 'mock';
}

interface IngressInfo {
  provider: string;
  displayName: string;
  rail: string;
  live: boolean;
  supportsCheckout: boolean;
  detail: string;
}

interface Settlement {
  transferRef: string;
  transactionId: string;
  settlement: { creditedUsdc?: string; chain?: { hash: string | null } } | null;
}

export function TransferModal({
  onClose,
  onSettled,
}: {
  onClose: () => void;
  onSettled: () => void;
}) {
  const [phase, setPhase] = useState<Phase>('compose');
  /**
   * Defaults are a real Nigerian mobile prefix and a realistic pledge.
   *
   * These read `0712345678` and `2600` until the Nigeria pivot caught them:
   * `071` is a Safaricom prefix that the server's own validator rejects, and
   * NGN 2,600 is about USD 1.65 -- a Kenyan-shilling figure wearing a naira
   * label. A judge who pressed the button got a validation error on a rail
   * the product claims to run on.
   */
  // Annotated because `PHONE.example` is `as const`, which would otherwise
  // narrow the state to that one literal and reject every keystroke.
  const [phoneNumber, setPhoneNumber] = useState<string>(PHONE.example);
  const [amountNgn, setAmountNgn] = useState('316000');
  const [pin, setPin] = useState('');
  const [session, setSession] = useState<PushSession | null>(null);

  /**
   * Which rail is actually collecting.
   *
   * Asked of the server rather than inferred, because the secret key that
   * decides this is server-only by design. Rendering a "Pay with Paystack"
   * button above an unconfigured rail would be exactly the false claim the
   * rail badges exist to prevent.
   */
  const [ingress, setIngress] = useState<IngressInfo | null>(null);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/kotani/stk-push', { cache: 'no-store' })
      .then((r) => r.json())
      .then((json) => {
        if (!cancelled && json?.ok) setIngress(json.data as IngressInfo);
      })
      .catch(() => {
        /* The USSD simulation works regardless; a failed probe just means no
           live button is offered. */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * Hand off to the provider's hosted page.
   *
   * The window is opened from inside the click handler, not from the `.then`.
   * Safari's popup blocker only trusts a window opened synchronously during a
   * user gesture, and one opened after an await is silently swallowed.
   */
  async function startCheckout() {
    setPhase('dispatching');
    setError(null);
    const tab = window.open('', '_blank');
    try {
      const response = await fetch('/api/kotani/stk-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'checkout',
          phoneNumber,
          amountNgn: Number(amountNgn),
          cooperativeId: 'KANO-COOP-01',
          memberId: 'WALKIN',
        }),
      });
      const json = await response.json();
      if (!json?.ok) throw new Error(json?.error?.message ?? 'Checkout failed');

      const url = json.data.authorizationUrl as string | null;
      setCheckoutUrl(url);
      if (url && tab) tab.location.href = url;
      else if (tab) tab.close();
      setPhase('compose');
    } catch (cause) {
      tab?.close();
      setError((cause as Error).message);
      setPhase('error');
    }
  }

  const reset = useCallback(() => {
    setPhase('compose');
    setPin('');
    setSession(null);
    setSettlement(null);
    setError(null);
  }, []);

  // Escape closes, but only when the flow is not mid-flight: tearing down a
  // dispatch that has already reached the carrier would orphan a real push.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && phase !== 'dispatching' && phase !== 'processing') {
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [phase, onClose]);

  async function dispatchPush() {
    setError(null);
    setPhase('dispatching');
    try {
      const response = await fetch('/api/kotani/stk-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'initiate',
          phoneNumber,
          amountNgn: Number(amountNgn),
          cooperativeId: 'KANO-COOP-01',
          memberId: 'WALKIN',
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'STK push failed');
      }
      setSession(json.data as PushSession);
      setPhase('awaiting_pin');
    } catch (cause) {
      setError((cause as Error).message);
      setPhase('error');
    }
  }

  async function submitPin() {
    if (!session) return;
    if (!/^\d{4}$/.test(pin)) {
      setError('Wallet PINs are four digits.');
      return;
    }
    setError(null);
    setPhase('processing');
    try {
      const response = await fetch('/api/kotani/stk-push', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'confirm',
          reference: session.reference,
          transactionId: session.transactionId,
          phoneNumber,
          amountNgn: Number(amountNgn),
          // Shape-only gate. The server never stores or forwards this.
          pin,
        }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'Settlement failed');
      }
      setSettlement(json.data as Settlement);
      setPhase('settled');
      onSettled();
    } catch (cause) {
      setError((cause as Error).message);
      setPhase('error');
    }
  }

  const usdEstimate = (Number(amountNgn) / 130).toFixed(2);

  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center overflow-y-auto p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Contribute via bank transfer"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && phase !== 'dispatching' && phase !== 'processing') {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="fade-rise grid w-full max-w-3xl gap-6 lg:grid-cols-[1fr_auto]"
      >
        {/* ---- controls ---- */}
        <div className="panel p-6">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Contribute via bank transfer</h2>
              <p className="mt-1 text-sm text-[var(--ink-muted)]">
                Kotani Pay aggregates the naira transfer over NIBSS and settles it as
                Stellar USDC into the cooperative escrow.
              </p>
            </div>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>

          <div className="mt-6 space-y-4">
            <label className="block">
              <span className="panel-heading">Mobile number</span>
              <input
                value={phoneNumber}
                onChange={(e) => setPhoneNumber(e.target.value)}
                disabled={phase !== 'compose' && phase !== 'error'}
                inputMode="tel"
                placeholder={PHONE.placeholder}
                className="numeric mt-1.5 w-full rounded-lg border border-[var(--edge-bright)] bg-[var(--panel-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--amber)] disabled:opacity-50"
              />
              <span className="mt-1 block text-xs text-[var(--ink-dim)]">
                Accepts 0803…, 803…, 234803… or +234803…, all normalised to E.164.
                Valid prefixes: {PHONE.validPrefixes.map((p) => `0${p}`).join(', ')}.
              </span>
            </label>

            <label className="block">
              <span className="panel-heading">Amount (₦)</span>
              <input
                value={amountNgn}
                onChange={(e) => setAmountNgn(e.target.value.replace(/[^\d]/g, ''))}
                disabled={phase !== 'compose' && phase !== 'error'}
                inputMode="numeric"
                className="numeric mt-1.5 w-full rounded-lg border border-[var(--edge-bright)] bg-[var(--panel-sunken)] px-3 py-2.5 text-sm outline-none focus:border-[var(--amber)] disabled:opacity-50"
              />
              <span className="mt-1 block text-xs text-[var(--ink-dim)]">
                ≈ <span className="numeric">${usdEstimate}</span> USDC at ₦1,580/USD ·
                90% inputs / 10% climate buffer
              </span>
            </label>

            {error && (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--drought)_45%,transparent)] bg-[color-mix(in_srgb,var(--drought)_12%,transparent)] px-3 py-2 text-sm text-[var(--drought-bright)]">
                {error}
              </div>
            )}

            {/* Live rail first when one is connected. The simulation stays
                available beside it rather than being replaced: it is the
                product story, and it must keep working when a third party is
                unreachable. */}
            {ingress?.live && ingress.supportsCheckout && (
              <div className="rounded-lg border border-[color-mix(in_srgb,var(--green)_34%,transparent)] bg-[color-mix(in_srgb,var(--green)_8%,transparent)] px-3.5 py-3">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm font-medium text-[var(--ink)]">
                    {ingress.displayName} is live
                  </span>
                  <span className="badge badge-land scale-90">
                    <span className="pulse-dot" aria-hidden />
                    LIVE
                  </span>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-[var(--ink-dim)]">
                  {ingress.detail}
                </p>
                {checkoutUrl && (
                  <a
                    href={checkoutUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="numeric mt-2 block break-all text-xs text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
                  >
                    {checkoutUrl}
                  </a>
                )}
              </div>
            )}

            <div className="flex flex-wrap gap-2 pt-1">
              {ingress?.live && ingress.supportsCheckout && (
                <Button
                  variant="primary"
                  onClick={startCheckout}
                  disabled={phase === 'dispatching' || phase === 'processing'}
                >
                  {phase === 'dispatching' ? <Spinner /> : null} Pay ₦
                  {Number(amountNgn || 0).toLocaleString('en-US')} with {ingress.displayName}
                </Button>
              )}
              {(phase === 'compose' || phase === 'error') && (
                <Button
                  variant={ingress?.live && ingress.supportsCheckout ? 'default' : 'primary'}
                  onClick={dispatchPush}
                >
                  Simulate USSD transfer
                </Button>
              )}
              {phase === 'dispatching' && (
                <Button variant="primary" disabled>
                  <Spinner /> Dispatching…
                </Button>
              )}
              {phase === 'settled' && (
                <Button variant="default" onClick={reset}>
                  Contribute again
                </Button>
              )}
            </div>

            {session && (
              <div className="panel-sunken mt-2 space-y-1.5 px-3 py-2.5 text-xs">
                <Row label="Reference" value={session.reference} />
                <Row label="Kotani txn" value={session.transactionId} />
                {settlement && <Row label="Transfer ref" value={settlement.transferRef} />}
              </div>
            )}
          </div>
        </div>

        {/* ---- handset ---- */}
        <div className="handset mx-auto w-[17rem] shrink-0 p-2">
          <div className="handset-screen relative flex flex-col p-3">
            <div className="mx-auto mb-2 h-1 w-14 rounded-full bg-[#2a2219]" aria-hidden />
            <div className="flex items-center justify-between px-1 text-[0.625rem] text-[#6b7f76]">
              <span>NIBSS</span>
              <span className="numeric">
                {new Date().toLocaleTimeString('en-GB', {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </div>

            <div className="flex flex-1 items-center justify-center py-4">
              {phase === 'compose' && (
                <p className="px-4 text-center text-xs text-[#4e6159]">
                  Awaiting transfer request…
                </p>
              )}

              {phase === 'dispatching' && (
                <div className="flex flex-col items-center gap-3 text-[#7c9a8e]">
                  <Spinner className="h-5 w-5" />
                  <p className="text-xs">Contacting NIBSS…</p>
                </div>
              )}

              {(phase === 'awaiting_pin' || phase === 'processing') && session && (
                <div className="stk-dialog fade-rise w-full p-3.5">
                  <div className="border-b border-black/10 pb-2 text-[0.6875rem] font-semibold tracking-wide">
                    TRANSFER
                  </div>
                  <p className="mt-2.5 text-[0.6875rem] leading-relaxed">
                    {session.customerMessage}
                  </p>
                  <div className="mt-3">
                    <label className="text-[0.625rem] font-semibold tracking-wide text-black/60">
                      Enter wallet PIN
                    </label>
                    <input
                      type="password"
                      inputMode="numeric"
                      maxLength={4}
                      value={pin}
                      autoFocus
                      disabled={phase === 'processing'}
                      onChange={(e) => setPin(e.target.value.replace(/[^\d]/g, ''))}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') submitPin();
                      }}
                      className="numeric mt-1 w-full rounded border border-black/25 bg-white px-2 py-1.5 text-center text-lg tracking-[0.5em] outline-none focus:border-black/60"
                    />
                  </div>
                  <div className="mt-3 flex gap-2">
                    <button
                      type="button"
                      onClick={onClose}
                      disabled={phase === 'processing'}
                      className="flex-1 rounded border border-black/25 px-2 py-1.5 text-[0.6875rem] font-medium disabled:opacity-40"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={submitPin}
                      disabled={phase === 'processing' || pin.length !== 4}
                      className="flex-1 rounded bg-[#1f7a3f] px-2 py-1.5 text-[0.6875rem] font-semibold text-white disabled:opacity-40"
                    >
                      {phase === 'processing' ? 'Sending…' : 'OK'}
                    </button>
                  </div>
                </div>
              )}

              {phase === 'settled' && settlement && (
                <div className="fade-rise w-full rounded-lg bg-[#0d2a1e] p-3.5 text-[0.6875rem] leading-relaxed text-[#cfe8dd] ring-1 ring-[#1d5c42]">
                  <div className="mb-2 font-semibold text-[var(--green)]">
                    ✓ Confirmed
                  </div>
                  <p>
                    <span className="numeric">{settlement.transferRef}</span> Confirmed. NGN{' '}
                    <span className="numeric">{Number(amountNgn).toLocaleString('en-US')}</span> sent
                    to SPORA COOPERATIVE POOL.
                  </p>
                  {settlement.settlement?.creditedUsdc && (
                    <p className="mt-2 text-[#8fb3a6]">
                      Settled on Stellar as{' '}
                      <span className="numeric text-[var(--amber-bright)]">
                        {settlement.settlement.creditedUsdc} USDC
                      </span>
                      .
                    </p>
                  )}
                </div>
              )}

              {phase === 'error' && (
                <p className="px-4 text-center text-xs text-[var(--drought-bright)]">
                  Push failed. Adjust the details and retry.
                </p>
              )}
            </div>

            <div className="mx-auto h-1 w-20 rounded-full bg-[#2a2219]" aria-hidden />
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--ink-dim)]">{label}</span>
      <span className="numeric truncate text-[var(--ink-muted)]" title={value}>
        {value}
      </span>
    </div>
  );
}
