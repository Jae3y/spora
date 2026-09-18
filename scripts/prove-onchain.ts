/**
 * Execute one genuine on-chain deposit and print the transaction hash.
 *
 * ## Why this exists
 *
 * "Proof of real usage" cannot be a screenshot. This moves real testnet USDC
 * from the cooperative's account into the escrow contract by calling
 * `deposit_funds`, which performs an actual `token::transfer`, then prints the
 * resulting Stellar transaction hash alongside the contract's state before and
 * after.
 *
 * A reader can open that hash on stellar.expert and see the transfer, the
 * invocation and the state change without taking anything here on trust. That
 * is the difference between a demo and evidence.
 *
 * ## Why it does not import `lib/soroban/escrow`
 *
 * That module is marked `server-only`, which Next resolves through its own
 * bundler alias rather than through `node_modules`. Importing it from a plain
 * script fails with `Cannot find module 'server-only'`. Rather than weaken the
 * boundary that keeps signing keys out of client bundles, this script talks to
 * the SDK directly — the same choice `deploy.ts` makes, for the same reason.
 *
 * The amount defaults to the 20 USDC Circle's faucet dispenses, because that
 * is what is actually available:
 *
 *   npx tsx scripts/prove-onchain.ts
 *   npx tsx scripts/prove-onchain.ts 5
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Address,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_FILE = resolve(ROOT, '.env.local');

const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const server = new rpc.Server(RPC_URL);

function readEnv(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return map;
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

/** Truncate stroops to a 2-dp display string. */
function usdc(stroops: bigint): string {
  const whole = stroops / 10_000_000n;
  const cents = (stroops % 10_000_000n) / 100_000n;
  return `${whole.toLocaleString('en-US')}.${cents.toString().padStart(2, '0')}`;
}

/**
 * Read contract state without submitting anything.
 *
 * A simulation costs no fee and writes no ledger entry, which is what makes it
 * safe to call before *and* after the write in the same run.
 */
async function readEscrow(contractId: string, source: Keypair) {
  const account = await server.getAccount(source.publicKey());
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'get_escrow',
        args: [],
      }),
    )
    .setTimeout(30)
    .build();

  const sim = await server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`get_escrow failed: ${sim.error}`);
  }
  return scValToNative(sim.result!.retval) as Record<string, unknown>;
}

function printEscrow(e: Record<string, unknown>): void {
  const n = (k: string) => BigInt(String(e[k] ?? 0));
  console.log(`  status     ${String(e.status)}`);
  console.log(`  deposited  ${usdc(n('total_deposited'))} USDC`);
  console.log(`  inputs     ${usdc(n('input_allocation'))} USDC  ${dim('(90%)')}`);
  console.log(`  buffer     ${usdc(n('buffer_allocation'))} USDC  ${dim('(10%)')}`);
}

async function main(): Promise<void> {
  const requested = Number(process.argv[2] ?? '20');
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`Invalid amount: ${process.argv[2]}`);
  }
  const stroops = BigInt(Math.round(requested * 1e7));

  const env = readEnv();
  const contractId = env.get('NEXT_PUBLIC_SPORA_CONTRACT_ID');
  const cooperativeSecret = env.get('COOPERATIVE_SECRET');

  if (!contractId) throw new Error('No NEXT_PUBLIC_SPORA_CONTRACT_ID. Run `npm run deploy`.');
  if (!cooperativeSecret) throw new Error('No COOPERATIVE_SECRET in .env.local.');

  // `deposit_funds` calls `cooperative.require_auth()`, so the cooperative --
  // not the admin -- has to be the source and signer.
  const cooperative = Keypair.fromSecret(cooperativeSecret);

  console.log(bold('\nOn-chain deposit proof\n'));
  console.log(dim(`  contract     ${contractId}`));
  console.log(dim(`  cooperative  ${cooperative.publicKey()}`));
  console.log(dim(`  amount       ${requested} USDC (${stroops} stroops)\n`));

  console.log(bold('1. Escrow before'));
  const before = await readEscrow(contractId, cooperative);
  printEscrow(before);

  console.log(bold('\n2. Invoking deposit_funds'));
  const account = await server.getAccount(cooperative.publicKey());
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: contractId,
        function: 'deposit_funds',
        args: [nativeToScVal(stroops, { type: 'i128' })],
      }),
    )
    .setTimeout(60)
    .build();

  const sim = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Simulation failed: ${sim.error}`);
  }

  // Assembly is mandatory: simulation is what computes the footprint and
  // resource fee the final envelope must carry.
  const prepared = rpc.assembleTransaction(built, sim).build();
  prepared.sign(cooperative);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`Rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  let confirmed: rpc.Api.GetTransactionResponse | null = null;
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') {
      confirmed = result;
      break;
    }
    if (result.status === 'FAILED') {
      throw new Error(`Failed on chain: ${JSON.stringify(result.resultXdr)}`);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  if (!confirmed) throw new Error(`Not confirmed within 90s (hash ${sent.hash})`);

  const explorerUrl = `https://stellar.expert/explorer/testnet/tx/${sent.hash}`;
  console.log(`  ${green('✓')} ${sent.hash}`);
  console.log(dim(`     ${explorerUrl}`));

  console.log(bold('\n3. Escrow after'));
  const after = await readEscrow(contractId, cooperative);
  printEscrow(after);

  // The invariant the whole contract rests on, checked against chain state
  // rather than against our own arithmetic.
  const total = BigInt(String(after.total_deposited ?? 0));
  const parts =
    BigInt(String(after.input_allocation ?? 0)) +
    BigInt(String(after.buffer_allocation ?? 0));
  const delta = total - BigInt(String(before.total_deposited ?? 0));

  console.log();
  console.log(
    total === parts
      ? `  ${green('✓')} invariant holds on chain: A_input + A_buffer == A_total`
      : `  ${red('✗')} INVARIANT VIOLATED: ${parts} != ${total}`,
  );
  console.log(
    delta === stroops
      ? `  ${green('✓')} deposited delta ${usdc(delta)} USDC, exactly as requested`
      : `  ${red('✗')} delta ${usdc(delta)} != requested ${usdc(stroops)}`,
  );
  if (total !== parts || delta !== stroops) process.exitCode = 1;

  console.log(bold('\nProof:'));
  console.log(`  ${explorerUrl}\n`);
}

void xdr;
void Address;

main().catch((error: unknown) => {
  console.error(red(`\nFailed: ${(error as Error).message}\n`));
  process.exit(1);
});
