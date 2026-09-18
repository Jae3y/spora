import 'server-only';

/**
 * Soroban client for the Spora escrow contract.
 *
 * ## The invocation pipeline
 *
 * A Soroban call is not a single request. Every state-changing invocation here
 * follows the full five-stage pipeline:
 *
 * ```text
 *   build  ->  simulate  ->  assemble  ->  sign  ->  fee-bump  ->  submit  ->  poll
 * ```
 *
 * `simulate` is not optional. It is what discovers the transaction's *footprint*
 * (the ledger entries it reads and writes) and its resource fee. A transaction
 * submitted without an assembled footprint is rejected outright, and one
 * assembled from a guessed footprint fails at apply time after paying fees.
 *
 * The fee bump wraps the assembled, signed envelope so the invoking user pays
 * no XLM -- see `pollar/gas-sponsor`.
 *
 * ## Reads never submit
 *
 * View functions (`get_escrow`, `get_balance`, `would_trigger`) are resolved
 * from the *simulation result* alone. Submitting them would burn fees and
 * consume a sequence number to learn something the simulation already returned.
 */

import {
  Account,
  Address,
  BASE_FEE,
  Contract,
  Keypair,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { chainMode, stellarConfig } from '@/lib/config';
import { wrapWithPollarGasSponsorship } from '@/lib/pollar/gas-sponsor';
import type { EscrowStatusName } from '@/lib/store/ledger';

/** Contract enum discriminants, in declaration order. */
const STATUS_NAMES: EscrowStatusName[] = [
  'Initialized',
  'Funded',
  'InTransit',
  'ParametricTriggered',
  'Completed',
  'Refunded',
];

export interface OnChainEscrowView {
  status: EscrowStatusName;
  totalDepositedStroops: string;
  inputAllocationStroops: string;
  bufferAllocationStroops: string;
  totalDisbursedStroops: string;
  thresholdMm: number;
  currentRainfallMm: number;
  consecutiveDryDays: number;
  oracleReportCount: number;
  lastOracleTimestamp: number;
  cooperative: string;
  supplier: string;
  usdcToken: string;
}

export interface InvocationReceipt {
  hash: string;
  ledger: number | null;
  /** Decoded contract return value, when the call produced one. */
  returnValue: unknown;
  feeBumpXdr: string;
  sponsorAddress: string;
  totalFeeStroops: string;
  explorerUrl: string;
}

export class SorobanError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'NOT_DEPLOYED'
      | 'SIMULATION_FAILED'
      | 'SUBMIT_FAILED'
      | 'TIMEOUT'
      | 'NO_SIGNER',
  ) {
    super(message);
    this.name = 'SorobanError';
  }
}

function server(): rpc.Server {
  return new rpc.Server(stellarConfig.rpcUrl, {
    allowHttp: stellarConfig.rpcUrl.startsWith('http://'),
  });
}

function contract(): Contract {
  if (!stellarConfig.contractId) {
    throw new SorobanError(
      'NEXT_PUBLIC_SPORA_CONTRACT_ID is unset. Run scripts/deploy.sh first.',
      'NOT_DEPLOYED',
    );
  }
  return new Contract(stellarConfig.contractId);
}

export function explorerUrl(hash: string): string {
  const net = stellarConfig.network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/tx/${hash}`;
}

export function contractExplorerUrl(): string | null {
  if (!stellarConfig.contractId) return null;
  const net = stellarConfig.network === 'mainnet' ? 'public' : 'testnet';
  return `https://stellar.expert/explorer/${net}/contract/${stellarConfig.contractId}`;
}

// ---------------------------------------------------------------------------
// reads
// ---------------------------------------------------------------------------

/**
 * Read a view function via simulation.
 *
 * The source account is irrelevant to a read, so a throwaway public key is
 * used rather than requiring a funded signer. The RPC does not check that the
 * simulated source exists.
 */
export async function simulateRead(method: string, args: xdr.ScVal[] = []): Promise<unknown> {
  const srv = server();
  const source = new Account(
    Keypair.random().publicKey(),
    // Sequence is unused by simulation; any value decodes.
    '0',
  );

  const tx = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(30)
    .build();

  const sim = await srv.simulateTransaction(tx);

  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanError(`Simulation of ${method} failed: ${sim.error}`, 'SIMULATION_FAILED');
  }
  if (!('result' in sim) || !sim.result) {
    throw new SorobanError(`Simulation of ${method} returned no result`, 'SIMULATION_FAILED');
  }
  return scValToNative(sim.result.retval);
}

