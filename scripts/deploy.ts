/**
 * Deploy and initialise the Spora escrow contract on Stellar testnet.
 *
 * ## Why this exists alongside `deploy.sh`
 *
 * `deploy.sh` drives the `stellar` CLI, which is a Rust binary that has to be
 * installed and kept in step with the network. This script does the same work
 * through `@stellar/stellar-sdk` -- already a dependency of the application --
 * so a machine that can run the app can always deploy the contract, with no
 * extra toolchain.
 *
 * ## What it does
 *
 *   1. Load or create an admin keypair, funding it from friendbot if new.
 *   2. Upload the compiled wasm, yielding a wasm hash.
 *   3. Create a contract instance from that hash.
 *   4. Invoke `initialize` with the corridor's roles and threshold.
 *   5. Write CONTRACT_ID and the identities back into `.env.local`.
 *
 * Every step is idempotent where it can be: an existing admin secret is
 * reused, an already-uploaded wasm returns the same hash, and the `.env.local`
 * rewrite replaces keys rather than appending duplicates.
 *
 *   npx tsx scripts/deploy.ts
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
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
  xdr,
} from '@stellar/stellar-sdk';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_FILE = resolve(ROOT, '.env.local');
const WASM_RAW = resolve(ROOT, 'target/wasm32-unknown-unknown/release/spora_escrow.wasm');
const WASM_OPT = resolve(
  ROOT,
  'target/wasm32-unknown-unknown/release/spora_escrow.optimized.wasm',
);

/**
 * Prefer the Binaryen-rewritten module.
 *
 * Rust 1.82+ ships a precompiled `core` for wasm32 that uses the
 * reference-types encoding of `call_indirect`, and Soroban's VM rejects it
 * outright -- `reference-types not enabled: zero byte expected`. No RUSTFLAG
 * fixes this, because the offending bytes are in a prebuilt rlib rather than
 * in anything this crate compiles.
 *
 * `wasm-opt --mvp-features` re-emits the whole module in baseline encoding.
 * Nothing here uses reference types semantically, so the rewrite is lossless
 * -- it only changes how `call_indirect` writes its table index.
 */
const WASM_PATH = existsSync(WASM_OPT) ? WASM_OPT : WASM_RAW;

const RPC_URL = process.env.STELLAR_RPC_URL ?? 'https://soroban-testnet.stellar.org';
const PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;
const FRIENDBOT = 'https://friendbot.stellar.org';
const THRESHOLD_MM = Number(process.env.SPORA_THRESHOLD_MM ?? 20);

/** Circle's USDC Stellar Asset Contract on testnet. */
const USDC_CONTRACT =
  process.env.USDC_CONTRACT_ID ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const server = new rpc.Server(RPC_URL, { allowHttp: RPC_URL.startsWith('http://') });

// ------------------------------------------------------------------ env io

function readEnv(): Map<string, string> {
  const map = new Map<string, string>();
  if (!existsSync(ENV_FILE)) return map;
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match) map.set(match[1], match[2]);
  }
  return map;
}

/**
 * Rewrite keys in place rather than appending.
 *
 * Appending would leave two `CONTRACT_ID=` lines, and dotenv resolves the
 * *last* one -- so a second deploy would appear to work while the app kept
 * reading a contract that no longer holds the escrow.
 */
function writeEnv(updates: Record<string, string>): void {
  const lines = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, 'utf8').split(/\r?\n/) : [];
  const pending = new Map(Object.entries(updates));

  const rewritten = lines.map((line) => {
    const match = /^([A-Z0-9_]+)=/.exec(line.trim());
    if (match && pending.has(match[1])) {
      const key = match[1];
      const value = pending.get(key)!;
      pending.delete(key);
      return `${key}=${value}`;
    }
    return line;
  });

  for (const [key, value] of pending) rewritten.push(`${key}=${value}`);
  writeFileSync(ENV_FILE, rewritten.join('\n').replace(/\n+$/, '\n'), 'utf8');
}

// -------------------------------------------------------------- accounts

async function fundIfNeeded(keypair: Keypair, label: string): Promise<void> {
  try {
    await server.getAccount(keypair.publicKey());
    console.log(`  ${green('✓')} ${label.padEnd(12)} ${dim(keypair.publicKey())} ${dim('(exists)')}`);
    return;
  } catch {
    /* not funded yet; fall through to friendbot */
  }

  const response = await fetch(`${FRIENDBOT}?addr=${keypair.publicKey()}`);
  if (!response.ok && response.status !== 400) {
    throw new Error(`Friendbot refused ${label}: HTTP ${response.status}`);
  }
  console.log(`  ${green('✓')} ${label.padEnd(12)} ${dim(keypair.publicKey())} ${dim('(funded)')}`);
}

/**
 * Simulate, assemble, sign, submit, poll.
 *
 * Soroban requires the full round trip: simulation computes the footprint and
 * resource fee that the final envelope must carry, so submitting an
 * unassembled transaction is always rejected.
 */
