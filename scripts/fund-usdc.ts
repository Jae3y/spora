/**
 * Establish USDC trustlines and report holdings.
 *
 * ## Why this is a separate step
 *
 * `deposit_funds` performs a real `token::transfer` from the cooperative into
 * the contract. That requires two things the deploy cannot create on its own:
 * a trustline from the cooperative to Circle's testnet USDC issuer, and an
 * actual balance behind it.
 *
 * The trustline is ours to create and is done here. The balance is not --
 * testnet USDC is minted by Circle's faucet, not by us -- so this script
 * establishes what it can and reports precisely what is missing, rather than
 * failing with a generic error that leaves you guessing which half is wrong.
 *
 *   npx tsx scripts/fund-usdc.ts
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Asset,
  BASE_FEE,
  Horizon,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
} from '@stellar/stellar-sdk';

const ROOT = resolve(import.meta.dirname, '..');
const ENV_FILE = resolve(ROOT, '.env.local');

const HORIZON_URL = process.env.STELLAR_HORIZON_URL ?? 'https://horizon-testnet.stellar.org';
const PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE ?? Networks.TESTNET;

/** Circle's USDC issuer on Stellar testnet. */
const USDC_ISSUER =
  process.env.USDC_ISSUER ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const amber = (s: string) => `\x1b[33m${s}\x1b[0m`;

const horizon = new Horizon.Server(HORIZON_URL);
const USDC = new Asset('USDC', USDC_ISSUER);

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
 * Add a trustline, tolerating the case where one already exists.
 *
 * `changeTrust` against an existing line is not an error on Stellar -- it
 * simply updates the limit -- so this is safe to re-run.
 */
async function ensureTrustline(keypair: Keypair, label: string): Promise<string> {
  const account = await horizon.loadAccount(keypair.publicKey());

  const existing = account.balances.find(
    (b) =>
      'asset_code' in b && b.asset_code === 'USDC' && b.asset_issuer === USDC_ISSUER,
  );

  if (existing && 'balance' in existing) {
    console.log(
      `  ${green('✓')} ${label.padEnd(12)} trustline present, balance ${bold(existing.balance)} USDC`,
    );
    return existing.balance;
  }

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: PASSPHRASE,
  })
    .addOperation(Operation.changeTrust({ asset: USDC }))
    .setTimeout(60)
    .build();

  tx.sign(keypair);
  await horizon.submitTransaction(tx);
  console.log(`  ${green('✓')} ${label.padEnd(12)} trustline created, balance 0 USDC`);
  return '0';
}

async function main(): Promise<void> {
  console.log(bold('\nUSDC trustlines\n'));
  console.log(dim(`  horizon    ${HORIZON_URL}`));
  console.log(dim(`  issuer     ${USDC_ISSUER}\n`));

  const env = readEnv();
  const cooperativeSecret = env.get('COOPERATIVE_SECRET');
  const supplierSecret = env.get('SUPPLIER_SECRET');

  if (!cooperativeSecret || !supplierSecret) {
    throw new Error('Run `npm run deploy` first — no identities in .env.local.');
  }

  const cooperative = Keypair.fromSecret(cooperativeSecret);
  const supplier = Keypair.fromSecret(supplierSecret);

  const coopBalance = await ensureTrustline(cooperative, 'cooperative');
  await ensureTrustline(supplier, 'supplier');

  if (Number(coopBalance) > 0) {
    console.log(green(bold('\nReady. On-chain deposits will execute for real.\n')));
    return;
  }

  // The trustline is the part we control; the balance is not. Say exactly what
  // is missing and exactly where to get it.
  console.log(amber(bold('\nTrustlines ready, balance is 0.')));
  console.log(
    `\n  Testnet USDC is minted by Circle, not by this project. To fund the\n` +
      `  cooperative so on-chain deposits execute rather than being recorded\n` +
      `  for reconciliation:\n`,
  );
  console.log(`    1. Open ${bold('https://faucet.circle.com')}`);
  console.log(`    2. Choose ${bold('Stellar Testnet')}`);
  console.log(`    3. Paste ${bold(cooperative.publicKey())}`);
  console.log(`    4. Re-run this script to confirm\n`);
  console.log(
    dim(
      '  Until then the escrow still reads from the deployed contract; only the\n' +
        '  deposit write falls back to the mirror, and the audit trail records\n' +
        '  each one as a reconciliation item rather than reporting a false success.\n',
    ),
  );
}

main().catch((error: unknown) => {
  const message = (error as Error).message;
  console.error(`\n\x1b[31mFailed: ${message}\x1b[0m\n`);
  process.exit(1);
});