/** Read the flattened escrow view from chain. */
export async function readEscrowOnChain(): Promise<OnChainEscrowView> {
  const raw = (await simulateRead('get_escrow')) as Record<string, unknown>;
  return normaliseView(raw);
}

export async function readContractBalance(): Promise<bigint> {
  const raw = await simulateRead('get_balance');
  return BigInt(String(raw));
}

export async function readWouldTrigger(
  rainfallMm: number,
  consecutiveDryDays: number,
): Promise<boolean> {
  const raw = await simulateRead('would_trigger', [
    nativeToScVal(rainfallMm, { type: 'u32' }),
    nativeToScVal(consecutiveDryDays, { type: 'u32' }),
  ]);
  return Boolean(raw);
}

/**
 * Map the contract's `EscrowView` into the dashboard's shape.
 *
 * `scValToNative` yields `bigint` for `i128` and a symbol-ish value for the
 * status enum; both are normalised here so nothing downstream has to know
 * about XDR representations.
 */
function normaliseView(raw: Record<string, unknown>): OnChainEscrowView {
  return {
    status: decodeStatus(raw.status),
    totalDepositedStroops: String(raw.total_deposited ?? 0),
    inputAllocationStroops: String(raw.input_allocation ?? 0),
    bufferAllocationStroops: String(raw.buffer_allocation ?? 0),
    totalDisbursedStroops: String(raw.total_disbursed ?? 0),
    thresholdMm: Number(raw.threshold_mm ?? 0),
    currentRainfallMm: Number(raw.current_rainfall_mm ?? 0),
    consecutiveDryDays: Number(raw.consecutive_dry_days ?? 0),
    oracleReportCount: Number(raw.oracle_report_count ?? 0),
    lastOracleTimestamp: Number(raw.last_oracle_timestamp ?? 0),
    cooperative: String(raw.cooperative ?? ''),
    supplier: String(raw.supplier ?? ''),
    usdcToken: String(raw.usdc_token ?? ''),
  };
}

/**
 * Decode the status enum.
 *
 * A `#[contracttype]` enum with explicit discriminants crosses the boundary as
 * a number, but some SDK/host combinations surface it as the variant name
 * instead. Both are accepted rather than assuming one and silently reporting
 * `Initialized` for every escrow if the representation changes.
 */
function decodeStatus(value: unknown): EscrowStatusName {
  if (typeof value === 'number' || typeof value === 'bigint') {
    return STATUS_NAMES[Number(value)] ?? 'Initialized';
  }
  if (typeof value === 'string') {
    const match = STATUS_NAMES.find((n) => n === value);
    if (match) return match;
  }
  return 'Initialized';
}

// ---------------------------------------------------------------------------
// writes
// ---------------------------------------------------------------------------

/**
 * Build, simulate, assemble, sign, fee-bump, submit and poll a contract call.
 *
 * `signerSecret` authorises the *invocation*; the gas wallet pays for it. The
 * two are deliberately different keys -- that separation is the whole point of
 * the sponsorship model.
 */
