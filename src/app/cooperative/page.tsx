'use client';

import { PoolingMatrix } from '@/components/dashboard/PoolingMatrix';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { Panel, Stat } from '@/components/ui/primitives';
import { COOPERATIVE, MEMBERS, ORIGIN, POLICY, RAILS, TOTAL_PLEDGED_USD } from '@/lib/corridor';
import { FX_RATES } from '@/lib/money';
import { useCorridorState, usdc } from '@/lib/useCorridorState';

/**
 * The cooperative route.
 *
 * ## Why the roster is named
 *
 * Eight rows of "Member 1 … Member 8" would describe the same arithmetic and
 * prove nothing. A cooperative is people, and the credibility of an
 * agricultural product in Kano rests on whether its farmers read as real to
 * someone from Kano. The names follow Hausa-Fulani convention and the phone
 * prefixes are genuine Nigerian mobile ranges.
 *
 * ## Why hectares sit beside naira
 *
 * Pledge size is not arbitrary -- it tracks land under cultivation, which is
 * also what determines exposure to a failed rainy season. Showing both columns
 * makes the pool legible as risk-sharing rather than as a whip-round.
 */
export default function CooperativePage() {
  const { state, error, reload } = useCorridorState();

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={2} />;
  }

  const { escrow, pooling } = state;

  const totalHectares = MEMBERS.reduce((sum, m) => sum + m.hectares, 0);
  const pledgedNgn = TOTAL_PLEDGED_USD * FX_RATES.ngnPerUsd;

  return (
    <PageShell
      eyebrow={`${COOPERATIVE.lga} · ${ORIGIN.region}`}
      title={
        <>
          {COOPERATIVE.memberCount} farmers,{' '}
          <span className="text-[var(--green-bright)]">{COOPERATIVE.hectares} hectares</span>,
          <br />
          one escrow.
        </>
      }
      lede={`${COOPERATIVE.name} grows ${COOPERATIVE.crop} on rain-fed land in the Sudan savanna. No member can buy a container of biological inputs alone, and none can carry a failed season alone either. Pooling solves both at once.`}
    >
      {/* ---- why this cooperative, in three facts ---- */}
      <div className="mb-6 grid gap-4 md:grid-cols-3">
        <Fact
          figure={`${totalHectares} ha`}
          label="Under cultivation"
          body={`Across ${COOPERATIVE.memberCount} smallholdings averaging ${(totalHectares / MEMBERS.length).toFixed(1)} hectares. Nigeria has roughly 38 million people farming plots this size.`}
        />
        <Fact
          figure={POLICY.season}
          label="Single rainy season"
          body="Kano gets one. A three-week break inside it during tasselling is what destroys a maize crop — which is precisely the event this contract pays on."
        />
        <Fact
          figure={RAILS.ingress.ussdCode}
          label="How they pay in"
          body={`Dialled on a feature phone. ${RAILS.ingress.rail}, aggregated by ${RAILS.ingress.provider}. No smartphone, no bank branch, no app store.`}
        />
      </div>

      {/* ---- live pooling ---- */}
      <div className="mb-6">
        <PoolingMatrix
          members={pooling.members}
          pledgedUsdc={pooling.pledgedUsdc}
          settledUsdc={pooling.settledUsdc}
          progressBps={pooling.progressBps}
          inputAllocationUsdc={usdc(escrow.inputAllocationStroops)}
          bufferAllocationUsdc={usdc(escrow.bufferAllocationStroops)}
          onRefresh={reload}
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.35fr_1fr]">
        {/* ---- the roster ---- */}
        <Panel
          title="Founding members"
          subtitle="Pledges scale with land under cultivation, which is also what scales exposure to a failed season."
        >
          <div className="thin-scroll -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[30rem] border-collapse text-sm">
              <thead>
                <tr className="border-b border-[var(--edge)] text-left">
                  <Th>Member</Th>
                  <Th align="right">Hectares</Th>
                  <Th align="right">Pledge (₦)</Th>
                  <Th align="right">Pledge ($)</Th>
                </tr>
              </thead>
              <tbody>
                {MEMBERS.map((member) => (
                  <tr
                    key={member.id}
                    className="border-b border-[var(--edge)] last:border-b-0 transition-colors duration-[var(--dur-fast)] hover:bg-[var(--panel-raised)]"
                  >
                    <td className="py-2.5 pr-3">
                      <span className="block font-medium text-[var(--ink)]">
                        {member.name}
                      </span>
                      <span className="numeric mt-0.5 block text-[0.6875rem] text-[var(--ink-dim)]">
                        {member.id} · {member.phone}
                      </span>
                    </td>
                    <td className="numeric py-2.5 text-right text-[var(--ink-muted)]">
                      {member.hectares}
                    </td>
                    <td className="numeric py-2.5 text-right text-[var(--ink-muted)]">
                      {Math.round(member.usd * FX_RATES.ngnPerUsd).toLocaleString('en-US')}
                    </td>
                    <td className="numeric py-2.5 text-right text-[var(--ink)]">
                      {member.usd}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-[var(--edge-bright)]">
                  <td className="py-3 text-xs uppercase tracking-[0.1em] text-[var(--ink-dim)]">
                    Total pledged
                  </td>
                  <td className="numeric py-3 text-right text-[var(--ink-muted)]">
                    {totalHectares}
                  </td>
                  <td className="numeric py-3 text-right text-[var(--ink-muted)]">
                    {Math.round(pledgedNgn).toLocaleString('en-US')}
                  </td>
                  <td className="numeric py-3 text-right font-semibold text-[var(--green-bright)]">
                    {TOTAL_PLEDGED_USD.toLocaleString('en-US')}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
            The escrow funds to USD 2,000 against USD {TOTAL_PLEDGED_USD.toLocaleString('en-US')}{' '}
            of member pledges. The difference is the cooperative&apos;s own retained earnings
            going in alongside its members, which is how a Nigerian SACCO actually
            co-finances an input order.
          </p>
        </Panel>

        {/* ---- what a breach pays each side ---- */}
        <Panel
          title="What a failed season pays"
          subtitle="Fixed in the contract before a single naira is collected. Nobody negotiates after the rain has already failed."
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Stat
              label={`Relief to ${COOPERATIVE.shortName} (${POLICY.reliefCooperativeBps / 100}%)`}
              stroops={escrow.cooperativePaidStroops ?? '0'}
              unit="USDC"
              tone="crimson"
            />
            <Stat
              label={`Supplier indemnity (${POLICY.indemnitySupplierBps / 100}%)`}
              stroops={escrow.supplierPaidStroops ?? '0'}
              unit="USDC"
              tone="muted"
            />
          </div>

          <div className="mt-5 space-y-3 border-t border-[var(--edge)] pt-4 text-sm leading-relaxed text-[var(--ink-muted)]">
            <p>
              A 60/40 split rather than 100/0 is deliberate. The Bolivian exporter has
              already manufactured and shipped by the time a drought is confirmed — paying
              them nothing would mean no supplier signs the next season&apos;s contract, and
              the cooperative would have no corridor at all.
            </p>
            <p>
              There is no claim form, no adjuster and no loss assessment. The contract reads
              the rainfall and pays. That is what parametric means, and it is why relief
              lands in days rather than in the following planting season.
            </p>
          </div>

          <dl className="mt-5 space-y-2.5 border-t border-[var(--edge)] pt-4 text-xs">
            <Term
              term="Trigger"
              def={`Under ${POLICY.thresholdMm} mm cumulative rainfall across a rolling ${POLICY.rollingWindowDays}-day window`}
            />
            <Term
              term="Or"
              def={`${POLICY.dryDayTrigger} consecutive days below ${POLICY.dryDayRainfallCeilingMm} mm`}
            />
            <Term term="Measured by" def="ECMWF IFS, NOAA GFS and DWD ICON, by quorum" />
            <Term term="Settled on" def="Stellar Soroban, signed by the oracle key" />
          </dl>
        </Panel>
      </div>
    </PageShell>
  );
}

function Fact({ figure, label, body }: { figure: string; label: string; body: string }) {
  return (
    <div className="panel reveal">
      <div className="panel-core p-5">
        <p className="numeric text-2xl font-semibold tracking-tight text-[var(--ink)]">
          {figure}
        </p>
        <p className="panel-heading mt-1.5">{label}</p>
        <p className="mt-3 text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
      </div>
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' }) {
  return (
    <th
      scope="col"
      className={`pb-2 text-[0.6875rem] font-medium uppercase tracking-[0.1em] text-[var(--ink-dim)] ${
        align === 'right' ? 'text-right' : 'text-left'
      }`}
    >
      {children}
    </th>
  );
}

function Term({ term, def }: { term: string; def: string }) {
  return (
    <div className="flex gap-3">
      <dt className="w-24 shrink-0 text-[var(--ink-dim)]">{term}</dt>
      <dd className="text-[var(--ink-muted)]">{def}</dd>
    </div>
  );
}
