'use client';

import { useCallback, useEffect, useState } from 'react';
import { AddressChip, Button, Panel, Spinner, Stat } from '@/components/ui/primitives';

/**
 * Bolivian supplier portal.
 *
 * Shows shipment state, the deferred Pollar wallet the supplier will be paid
 * into, and a live ASFI QR Simple code for settling in Bolivianos.
 *
 * ## The deferred wallet is the interesting part
 *
 * The address shown here exists — it is derived, printable, and referenceable —
 * while costing the operator exactly **0 XLM**. The panel states that reserve
 * figure explicitly, because "we know your address but have not paid to create
 * it" is the whole economic argument for deferred funding and it is invisible
 * unless you say it out loud.
 *
 * ## QR rendering
 *
 * The `qrcode` library is imported dynamically. It is only needed once a
 * settlement amount exists, and it is large enough that eagerly bundling it
 * would slow the dashboard's first paint for a panel most visitors scroll past.
 */

interface QrResult {
  settlement: {
    usdc: string;
    bob: string;
    rateKind: 'official' | 'parallel';
    rate: number;
  };
  qr: {
    emvco: string;
    base64: string;
    invoiceId: string;
    payloadDigest: string;
    crc: string;
    crcVerified: boolean;
    envelope: { beneficiary: { bankName: string; account: string } };
  };
  recipient: {
    publicKey: string;
    status: string;
    committedReserveXlm: number;
    derivationPath: string;
  };
}