export async function invokeContract(
  method: string,
  args: xdr.ScVal[],
  signerSecret: string | undefined,
): Promise<InvocationReceipt> {
  if (!signerSecret) {
    throw new SorobanError(`No signing key configured for ${method}`, 'NO_SIGNER');
  }

  const srv = server();
  const signer = Keypair.fromSecret(signerSecret);
  const source = await srv.getAccount(signer.publicKey());

  const built = new TransactionBuilder(source, {
    fee: BASE_FEE,
    networkPassphrase: stellarConfig.networkPassphrase,
  })
    .addOperation(contract().call(method, ...args))
    .setTimeout(120)
    .build();

  const sim = await srv.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new SorobanError(
      `Simulation of ${method} failed: ${sim.error}`,
      'SIMULATION_FAILED',
    );
  }

  // `assembleTransaction` folds the discovered footprint, resource fee and
  // auth entries into the envelope. Skipping it produces a transaction the
  // network will reject for a missing footprint.
  const assembled = rpc.assembleTransaction(built, sim).build();
  assembled.sign(signer);

  const sponsorship = await wrapWithPollarGasSponsorship(assembled.toXDR());
  const feeBump = TransactionBuilder.fromXDR(
    sponsorship.feeBumpXdr,
    stellarConfig.networkPassphrase,
  );

  const sent = await srv.sendTransaction(feeBump as never);
  if (sent.status === 'ERROR' || sent.status === 'DUPLICATE') {
    throw new SorobanError(
      `Submission of ${method} rejected: ${sent.status} ${JSON.stringify(sent.errorResult ?? {})}`,
      'SUBMIT_FAILED',
    );
  }

  const settled = await pollForCompletion(srv, sent.hash);

  return {
    hash: sent.hash,
    ledger: 'ledger' in settled ? Number(settled.ledger) : null,
    returnValue:
      'returnValue' in settled && settled.returnValue
        ? scValToNative(settled.returnValue)
        : null,
    feeBumpXdr: sponsorship.feeBumpXdr,
    sponsorAddress: sponsorship.sponsorAddress,
    totalFeeStroops: sponsorship.totalFeeStroops,
    explorerUrl: explorerUrl(sent.hash),
  };
}

/**
 * Poll until the transaction leaves `NOT_FOUND`.
 *
 * Soroban RPC returns `NOT_FOUND` for a submitted-but-unclosed transaction,
 * which is indistinguishable from "never existed" without the submission
 * receipt we already hold. Bounded polling turns that into a definite answer
 * rather than an indefinite wait.
 */
async function pollForCompletion(
  srv: rpc.Server,
  hash: string,
  attempts = 30,
  intervalMs = 1_000,
): Promise<rpc.Api.GetTransactionResponse> {
  for (let i = 0; i < attempts; i += 1) {
    const result = await srv.getTransaction(hash);
    if (result.status === rpc.Api.GetTransactionStatus.SUCCESS) return result;
    if (result.status === rpc.Api.GetTransactionStatus.FAILED) {
      throw new SorobanError(
        `Transaction ${hash} failed on ledger: ${JSON.stringify(result.resultXdr ?? {})}`,
        'SUBMIT_FAILED',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new SorobanError(
    `Transaction ${hash} did not settle within ${(attempts * intervalMs) / 1000}s`,
    'TIMEOUT',
  );
}

// ---------------------------------------------------------------------------
// typed call wrappers
// ---------------------------------------------------------------------------

export async function depositFunds(amountStroops: bigint): Promise<InvocationReceipt> {
  return invokeContract(
    'deposit_funds',
    [nativeToScVal(amountStroops, { type: 'i128' })],
    stellarConfig.cooperativeSecret ?? stellarConfig.adminSecret,
  );
}

export async function setInTransit(): Promise<InvocationReceipt> {
  return invokeContract('set_in_transit', [], stellarConfig.adminSecret);
}

export async function reportWeather(args: {
  rainfallMm: number;
  consecutiveDryDays: number;
  observedAt: number;
}): Promise<InvocationReceipt> {
  return invokeContract(
    'report_weather',
    [
      nativeToScVal(args.rainfallMm, { type: 'u32' }),
      nativeToScVal(args.consecutiveDryDays, { type: 'u32' }),
      nativeToScVal(args.observedAt, { type: 'u64' }),
    ],
    stellarConfig.oracleSecret,
  );
}

export async function completeMilestone(): Promise<InvocationReceipt> {
  if (!stellarConfig.adminSecret) {
    throw new SorobanError('No admin key configured for complete_milestone', 'NO_SIGNER');
  }
  const admin = Keypair.fromSecret(stellarConfig.adminSecret);
  return invokeContract(
    'complete_milestone',
    [new Address(admin.publicKey()).toScVal()],
    stellarConfig.adminSecret,
  );
}

export async function sweepResidual(): Promise<InvocationReceipt> {
  return invokeContract('sweep_residual', [], stellarConfig.adminSecret);
}

/** Whether the chain path is usable at all. */
export function isChainLive(): boolean {
  return chainMode === 'live';
}
