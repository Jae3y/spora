'use client';

import { useState } from 'react';
import { ActionButton, Meter, Panel, Stat } from '@/components/ui/primitives';
import { TransferModal } from './TransferModal';

/**
 * Cooperative pooling matrix — the African side of the corridor.
 *
 * Eight founding members of the Kano cooperative, their individual pledges,
 * and live settlement state as Naira contributions land.
 *
 * ## The 90/10 split is shown on the total, never per member
 *
 * The contract re-derives the allocation from the *running total* on every
 * deposit, so a member's individual contribution has no meaningful 90/10
 * decomposition of its own. Showing one per row would be arithmetic theatre
 * that disagrees with the chain as soon as rounding bites.
 */

export interface Member {
  memberId: string;
  name: string;
  phoneNumber: string;
  pledgedNgn: number;
  pledgedStroops: string;
  settledNgn: number;
  settledStroops: string;
  status: 'pledged' | 'pending_pin' | 'settled' | 'failed';
  transferRef: string | null;
}

const STATUS_STYLE: Record<Member['status'], string> = {
  pledged: 'badge-quiet',
  pending_pin: 'badge-motion',
  settled: 'badge-land',
  failed: 'badge-breach',
};

const STATUS_LABEL: Record<Member['status'], string> = {
  pledged: 'Pledged',
  pending_pin: 'Awaiting PIN',
  settled: 'Settled',
  failed: 'Failed',
};

export function PoolingMatrix({
  members,
  pledgedUsdc,
  settledUsdc,
  progressBps,
  inputAllocationUsdc,
  bufferAllocationUsdc,
  onRefresh,
}: {
  members: Member[];
  pledgedUsdc: string;
  settledUsdc: string;
  progressBps: number;
  inputAllocationUsdc: string;
  bufferAllocationUsdc: string;
  onRefresh: () => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <Panel
        title="Cooperative pooling matrix"
        subtitle="Dawakin Kudu Farmers Cooperative · 8 founding members"
        action={
          <ActionButton onClick={() => setModalOpen(true)}>
            Contribute via bank transfer
          </ActionButton>
        }
      >
        <div className="grid gap-4 sm:grid-cols-3">
          <Stat label="Pledged" value={pledgedUsdc} unit="USDC" tone="muted" />
          <Stat label="Settled on chain" value={settledUsdc} unit="USDC" tone="emerald" />
          <Stat
            label="Climate buffer"
            value={bufferAllocationUsdc}
            unit="USDC"
            tone="amber"
            hint="10% held back for parametric relief"
          />
        </div>

        <div className="mt-4">
          <Meter value={progressBps} label="Pool funded" tone="amber" />
        </div>

        <div className="mt-3 flex items-center gap-4 text-xs text-[var(--ink-dim)]">
          <span>
            Inputs:{' '}
            <span className="numeric text-[var(--ink-muted)]">
              {inputAllocationUsdc} USDC
            </span>{' '}
            (90%)
          </span>
          <span>
            Buffer:{' '}
            <span className="numeric text-[var(--ink-muted)]">
              {bufferAllocationUsdc} USDC
            </span>{' '}
            (10%)
          </span>
        </div>

        <div className="thin-scroll mt-4 max-h-80 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-[var(--panel)]">
              <tr className="text-left">
                <th className="panel-heading pb-2 font-semibold">Member</th>
                <th className="panel-heading pb-2 text-right font-semibold">Pledged ₦</th>
                <th className="panel-heading pb-2 text-right font-semibold">Settled USDC</th>
                <th className="panel-heading pb-2 text-right font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {members.map((m) => (
                <tr
                  key={m.memberId}
                  className="border-t border-[var(--edge)] align-middle"
                >
                  <td className="py-2.5 pr-2">
                    <div className="font-medium text-[var(--ink)]">{m.name}</div>
                    <div className="numeric text-xs text-[var(--ink-dim)]">
                      {maskPhone(m.phoneNumber)}
                      {m.transferRef && (
                        <span className="ml-2 text-[var(--green)]">
                          {m.transferRef}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="numeric py-2.5 text-right text-[var(--ink-muted)]">
                    {m.pledgedNgn.toLocaleString('en-US')}
                  </td>
                  <td
                    className={`numeric py-2.5 text-right ${
                      BigInt(m.settledStroops) > 0n
                        ? 'text-[var(--green)]'
                        : 'text-[var(--ink-dim)]'
                    }`}
                  >
                    {usdc(m.settledStroops)}
                  </td>
                  <td className="py-2.5 text-right">
                    <span className={`badge ${STATUS_STYLE[m.status]}`}>
                      {STATUS_LABEL[m.status]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* Mounted only while open. A fresh mount is what resets the flow, so
          the component needs no reset effect and cannot retain a previous
          contributor's phone number or PIN. */}
      {modalOpen && (
        <TransferModal onClose={() => setModalOpen(false)} onSettled={onRefresh} />
      )}
    </>
  );
}

/** Never render a full mobile number in a shared demo surface. */
function maskPhone(phone: string): string {
  if (phone.length < 8) return phone;
  return `${phone.slice(0, 7)}•••${phone.slice(-2)}`;
}

/** Stroops to a 2-dp display string, truncating rather than rounding. */
function usdc(stroops: string): string {
  const v = BigInt(stroops || '0');
  const whole = v / 10_000_000n;
  const cents = (v % 10_000_000n) / 100_000n;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}
