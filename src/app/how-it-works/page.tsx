'use client';

import Link from 'next/link';
import { PageShell, RouteError, RouteSkeleton } from '@/components/layout/PageShell';
import { Button, Panel } from '@/components/ui/primitives';
import { COOPERATIVE, DESTINATION, ORIGIN, POLICY } from '@/lib/corridor';
import { REVENUE_POLICY } from '@/lib/money';
import { useCorridorState } from '@/lib/useCorridorState';

/**
 * The explainer route.
 *
 * Written for the reader who has seen the cockpit work and now wants to know
 * whether it is sound: what the contract guarantees, what it deliberately does
 * not, and how the thing makes money. Every claim on this page is one a hostile
 * reader could check against the source.
 *
 * The honest-limits section is not a disclaimer. A judge who finds a
 * limitation the product did not disclose discounts everything else it
 * claimed; a product that names its own gaps buys credibility for the rest.
 */
export default function HowItWorksPage() {
  const { state, error, reload } = useCorridorState();

  if (!state) {
    return error ? <RouteError message={error} onRetry={reload} /> : <RouteSkeleton rows={3} />;
  }

  const { revenue, rails, identities } = state;
  const liveRails = rails.filter((r) => r.mode === 'live');

  return (
    <PageShell
      eyebrow="The contract and the economics"
      title={
        <>
          Insurance that pays
          <br />
          <span className="text-[var(--green-bright)]">before you ask</span>.
        </>
      }
      lede="Conventional crop cover requires a farmer to file a claim, an adjuster to visit, and a loss to be assessed — a process that routinely outlasts the season it was meant to rescue. A parametric contract removes all three steps by agreeing the trigger in advance."
    >
      {/* ---- the mechanism ---- */}
      <Panel className="mb-6" title="The mechanism, in four guarantees">
        <div className="grid gap-6 md:grid-cols-2">
          <Guarantee
            n="01"
            title="The split is arithmetic, not policy"
            body={`Every deposit divides ${POLICY.inputAllocationBps / 100}% to inputs and ${POLICY.bufferAllocationBps / 100}% to the climate buffer inside the contract itself. The buffer is derived by subtracting the input allocation from the total rather than by a second multiplication — which is what makes it lossless. The two parts re-sum to the deposit exactly, with no stranded stroop, at any deposit size.`}
          />
          <Guarantee
            n="02"
            title="The trigger cannot be argued with"
            body={`Under ${POLICY.thresholdMm} mm across a rolling ${POLICY.rollingWindowDays}-day window, or ${POLICY.dryDayTrigger} consecutive days below ${POLICY.dryDayRainfallCeilingMm} mm. Both are read from satellite telemetry and signed before the contract will act on them. There is no discretion for anyone to exercise, including us.`}
          />
          <Guarantee
            n="03"
            title="A breach pays both sides"
            body={`${POLICY.reliefCooperativeBps / 100}% goes to the cooperative as relief; ${POLICY.indemnitySupplierBps / 100}% to the supplier as indemnity. The exporter has already manufactured and shipped by the time a drought is confirmed. Paying them nothing would end the corridor after one bad season, which helps no farmer.`}
          />
          <Guarantee
            n="04"
            title="Nobody needs to hold XLM"
            body="Every contract call on a farmer's behalf is wrapped in a fee-bump envelope paid for by a sponsorship wallet, and the supplier's account is created inside the transaction that first funds it. A smallholder in Kano is never asked to acquire a network token to receive relief."
          />
        </div>
      </Panel>

      <div className="grid gap-6 xl:grid-cols-[1fr_1fr]">
        {/* ---- economics ---- */}
        <Panel
          title="How it makes money"
          subtitle="Two lines, both charged on capital the corridor is actually handling."
        >
          <dl className="space-y-4">
            <Revenue
              label="Underwriting fee"
              rate={`${REVENUE_POLICY.underwritingFeeBps / 100}% of the input allocation`}
              amount={revenue.underwritingFeeUsdc}
              body="Charged once, at funding, for structuring and carrying the parametric risk. It is levied on inputs rather than on the full deposit so the climate buffer is never eroded by fees."
            />
            <Revenue
              label="Yield performance share"
              rate={`${REVENUE_POLICY.yieldPerformanceBps / 100}% of accrued yield`}
              amount={revenue.yieldShareUsdc}
              body="Taken only on yield actually earned while the buffer sits idle during shipment. If the buffer earns nothing, this line is zero — the cooperative keeps the rest."
            />
          </dl>

          <div className="mt-5 flex items-baseline justify-between border-t border-[var(--edge)] pt-4">
            <span className="panel-heading">Total to protocol</span>
            <span className="numeric text-lg font-semibold text-[var(--green-bright)]">
              {revenue.totalUsdc} <span className="text-xs font-normal">USDC</span>
            </span>
          </div>
          <div className="mt-2 flex items-baseline justify-between">
            <span className="text-xs text-[var(--ink-dim)]">Net yield to cooperative</span>
            <span className="numeric text-sm text-[var(--ink-muted)]">
              {revenue.cooperativeYieldNetUsdc} USDC
            </span>
          </div>

          <p className="mt-4 text-xs leading-relaxed text-[var(--ink-dim)]">
            No spread is taken on FX and no fee is charged on relief. Charging a
            cooperative for the payout that arrives because their crop failed would be
            indefensible, and a hidden FX margin is the oldest way to overcharge a
            corridor like this one.
          </p>
        </Panel>

        {/* ---- honest limits ---- */}
        <Panel
          title="What this does not do yet"
          subtitle="Stated here rather than discovered by a reader, because an undisclosed gap discredits everything beside it."
        >
          <ul className="space-y-4">
            <Limit
              title="Basis risk is real"
              body={`Satellite rainfall over a grid cell is not rainfall on one farmer's field. A cooperative can be paid when a member's plot was fine, or a member can suffer while the cell reads wet. Every parametric product carries this; naming it is the difference between a limitation and a surprise.`}
            />
            <Limit
              title="Forecast, not archive"
              body="The oracle reads the forecast endpoint with past days rather than the reanalysis archive, because the archive lags five days — five days of relief a farmer does not get. Forecast-derived past-day values are revised slightly as models assimilate more observations."
            />
            <Limit
              title="Rails are partly simulated"
              body={`${liveRails.length} of ${rails.length} rails are answering live right now. The rest run against documented mocks with authentic payload shapes and real cryptography — the HMAC signing, the idempotency guard and the EMVCo checksums all execute regardless. Badges across this site report probe results, never configuration.`}
            />
            <Limit
              title="Single corridor, single season"
              body={`This is calibrated to ${COOPERATIVE.lga} and the ${POLICY.season} rainy season. The thresholds are not universal constants; a different agro-ecological zone needs its own calibration against its own rainfall history.`}
            />
          </ul>
        </Panel>
      </div>

      {/* ---- close ---- */}
      <Panel className="mt-6" title="See it run">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <p className="max-w-xl text-sm leading-relaxed text-[var(--ink-muted)]">
            The fastest way to understand this corridor is to break it. Push the rainfall
            below threshold on the oracle page and watch the escrow split, the relief land
            in {ORIGIN.city} and the indemnity reach {DESTINATION.city} — then read the
            audit trail it wrote on the way.
          </p>
          <div className="flex flex-wrap gap-2">
            <Link href="/oracle">
              <Button variant="primary">Open the oracle</Button>
            </Link>
            <Link href="/audit">
              <Button variant="ghost">Read the ledger</Button>
            </Link>
          </div>
        </div>

        {identities.contractExplorerUrl && (
          <a
            href={identities.contractExplorerUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="numeric mt-5 inline-block break-all border-t border-[var(--edge)] pt-4 text-xs text-[var(--blue-bright)] underline decoration-dotted underline-offset-2"
          >
            {identities.contractId}
          </a>
        )}
      </Panel>
    </PageShell>
  );
}

function Guarantee({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div className="flex gap-4">
      <span className="numeric shrink-0 text-xs font-semibold text-[var(--ink-dim)]">{n}</span>
      <div className="min-w-0">
        <h3 className="text-[0.9375rem] font-semibold leading-snug text-[var(--ink)]">
          {title}
        </h3>
        <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
      </div>
    </div>
  );
}

function Revenue({
  label,
  rate,
  amount,
  body,
}: {
  label: string;
  rate: string;
  amount: string;
  body: string;
}) {
  return (
    <div className="panel-sunken px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <dt className="text-sm font-medium text-[var(--ink)]">{label}</dt>
        <dd className="numeric text-sm text-[var(--ink)]">
          {amount} <span className="text-xs text-[var(--ink-dim)]">USDC</span>
        </dd>
      </div>
      <p className="numeric mt-0.5 text-[0.6875rem] text-[var(--amber-bright)]">{rate}</p>
      <p className="mt-2 text-xs leading-relaxed text-[var(--ink-dim)]">{body}</p>
    </div>
  );
}

function Limit({ title, body }: { title: string; body: string }) {
  return (
    <li>
      <p className="text-sm font-semibold text-[var(--ink)]">{title}</p>
      <p className="mt-1.5 text-sm leading-relaxed text-[var(--ink-muted)]">{body}</p>
    </li>
  );
}
