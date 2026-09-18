import 'server-only';

/**
 * Process-local ledger: idempotency guard, audit event stream, and the mock
 * escrow state machine.
 *
 * ## Why `globalThis`
 *
 * Next.js hot-reloads route handlers by re-evaluating their module graph. A
 * plain module-level `Map` is therefore discarded on every edit, which would
 * silently reset the idempotency guard mid-demo and let a replayed webhook
 * through. Pinning the store to `globalThis` survives module re-evaluation,
 * which is the standard Next.js pattern for exactly this reason.
 *
 * ## Durability boundary
 *
 * This is deliberately in-memory. It is the right scope for a hackathon
 * deployment and for local development, and it is *explicitly* not a
 * production durability story: a process restart clears the idempotency set,
 * which in production would reopen the replay window. The interface is narrow
 * (`hasSeen`/`markSeen`/`append`) precisely so it can be swapped for Redis or
 * Postgres without touching a single call site.
 */

import { randomUUID } from 'node:crypto';
import { PARAMETRIC_POLICY } from '@/lib/config';
import { allocate, parametricSplit, FX_RATES } from '@/lib/money';
import { MEMBERS } from '@/lib/corridor';

export type EscrowStatusName =
  | 'Initialized'
  | 'Funded'
  | 'InTransit'
  | 'ParametricTriggered'
  | 'Completed'
  | 'Refunded';

export type AuditCategory =
  | 'ingress'
  | 'chain'
  | 'oracle'
  | 'yield'
  | 'egress'
  | 'sponsorship'
  | 'system';

export interface AuditEvent {
  id: string;
  at: string;
  category: AuditCategory;
  /** Short machine label, e.g. `deposit`, `parametric_trigger`. */
  event: string;
  summary: string;
  /** Stellar transaction hash, when the event touched the chain. */
  txHash: string | null;
  mode: 'live' | 'mock';
  detail: Record<string, unknown>;
}

/**
 * A cooperative member's position in the pool.
 *
 * Pledge and settlement are deliberately separate fields. A pledge is a
 * commitment; a settlement is money that actually arrived. Collapsing them
 * into one amount makes the two indistinguishable the instant a contribution
 * lands -- you can no longer answer "how much of what was promised has been
 * paid", which is the only question this panel exists to answer.
 */
export interface MemberContribution {
  memberId: string;
  name: string;
  phoneNumber: string;
  /** Commitment, in NGN. */
  pledgedNgn: number;
  /** Commitment, in USDC stroops. */
  pledgedStroops: string;
  /** Actually settled, in NGN. */
  settledNgn: number;
  /** Actually settled, in USDC stroops. */
  settledStroops: string;
  status: 'pledged' | 'pending_pin' | 'settled' | 'failed';
  transferRef: string | null;
  settledAt: string | null;
}

export interface MockEscrowState {
  status: EscrowStatusName;
  totalDepositedStroops: string;
  inputAllocationStroops: string;
  bufferAllocationStroops: string;
  totalDisbursedStroops: string;
  cooperativePaidStroops: string;
  supplierPaidStroops: string;
  thresholdMm: number;
  currentRainfallMm: number;
  consecutiveDryDays: number;
  oracleReportCount: number;
  lastOracleTimestamp: number;
  bufferDeployedStroops: string;
  accruedYieldStroops: string;
}

interface LedgerShape {
  seenWebhooks: Map<string, { at: string; result: string }>;
  events: AuditEvent[];
  members: MemberContribution[];
  escrow: MockEscrowState;
}

/**
 * Versioned global key.
 *
 * Pinning the store to `globalThis` is what makes it survive Next.js
 * hot-reloading a route handler -- but it survives *too* well: a store written
 * before a field rename is still there after the reload, and the new code then
 * reads `undefined` out of it and throws on the first `BigInt()`. Bumping this
 * suffix whenever `LedgerShape` changes makes a stale store simply invisible,
 * so the next read rebuilds it from seed instead of crashing.
 */
const GLOBAL_KEY = Symbol.for('spora.ledger.v3');

/**
 * The founding members of the Dawakin Kudu cooperative.
 *
 * Read from `corridor.ts` rather than duplicated here, so the roster, the
 * phone-number format and the country can never drift apart the way they did
 * when each module carried its own copy.
 */
function seedMembers(): MemberContribution[] {
  return MEMBERS.map(({ id, name, phone, usd }) => ({
    memberId: id,
    name,
    phoneNumber: phone,
    // Pledges are denominated in USD equivalent; the Naira figure is what the
    // member's wallet app will actually be asked to authorise.
    pledgedNgn: Math.round(usd * FX_RATES.ngnPerUsd),
    pledgedStroops: (BigInt(usd) * 10_000_000n).toString(),
    settledNgn: 0,
    settledStroops: '0',
    status: 'pledged' as const,
    transferRef: null,
    settledAt: null,
  }));
}