export function SupplierPortal({
  settlementStroops,
  status,
}: {
  settlementStroops: string;
  status: string;
}) {
  const [rateKind, setRateKind] = useState<'official' | 'parallel'>('official');
  const [result, setResult] = useState<QrResult | null>(null);
  /**
   * The rendered QR, tagged with the payload it was generated from.
   *
   * Tagging rather than clearing-then-regenerating is what removes the
   * synchronous `setQrImage(null)` that used to run in the effect body. A
   * stale image is simply not rendered, because its `for` no longer matches
   * the current payload — no extra render pass required, and no window in
   * which last settlement's QR is shown against this settlement's amount.
   */
  const [qrImage, setQrImage] = useState<{ src: string; for: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const amount = BigInt(settlementStroops || '0');

  const generate = useCallback(async () => {
    if (amount <= 0n) {
      setError('No settlement amount yet. Fund the escrow first.');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/pollar/bob-ramp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stroops: settlementStroops, rateKind }),
      });
      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json?.error?.message ?? 'QR generation failed');
      }
      setResult(json.data as QrResult);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, [amount, settlementStroops, rateKind]);

  // Render the QR only once a payload exists.
  const emvco = result?.qr.emvco;
  useEffect(() => {
    if (!emvco) return;
    let cancelled = false;
    import('qrcode')
      .then((QRCode) =>
        QRCode.toDataURL(emvco, {
          errorCorrectionLevel: 'M',
          margin: 1,
          width: 240,
          color: { dark: '#061a14', light: '#eef7f3' },
        }),
      )
      .then((url) => {
        if (!cancelled) setQrImage({ src: url, for: emvco });
      })
      .catch(() => {
        /* Leave the previous tag in place; the mismatch hides it. */
      });
    return () => {
      cancelled = true;
    };
  }, [emvco]);

  // Only show an image generated from the payload currently on screen.
  const qrSrc = qrImage && qrImage.for === emvco ? qrImage.src : null;

  const shipmentStage =
    status === 'InTransit'
      ? 'In transit across the Atlantic'
      : status === 'Completed'
        ? 'Delivered and settled'
        : status === 'ParametricTriggered'
          ? 'Recalled, parametric indemnity paid'
          : 'Awaiting dispatch from Caranavi';

  return (
    <Panel
      title="Bolivian supplier portal"
      subtitle="Caranavi Biofert SRL · biological input exporter"
      action={
        <span className={status === 'InTransit' ? 'badge badge-motion' : 'badge badge-quiet'}>
          {shipmentStage}
        </span>
      }
    >
      <div className="grid gap-4 lg:grid-cols-[1fr_auto]">
        <div className="space-y-4">
          {/* Deferred wallet */}
          <div className="panel-sunken p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <div className="panel-heading">Pollar deferred wallet</div>
                <div className="mt-1.5">
                  <AddressChip address={result?.recipient.publicKey ?? 'Not yet derived'} />
                </div>
              </div>
              <span className="badge badge-motion">
                {result?.recipient.status ?? 'deferred'}
              </span>
            </div>
            <div className="mt-3 grid grid-cols-2 gap-3">
              <Stat
                label="Reserve committed"
                value={`${result?.recipient.committedReserveXlm ?? 0}`}
                unit="XLM"
                size="sm"
                tone={
                  (result?.recipient.committedReserveXlm ?? 0) === 0 ? 'emerald' : 'amber'
                }
                hint="0 until disbursement"
              />
              <Stat
                label="Activation cost"
                value="1.0"
                unit="XLM"
                size="sm"
                tone="muted"
                hint="Base reserve + trustline, sponsored"
              />
            </div>
            <p className="mt-3 text-xs leading-relaxed text-[var(--ink-dim)]">
              The address is derived deterministically and can be invoiced against immediately.
              Base reserve and USDC trustline are sponsored atomically only at the moment of
              disbursement.
            </p>
          </div>

          {/* Rate selection */}
          <div className="panel-sunken p-4">
            <div className="panel-heading">Settlement rate</div>
            <div className="mt-2 flex gap-2">
              {(['official', 'parallel'] as const).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() => setRateKind(kind)}
                  className={`flex-1 rounded-lg border px-3 py-2 text-xs transition-colors ${
                    rateKind === kind
                      ? 'border-[var(--amber)] bg-[color-mix(in_srgb,var(--amber)_12%,transparent)] text-[var(--amber-bright)]'
                      : 'border-[var(--edge-bright)] text-[var(--ink-muted)] hover:text-[var(--ink)]'
                  }`}
                >
                  <div className="font-semibold capitalize">{kind}</div>
                  <div className="numeric mt-0.5 text-[0.6875rem] opacity-80">
                    {kind === 'official' ? '6.96' : '9.20'} BOB/USD
                  </div>
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-[var(--ink-dim)]">
              Bolivia maintains a hard peg alongside a weaker parallel market. The rate used is
              recorded on the settlement rather than assumed.
            </p>
          </div>

          <Button variant="primary" onClick={generate} disabled={loading || amount <= 0n}>
            {loading ? (
              <>
                <Spinner /> Generating…
              </>
            ) : (
              'Generate QR Simple payload'
            )}
          </Button>

          {error && <p className="text-sm text-[var(--drought-bright)]">{error}</p>}
        </div>

        {/* QR */}
        <div className="flex flex-col items-center justify-start gap-3 lg:w-72">
          <div className="panel-sunken flex aspect-square w-full max-w-[17rem] items-center justify-center p-4">
            {qrSrc ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={qrSrc}
                alt="Bolivian QR Simple payment code"
                className="fade-rise h-full w-full rounded-lg object-contain"
              />
            ) : (
              <div className="text-center text-xs leading-relaxed text-[var(--ink-dim)]">
                {loading ? <Spinner /> : 'QR Simple code appears once a settlement amount exists.'}
              </div>
            )}
          </div>

          {result && (
            <div className="w-full space-y-1.5 text-xs">
              <Row label="Amount" value={`${result.settlement.bob} BOB`} strong />
              <Row label="USDC" value={result.settlement.usdc} />
              <Row label="Bank" value={result.qr.envelope.beneficiary.bankName} />
              <Row label="Invoice" value={result.qr.invoiceId} />
              <Row
                label="CRC-16"
                value={`${result.qr.crc} ${result.qr.crcVerified ? 'verified' : 'INVALID'}`}
                strong={result.qr.crcVerified}
              />
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}

function Row({
  label,
  value,
  strong = false,
}: {
  label: string;
  value: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-[var(--ink-dim)]">{label}</span>
      <span
        className={`numeric truncate ${
          strong ? 'text-[var(--amber-bright)]' : 'text-[var(--ink-muted)]'
        }`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
