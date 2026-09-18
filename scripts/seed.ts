/**
 * Demo seeder.
 *
 * Brings a freshly deployed corridor to the state a judge should find on first
 * load: eight cooperative members settled, USD 2,000 in escrow, the climate
 * buffer deployed into the highest-yielding venue, and the shipment in transit.
 *
 * Runs entirely against the running application's own HTTP API rather than
 * reaching into internals. That matters: it means the seeder exercises the same
 * webhook verification, idempotency guard and settlement path a real
 * contribution takes, so "the demo is seeded" and "the pipeline works" are the
 * same claim. A seeder that wrote directly to the store could leave the system
 * in a state the real path can never produce.
 *
 *   npm run seed
 *   SPORA_HOST=http://localhost:3000 npm run seed -- --skip-transit
 */

const HOST = process.env.SPORA_HOST ?? process.env.NEXT_PUBLIC_HOST ?? 'http://localhost:3000';
const SKIP_TRANSIT = process.argv.includes('--skip-transit');
const SKIP_YIELD = process.argv.includes('--skip-yield');

/**
 * The eight founding members and their pledges, totalling USD 1,800.
 *
 * These figures mirror the roster the ledger seeds, so every settlement lands
 * against an existing pledge rather than creating a walk-in row. Settling more
 * than pledged would push the pooling meter past 100%, which reads as a
 * reconciliation error even when the money is correct.
 */
const CONTRIBUTORS: Array<{ name: string; phone: string; usd: number }> = [
  { name: 'Amina Yusuf Dantata', phone: '08031004561', usd: 320 },
  { name: 'Ibrahim Sani Gwarzo', phone: '08062118834', usd: 280 },
  { name: 'Hauwa Abdullahi Kano', phone: '07039077121', usd: 240 },
  { name: 'Musa Garba Rano', phone: '09015562901', usd: 220 },
  { name: 'Zainab Lawal Bichi', phone: '08153380477', usd: 200 },
  { name: 'Sadiq Umar Gaya', phone: '08096641832', usd: 190 },
  { name: 'Fatima Bello Wudil', phone: '07064729154', usd: 180 },
  { name: 'Nasiru Aliyu Tofa', phone: '08188203567', usd: 170 },
];

/**
 * Cooperative treasury top-up bringing the escrow to the USD 2,000 the
 * deployment brief specifies.
 *
 * The brief gives two figures -- USD 1,800 of member pledges and a USD 2,000
 * funded escrow -- and both are real. The difference is the cooperative's own
 * retained earnings going in alongside its members, which is how a Nigerian
 * SACCO actually co-finances an input order.
 */
const TREASURY_TOPUP = { name: 'Cooperative treasury', phone: '08000000001', usd: 200 };

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