function freshEscrow(): MockEscrowState {
  return {
    status: 'Initialized',
    totalDepositedStroops: '0',
    inputAllocationStroops: '0',
    bufferAllocationStroops: '0',
    totalDisbursedStroops: '0',
    cooperativePaidStroops: '0',
    supplierPaidStroops: '0',
    thresholdMm: PARAMETRIC_POLICY.thresholdMm,
    currentRainfallMm: 0,
    consecutiveDryDays: 0,
    oracleReportCount: 0,
    lastOracleTimestamp: 0,
    bufferDeployedStroops: '0',
    accruedYieldStroops: '0',
  };
}

function store(): LedgerShape {
  const g = globalThis as unknown as Record<symbol, LedgerShape | undefined>;
  if (!g[GLOBAL_KEY]) {
    g[GLOBAL_KEY] = {
      seenWebhooks: new Map(),
      events: [],
      members: seedMembers(),
      escrow: freshEscrow(),
    };
  }
  return g[GLOBAL_KEY]!;
}

// ---------------------------------------------------------------------------
// idempotency
// ---------------------------------------------------------------------------

/**
 * Has this callback already been processed to completion?
 *
 * Keyed on the provider's transaction id, which is stable across retries of
 * the same settlement. Keying on a body hash instead would fail open: a
 * provider that retries with a refreshed `timestamp` produces a different hash
 * for the same economic event, and the deposit would be credited twice.
 */
export function hasSeenWebhook(transactionId: string): { seen: boolean; at?: string } {
  const record = store().seenWebhooks.get(transactionId);
  return record ? { seen: true, at: record.at } : { seen: false };
}

export function markWebhookSeen(transactionId: string, result: string): void {
  store().seenWebhooks.set(transactionId, { at: new Date().toISOString(), result });
}

// ---------------------------------------------------------------------------
// audit stream
// ---------------------------------------------------------------------------

/** Cap retained events so a long-running demo cannot grow unbounded. */
const MAX_EVENTS = 500;

export function appendAuditEvent(
  event: Omit<AuditEvent, 'id' | 'at'> & { at?: string },
): AuditEvent {
  const record: AuditEvent = {
    id: randomUUID(),
    at: event.at ?? new Date().toISOString(),
    category: event.category,
    event: event.event,
    summary: event.summary,
    txHash: event.txHash ?? null,
    mode: event.mode,
    detail: event.detail ?? {},
  };
  const s = store();
  s.events.unshift(record);
  if (s.events.length > MAX_EVENTS) s.events.length = MAX_EVENTS;
  return record;
}

/** Newest first. */
export function listAuditEvents(limit = 100): AuditEvent[] {
  return store().events.slice(0, limit);
}

// ---------------------------------------------------------------------------
// cooperative roster
// ---------------------------------------------------------------------------

export function listMembers(): MemberContribution[] {
  return store().members.map((m) => ({ ...m }));
}

export function updateMember(
  memberId: string,
  patch: Partial<MemberContribution>,
): MemberContribution | null {
  const s = store();
  const index = s.members.findIndex((m) => m.memberId === memberId);
  if (index === -1) return null;
  s.members[index] = { ...s.members[index], ...patch };
  return { ...s.members[index] };
}

/**
 * Mark a member as awaiting PIN entry after an STK push was dispatched.
 *
 * An existing roster member's *pledge* is left untouched -- they are in the
 * act of fulfilling it, not increasing it. Only an unrecognised number creates
 * a new walk-in row, whose pledge is the amount they are pushing.
 */
export function markMemberPending(args: {
  phoneNumber: string;
  amountNgn: number;
  stroops: string;
  name?: string;
}): MemberContribution {
  const s = store();
  const existing = s.members.find((m) => m.phoneNumber === args.phoneNumber);
  if (existing) {
    existing.status = 'pending_pin';
    return { ...existing };
  }

  const member: MemberContribution = {
    memberId: `NYR-W${String(s.members.length + 1).padStart(2, '0')}`,
    name: args.name?.trim() || `Walk-in ${args.phoneNumber.slice(-4)}`,
    phoneNumber: args.phoneNumber,
    pledgedNgn: args.amountNgn,
    pledgedStroops: args.stroops,
    settledNgn: 0,
    settledStroops: '0',
    status: 'pending_pin',
    transferRef: null,
    settledAt: null,
  };
  s.members.push(member);
  return { ...member };
}

/**
 * Record a settled contribution against the member who paid it.
 *
 * Keyed on **phone number**, which the Kotani callback carries natively.
 * The earlier design parsed the member id out of the reference string, which
 * cannot work: the reference is `SPORA-<coopId>-<memberId>-<nonce>` and both
 * ids contain hyphens, so splitting on `-` cannot recover the field
 * boundaries. The phone number needs no parsing and is the natural identity
 * of an bank transfer payer.
 *
 * Settlements accumulate, so a member contributing twice is credited twice
 * without their pledge moving.
 */