async function submit(
  source: Keypair,
  operation: xdr.Operation,
  label: string,
): Promise<rpc.Api.GetSuccessfulTransactionResponse> {
  const account = await server.getAccount(source.publicKey());
  const built = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(operation)
    .setTimeout(60)
    .build();

  const simulated = await server.simulateTransaction(built);
  if (rpc.Api.isSimulationError(simulated)) {
    throw new Error(`${label} simulation failed: ${simulated.error}`);
  }

  const prepared = rpc.assembleTransaction(built, simulated).build();
  prepared.sign(source);

  const sent = await server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new Error(`${label} rejected: ${JSON.stringify(sent.errorResult)}`);
  }

  // Poll rather than sleep: ledger close is ~5s but varies, and a fixed wait
  // either wastes time or reports a false failure.
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const result = await server.getTransaction(sent.hash);
    if (result.status === 'SUCCESS') return result;
    if (result.status === 'FAILED') {
      throw new Error(`${label} failed on-chain: ${JSON.stringify(result.resultXdr)}`);
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`${label} did not confirm within 60s (hash ${sent.hash})`);
}

// ----------------------------------------------------------------- main

async function main(): Promise<void> {
  console.log(bold('\nSpora contract deployment\n'));
  console.log(dim(`  rpc        ${RPC_URL}`));
  console.log(dim(`  network    ${PASSPHRASE}`));

  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `No wasm at ${WASM_PATH}.\n  Build it first:\n` +
        `    cargo +stable-x86_64-pc-windows-gnu build --target wasm32-unknown-unknown --release`,
    );
  }

  const wasm = readFileSync(WASM_PATH);
  console.log(dim(`  wasm       ${(wasm.length / 1024).toFixed(1)} KB\n`));

  const env = readEnv();

  // ---- 1. identities ----
  console.log(bold('1. Identities'));
  const admin = env.get('STELLAR_ADMIN_SECRET')
    ? Keypair.fromSecret(env.get('STELLAR_ADMIN_SECRET')!)
    : Keypair.random();
  const oracle = env.get('ORACLE_STELLAR_SECRET')
    ? Keypair.fromSecret(env.get('ORACLE_STELLAR_SECRET')!)
    : Keypair.random();
  const cooperative = env.get('COOPERATIVE_STELLAR_SECRET')
    ? Keypair.fromSecret(env.get('COOPERATIVE_STELLAR_SECRET')!)
    : Keypair.random();
  const supplier = env.get('SUPPLIER_STELLAR_SECRET')
    ? Keypair.fromSecret(env.get('SUPPLIER_STELLAR_SECRET')!)
    : Keypair.random();

  await fundIfNeeded(admin, 'admin');
  await fundIfNeeded(oracle, 'oracle');
  await fundIfNeeded(cooperative, 'cooperative');
  await fundIfNeeded(supplier, 'supplier');

  // ---- 2. upload ----
  console.log(bold('\n2. Upload wasm'));
  const uploadResult = await submit(
    admin,
    Operation.uploadContractWasm({ wasm }),
    'Wasm upload',
  );
  const wasmHash = uploadResult.returnValue!.bytes();
  const wasmHashHex = Buffer.from(wasmHash).toString('hex');
  console.log(`  ${green('✓')} wasm hash ${dim(wasmHashHex)}`);

  // ---- 3. instantiate ----
  console.log(bold('\n3. Create contract'));
  const createResult = await submit(
    admin,
    Operation.createCustomContract({
      wasmHash: Buffer.from(wasmHash),
      address: Address.fromString(admin.publicKey()),
      salt: Buffer.from(crypto.getRandomValues(new Uint8Array(32))),
    }),
    'Contract creation',
  );
  const contractId = Address.fromScAddress(
    createResult.returnValue!.address(),
  ).toString();
  console.log(`  ${green('✓')} contract  ${dim(contractId)}`);

  // ---- 4. initialize ----
  console.log(bold('\n4. Initialize'));
  const orderHash = Buffer.from(crypto.getRandomValues(new Uint8Array(32)));

  await submit(
    admin,
    Operation.invokeContractFunction({
      contract: contractId,
      function: 'initialize',
      args: [
        nativeToScVal(Address.fromString(admin.publicKey()), { type: 'address' }),
        nativeToScVal(Address.fromString(oracle.publicKey()), { type: 'address' }),
        nativeToScVal(Address.fromString(cooperative.publicKey()), { type: 'address' }),
        nativeToScVal(Address.fromString(supplier.publicKey()), { type: 'address' }),
        nativeToScVal(Address.fromString(USDC_CONTRACT), { type: 'address' }),
        nativeToScVal(THRESHOLD_MM, { type: 'u32' }),
        xdr.ScVal.scvBytes(orderHash),
      ],
    }),
    'Initialize',
  );
  console.log(`  ${green('✓')} threshold ${THRESHOLD_MM} mm`);

  // ---- 5. persist ----
  writeEnv({
    CONTRACT_ID: contractId,
    STELLAR_ADMIN_SECRET: admin.secret(),
    ORACLE_STELLAR_SECRET: oracle.secret(),
    COOPERATIVE_STELLAR_SECRET: cooperative.secret(),
    SUPPLIER_STELLAR_SECRET: supplier.secret(),
    STELLAR_WASM_HASH: wasmHashHex,
  });

  console.log(bold('\nDeployed.'));
  console.log(`  contract   ${contractId}`);
  console.log(
    dim(`  explorer   https://stellar.expert/explorer/testnet/contract/${contractId}\n`),
  );
}

main().catch((error: unknown) => {
  console.error(red(`\nDeployment failed: ${(error as Error).message}\n`));
  process.exit(1);
});