async function api<T = unknown>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; data: T; error?: { message: string } }> {
  const response = await fetch(`${HOST}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  });
  const json = (await response.json().catch(() => null)) as {
    ok?: boolean;
    data?: T;
    error?: { message: string };
  } | null;

  if (!json) throw new Error(`${path} returned a non-JSON response (HTTP ${response.status})`);
  return { ok: Boolean(json.ok), data: json.data as T, error: json.error };
}

async function assertReachable(): Promise<void> {
  try {
    const { ok } = await api('/api/escrow/state');
    if (!ok) throw new Error('state endpoint reported a failure');
  } catch (cause) {
    console.error(red(`\n  Cannot reach ${HOST}.`));
    console.error(dim('  Start the app first:  npm run dev\n'));
    throw cause;
  }
}

async function main(): Promise<void> {
  console.log(bold(`\nSpora demo seeder → ${HOST}\n`));
  await assertReachable();

  // Start from a known state. Seeding on top of an existing pool would produce
  // a total that depends on how many times the seeder has been run.
  console.log(bold('1. Reset'));
  await api('/api/escrow/state', {
    method: 'POST',
    body: JSON.stringify({ action: 'reset' }),
  });
  console.log(`  ${green('✓')} ledger cleared\n`);

  console.log(bold('2. Member contributions'));
  let settledUsd = 0;

  for (const c of [...CONTRIBUTORS, TREASURY_TOPUP]) {
    const amountNgn = Math.round(c.usd * 1580);

    const push = await api<{ reference: string; transactionId: string }>(
      '/api/kotani/stk-push',
      {
        method: 'POST',
        body: JSON.stringify({
          action: 'initiate',
          phoneNumber: c.phone,
          amountNgn,
          cooperativeId: 'KANO-COOP-01',
          memberId: 'SEED',
          memberName: c.name,
        }),
      },
    );

    if (!push.ok) {
      console.log(`  ${red('✗')} ${c.name.padEnd(18)} ${push.error?.message ?? 'push failed'}`);
      continue;
    }

    // The confirm step drives a genuinely signed callback through the public
    // webhook route, so every seeded contribution is verified exactly as a
    // live one would be.
    const confirm = await api<{ transferRef: string }>('/api/kotani/stk-push', {
      method: 'POST',
      body: JSON.stringify({
        action: 'confirm',
        reference: push.data.reference,
        transactionId: push.data.transactionId,
        phoneNumber: c.phone,
        amountNgn,
        pin: '1234',
      }),
    });

    if (!confirm.ok) {
      console.log(`  ${red('✗')} ${c.name.padEnd(18)} ${confirm.error?.message ?? 'settle failed'}`);
      continue;
    }

    settledUsd += c.usd;
    console.log(
      `  ${green('✓')} ${c.name.padEnd(18)} ${String(amountNgn).padStart(6)} NGN  ` +
        dim(`≈ $${c.usd}  ${confirm.data.transferRef}`),
    );
  }

  console.log(dim(`\n  pooled ≈ $${settledUsd.toLocaleString('en-US')} USDC\n`));

  if (!SKIP_TRANSIT) {
    console.log(bold('3. Dispatch shipment'));
    const transit = await api('/api/escrow/state', {
      method: 'POST',
      body: JSON.stringify({ action: 'set_in_transit' }),
    });
    console.log(
      transit.ok
        ? `  ${green('✓')} escrow → InTransit\n`
        : `  ${red('✗')} ${transit.error?.message}\n`,
    );
  }

  if (!SKIP_YIELD) {
    console.log(bold('4. Deploy climate buffer'));
    const deploy = await api<{
      deployment: { opportunity: { name: string; apy: number } };
      projectedYieldStroops: string;
    }>('/api/pollar/earn', {
      method: 'POST',
      body: JSON.stringify({ action: 'deploy' }),
    });

    if (deploy.ok) {
      const { name, apy } = deploy.data.deployment.opportunity;
      const projected = (Number(deploy.data.projectedYieldStroops) / 1e7).toFixed(2);
      console.log(`  ${green('✓')} ${name} @ ${(apy * 100).toFixed(2)}% APY`);
      console.log(dim(`     projected 28-day yield ≈ $${projected}\n`));
    } else {
      console.log(`  ${red('✗')} ${deploy.error?.message}\n`);
    }
  }

  // Final snapshot, read back through the same API the dashboard uses.
  const final = await api<{
    escrow: {
      status: string;
      totalDepositedStroops: string;
      inputAllocationStroops: string;
      bufferAllocationStroops: string;
    };
    pooling: { settledUsdc: string };
  }>('/api/escrow/state');

  const e = final.data.escrow;
  console.log(bold('Seeded.'));
  console.log(`  status     ${e.status}`);
  console.log(`  deposited  ${fmt(e.totalDepositedStroops)} USDC`);
  console.log(`  inputs     ${fmt(e.inputAllocationStroops)} USDC  ${dim('(90%)')}`);
  console.log(`  buffer     ${fmt(e.bufferAllocationStroops)} USDC  ${dim('(10%)')}`);

  // Prove the invariant held end to end rather than asserting it in prose.
  const total = BigInt(e.totalDepositedStroops);
  const parts = BigInt(e.inputAllocationStroops) + BigInt(e.bufferAllocationStroops);
  if (total === parts) {
    console.log(`\n  ${green('✓')} invariant: A_input + A_buffer == A_total exactly`);
  } else {
    console.log(`\n  ${red('✗')} INVARIANT VIOLATED: ${parts} != ${total}`);
    process.exitCode = 1;
  }

  console.log(dim(`\n  open ${HOST}\n`));
}

function fmt(stroops: string): string {
  const v = BigInt(stroops || '0');
  return `${(v / 10_000_000n).toLocaleString('en-US')}.${((v % 10_000_000n) / 100_000n)
    .toString()
    .padStart(2, '0')}`;
}

main().catch((error: unknown) => {
  console.error(red(`\nSeeding failed: ${(error as Error).message}\n`));
  process.exit(1);
});
