'use client';

import { SupplierPortal } from '@/components/dashboard/SupplierPortal';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { Panel, StatusBadge } from '@/components/ui/primitives';
import { DESTINATION, RAILS, SUPPLIER } from '@/lib/corridor';
import { FX_RATES } from '@/lib/money';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The supplier route.
 *
 * ## Why Bolivia is the hard end of this corridor
 *
 * Getting money *into* Nigeria is a solved problem with several providers
 * competing. Getting it out into Bolivia is not: correspondent banking is thin,
 * card rails are unusable for B2B amounts, and the boliviano trades at two
 * prices — an official peg and a parallel market well above it.
 *
 * QR Simple is the lever. ASFI mandates it as the interoperable standard every
 * Bolivian bank app can read, which means a single EMVCo payload is the entire
 * artefact the exporter needs. No account opening, no correspondent, no wire.
 */
export default function SupplierPage() {
  const { state, error, reload, settled } = useCorridorState();

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={2} />;
  }

  const { escrow, identities } = state;
  const spreadPct = (FX_RATES.bobPerUsdParallel / FX_RATES.bobPerUsdOfficial - 1) * 100;

  return (
    <PageShell
      eyebrow={`${DESTINATION.city}, ${DESTINATION.region} · ${DESTINATION.country}`}
      title={
        <>
          Paying an exporter
          <br />
          <span className="text-[var(--blue-bright)]">without a wire</span>.
        </>
      }
      lede={`${SUPPLIER.name} manufactures ${SUPPLIER.product} in the Yungas valleys. They need bolivianos in a local account, not USDC in a wallet — and no correspondent bank wants a USD 1,800 agricultural invoice from Nigeria.`}
      aside={<StatusBadge status={escrow.status} />}
    >
      <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_1fr]">
        <SupplierPortal
          settlementStroops={
            settled ? (escrow.supplierPaidStroops ?? '0') : escrow.inputAllocationStroops
          }
          status={escrow.status}
        />

        <div className="space-y-6">
          <Panel
            title="Why QR Simple"
            subtitle={`${RAILS.egress.provider} egress over the ASFI interoperable standard.`}
          >
            <div className="space-y-4 text-sm leading-relaxed text-[var(--ink-muted)]">
              <p>
                Bolivia&apos;s financial regulator mandates a single QR format that every
                licensed bank app must be able to read. One payload therefore works at
                Banco Unión, BNB, Mercantil Santa Cruz or any other institution the
                supplier happens to bank with.
              </p>
              <p>
                The payload is EMVCo TLV with a CRC-16/CCITT-FALSE checksum. That checksum
                is not decoration: a single corrupted digit in an account number would
                otherwise route a payment to a stranger, and the bank app rejects the code
                outright rather than displaying a wrong beneficiary.
              </p>
            </div>

            <dl className="mt-5 space-y-2.5 border-t border-[var(--edge)] pt-4 text-xs">
              <Row term="Beneficiary" def={SUPPLIER.name} />
              <Row term="ASFI institution" def={SUPPLIER.bankCode} />
              <Row term="Account" def={SUPPLIER.bankAccount} />
              <Row term="Currency" def={`${DESTINATION.currency} (numeric 068)`} />
              <Row term="Standard" def="EMVCo TLV · CRC-16/CCITT-FALSE" />
            </dl>
          </Panel>

          <Panel
            title="Two rates, stated honestly"
            subtitle="Bolivia runs a pegged official rate alongside a parallel market. Pretending otherwise would misstate what the exporter receives."
          >
            <div className="grid gap-3 sm:grid-cols-2">
              <RateCard
                label="Official (pegged)"
                rate={FX_RATES.bobPerUsdOfficial}
                note="What the central bank publishes. Available in size only through formal channels."
              />
              <RateCard
                label="Parallel"
                rate={FX_RATES.bobPerUsdParallel}
                note={`Where the boliviano actually trades — roughly ${spreadPct.toFixed(0)}% wider.`}
                accent
              />
            </div>
            <p className="mt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
              The supplier chooses which rate the QR is cut at, and the choice is written
              into the audit trail alongside the payload. A corridor that silently applied
              one rate and displayed the other would be understating or overstating the
              settlement by {spreadPct.toFixed(0)}% on every transaction.
            </p>
          </Panel>
        </div>
      </div>

      <Panel title="Deferred funding">
        <div className="grid gap-6 lg:grid-cols-[1.1fr_1fr]">
          <div className="space-y-4 text-sm leading-relaxed text-[var(--ink-muted)]">
            <p>
              The supplier&apos;s Stellar account does not exist until it is needed. Creating
              and funding an account for a counterparty who may never receive a payment
              wastes the base reserve every time a corridor is set up and never used.
            </p>
            <p>
              Instead the address is derived deterministically now and the reserve is
              committed but not spent. When the first payment lands, the account is created
              inside the same transaction that funds it, sponsored by the gas wallet —
              so the exporter never needs to hold XLM to be paid in bolivianos.
            </p>
          </div>

          <dl className="space-y-2.5 text-xs">
            <Row term="Derived address" def={identities.supplierDeferred.publicKey} mono />
            <Row term="Status" def={identities.supplierDeferred.status} />
            <Row
              term="Committed reserve"
              def={`${identities.supplierDeferred.committedReserveXlm} XLM`}
            />
            <Row term="Derivation path" def={identities.supplierDeferred.derivationPath} mono />
            <Row
              term="Fee sponsor"
              def={identities.gasWallet.address ?? 'not configured'}
              mono
            />
          </dl>
        </div>
      </Panel>
    </PageShell>
  );
}

function RateCard({
  label,
  rate,
  note,
  accent = false,
}: {
  label: string;
  rate: number;
  note: string;
  accent?: boolean;
}) {
  return (
    <div className="panel-sunken px-4 py-3.5">
      <p className="panel-heading">{label}</p>
      <p
        className="numeric mt-1.5 text-xl font-semibold tracking-tight"
        style={{ color: accent ? 'var(--amber-bright)' : 'var(--ink)' }}
      >
        {rate.toFixed(2)}
        <span className="ml-1 text-xs font-normal text-[var(--ink-dim)]">BOB/USD</span>
      </p>
      <p className="mt-2 text-[0.6875rem] leading-tight text-[var(--ink-dim)]">{note}</p>
    </div>
  );
}

function Row({ term, def, mono = false }: { term: string; def: string; mono?: boolean }) {
  return (
    <div className="flex gap-3">
      <dt className="w-32 shrink-0 text-[var(--ink-dim)]">{term}</dt>
      <dd className={`min-w-0 break-all text-[var(--ink-muted)] ${mono ? 'numeric' : ''}`}>
        {def}
      </dd>
    </div>
  );
}