export function recordMemberSettlement(args: {
  phoneNumber: string;
  amountNgn: number;
  stroops: string;
  transferRef: string | null;
}): MemberContribution | null {
  const s = store();
  const member = s.members.find((m) => m.phoneNumber === args.phoneNumber);

  if (!member) {
    // Money from an unknown number is still real money. Record it as a
    // walk-in whose pledge equals what they actually paid, rather than
    // discarding a settlement because the roster did not anticipate it.
    const walkIn: MemberContribution = {
      memberId: `NYR-W${String(s.members.length + 1).padStart(2, '0')}`,
      name: `Walk-in ${args.phoneNumber.slice(-4)}`,
      phoneNumber: args.phoneNumber,
      pledgedNgn: args.amountNgn,
      pledgedStroops: args.stroops,
      settledNgn: args.amountNgn,
      settledStroops: args.stroops,
      status: 'settled',
      transferRef: args.transferRef,
      settledAt: new Date().toISOString(),
    };
    s.members.push(walkIn);
    return { ...walkIn };
  }

  member.settledNgn += args.amountNgn;
  member.settledStroops = (BigInt(member.settledStroops) + BigInt(args.stroops)).toString();
  member.status = 'settled';
  member.transferRef = args.transferRef;
  member.settledAt = new Date().toISOString();
  return { ...member };
}

/** Mark a member's contribution attempt as failed, leaving their pledge intact. */
export function markMemberFailed(phoneNumber: string): MemberContribution | null {
  const s = store();
  const member = s.members.find((m) => m.phoneNumber === phoneNumber);
  if (!member) return null;
  member.status = 'failed';
  return { ...member };
}

// ---------------------------------------------------------------------------
// mock escrow state machine
// ---------------------------------------------------------------------------

export function readEscrow(): MockEscrowState {
  return { ...store().escrow };
}

/**
 * Credit a settled deposit, re-deriving the 90/10 split from the new running
 * total using the same arithmetic as the contract, so the mock and the chain
 * report identical allocations for identical inputs.
 */
export function creditDeposit(stroops: bigint): MockEscrowState {
  const s = store();
  const total = BigInt(s.escrow.totalDepositedStroops) + stroops;
  const { inputAllocation, bufferAllocation } = allocate(total);

  s.escrow.totalDepositedStroops = total.toString();
  s.escrow.inputAllocationStroops = inputAllocation.toString();
  s.escrow.bufferAllocationStroops = bufferAllocation.toString();
  if (s.escrow.status === 'Initialized') s.escrow.status = 'Funded';
  return { ...s.escrow };
}

export function setEscrowStatus(status: EscrowStatusName): MockEscrowState {
  const s = store();
  s.escrow.status = status;
  return { ...s.escrow };
}

export function recordWeather(args: {
  rainfallMm: number;
  consecutiveDryDays: number;
  observedAt: number;
}): MockEscrowState {
  const s = store();
  s.escrow.currentRainfallMm = args.rainfallMm;
  s.escrow.consecutiveDryDays = args.consecutiveDryDays;
  s.escrow.lastOracleTimestamp = args.observedAt;
  s.escrow.oracleReportCount += 1;
  return { ...s.escrow };
}

/**
 * Apply the 60/40 parametric settlement to the mock state.
 *
 * The distributable pool is deposits plus any accrued yield, mirroring the
 * contract's decision to sweep the live balance rather than cap at
 * `total_deposited`.
 */
export function applyParametricSettlement(): MockEscrowState {
  const s = store();
  const pool = BigInt(s.escrow.totalDepositedStroops) + BigInt(s.escrow.accruedYieldStroops);
  const { cooperativeAmount, supplierAmount } = parametricSplit(pool);

  s.escrow.cooperativePaidStroops = cooperativeAmount.toString();
  s.escrow.supplierPaidStroops = supplierAmount.toString();
  s.escrow.totalDisbursedStroops = pool.toString();
  s.escrow.status = 'ParametricTriggered';
  return { ...s.escrow };
}

export function applyCompletion(): MockEscrowState {
  const s = store();
  const pool = BigInt(s.escrow.totalDepositedStroops) + BigInt(s.escrow.accruedYieldStroops);
  s.escrow.supplierPaidStroops = pool.toString();
  s.escrow.cooperativePaidStroops = '0';
  s.escrow.totalDisbursedStroops = pool.toString();
  s.escrow.status = 'Completed';
  return { ...s.escrow };
}

export function recordYieldDeployment(principal: bigint, accrued: bigint): MockEscrowState {
  const s = store();
  s.escrow.bufferDeployedStroops = principal.toString();
  s.escrow.accruedYieldStroops = accrued.toString();
  return { ...s.escrow };
}

/** Reset everything. Backs the dashboard's "reset demo" control. */
export function resetLedger(): void {
  const g = globalThis as unknown as Record<symbol, LedgerShape | undefined>;
  g[GLOBAL_KEY] = {
    seenWebhooks: new Map(),
    events: [],
    members: seedMembers(),
    escrow: freshEscrow(),
  };
}
