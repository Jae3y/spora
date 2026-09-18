/**
 * Central runtime configuration and live/mock mode arbitration.
 *
 * Every external rail (Kotani Pay, Pollar, Stellar RPC, Open-Meteo) resolves
 * its credentials through this module rather than reading `process.env`
 * directly. That gives the whole system a single, auditable answer to "are we
 * talking to the real thing right now?", which the dashboard surfaces as a
 * per-rail badge and the API routes echo in every response envelope.
 *
 * The fail-safe contract: a missing credential degrades that *one* rail to its
 * mock engine. It never degrades the others, and it never throws at import
 * time -- a hackathon demo must boot on a laptop with an empty `.env.local`.
 */

export type RailMode = 'live' | 'mock';

import { ORIGIN, DESTINATION, POLICY } from './corridor';

/**
 * Geographic anchors, re-exported from the single corridor definition.
 *
 * These names are kept for the call sites that already use them, but the
 * values now come from `corridor.ts` so the country cannot drift between
 * modules the way it did when every file hardcoded its own coordinates.
 */
export const ORIGIN_COORDINATES = {
  latitude: ORIGIN.latitude,
  longitude: ORIGIN.longitude,
  label: `${ORIGIN.region}, ${ORIGIN.country}`,
  timezone: ORIGIN.timezone,
} as const;

export const DESTINATION_COORDINATES = {
  latitude: DESTINATION.latitude,
  longitude: DESTINATION.longitude,
  label: `${DESTINATION.city}, ${DESTINATION.region}, ${DESTINATION.country}`,
  timezone: DESTINATION.timezone,
} as const;

/** Legacy aliases. The oracle reads the African leg; the supplier the LatAm one. */
export const KANO_COORDINATES = ORIGIN_COORDINATES;
export const CARANAVI_COORDINATES = DESTINATION_COORDINATES;

/**
 * Parametric policy constants. These are mirrored byte-for-byte by the Soroban
 * contract (`DRY_DAY_TRIGGER`, `ThresholdMm`, `RELIEF_COOPERATIVE_BPS`). If you
 * change one, change both -- `would_trigger` on-chain exists precisely so the
 * UI can prove at runtime that they still agree.
 */
export const PARAMETRIC_POLICY = {
  thresholdMm: POLICY.thresholdMm,
  dryDayTrigger: POLICY.dryDayTrigger,
  dryDayRainfallCeilingMm: POLICY.dryDayRainfallCeilingMm,
  rollingWindowDays: POLICY.rollingWindowDays,
  reliefCooperativeBps: POLICY.reliefCooperativeBps,
  indemnitySupplierBps: POLICY.indemnitySupplierBps,
  inputAllocationBps: POLICY.inputAllocationBps,
  bufferAllocationBps: POLICY.bufferAllocationBps,
} as const;

function env(key: string): string | undefined {
  const raw = process.env[key];
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  // Treat the placeholder values shipped in `.env.example` as absent, so a
  // half-filled env file degrades to mock instead of firing doomed live calls.
  if (!trimmed || trimmed === 'mock' || trimmed.startsWith('your-') || trimmed.startsWith('<')) {
    return undefined;
  }
  return trimmed;
}

export const stellarConfig = {
  network: (env('STELLAR_NETWORK') ?? 'testnet') as 'testnet' | 'mainnet',
  horizonUrl: env('STELLAR_HORIZON_URL') ?? 'https://horizon-testnet.stellar.org',
  rpcUrl: env('STELLAR_RPC_URL') ?? 'https://soroban-testnet.stellar.org',
  networkPassphrase:
    env('STELLAR_NETWORK_PASSPHRASE') ?? 'Test SDF Network ; September 2015',
  contractId: env('NEXT_PUBLIC_SPORA_CONTRACT_ID'),
  /** Circle's canonical USDC SAC on Stellar testnet. */
  usdcContractId:
    env('USDC_CONTRACT_ID') ?? 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA',
  usdcIssuer: env('USDC_ISSUER') ?? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
  /**
   * Hash of the first deposit that genuinely executed on chain.
   *
   * Surfaced in the interface as evidence rather than left in a commit
   * message. A claim that money moved is worth exactly as much as the link
   * that lets a reader check it.
   */
  proofTxHash: env('NEXT_PUBLIC_PROOF_TX'),
  adminSecret: env('STELLAR_ADMIN_SECRET'),
  oracleSecret: env('ORACLE_SECRET_KEY'),
  gasWalletSecret: env('POLLAR_GAS_WALLET_SECRET'),
  cooperativeSecret: env('COOPERATIVE_SECRET'),
} as const;

export const pollarConfig = {
  /**
   * Secret (backend) key, `sec_testnet_…` / `sec_mainnet_…`.
   * Generated at dashboard.pollar.xyz → Build → API Keys.
   * `POLLAR_API_KEY` is accepted as a fallback for older .env files.
   */
  apiKey: env('POLLAR_SECRET_KEY') ?? env('POLLAR_API_KEY'),
  /** Publishable key, safe to expose. */
  publishableKey:
    env('NEXT_PUBLIC_POLLAR_PUBLISHABLE_KEY') ?? env('POLLAR_PUBLISHABLE_KEY'),
  /**
   * Origin presented to Pollar on server-side calls.
   *
   * Pollar enforces an allow-list per application and rejects a request with
   * no `Origin` at all -- a bare server fetch answers `ORIGIN_NOT_ALLOWED`
   * even with a valid key. The value here must match an origin registered on
   * the app in the Pollar dashboard character for character, including scheme
   * and port.
   */
  appOrigin: env('POLLAR_APP_ORIGIN') ?? 'http://localhost:3000',
  /**
   * SDK API host.
   *
   * Verified against `@pollar/core`'s own compiled default: the SDK builds its
   * base path as `${baseUrl}/v2` against `https://sdk.api.pollar.xyz`. The
   * marketing host `api.pollar.xyz` 404s on every route -- an easy and silent
   * mistake, because a wrong host and a wrong key both simply fail to work.
   */
  baseUrl: env('POLLAR_BASE_URL') ?? 'https://sdk.api.pollar.xyz',
  network: (env('POLLAR_NETWORK') ?? 'testnet') as 'testnet' | 'mainnet',
  /** Seed for deterministic deferred-recipient key derivation. */
  derivationSeed: env('POLLAR_DERIVATION_SEED'),
} as const;

export const kotaniConfig = {
  apiKey: env('KOTANI_API_KEY'),
  baseUrl: env('KOTANI_API_BASE') ?? 'https://sandbox-api.kotanipay.io/api/v3',
  webhookSecret: env('KOTANI_WEBHOOK_SECRET'),
  integratorId: env('KOTANI_INTEGRATOR_ID'),
} as const;

/**
 * Paystack. Self-serve: `sk_test_…` arrives on an email signup with no
 * business registration, which is why it is the first fallback when a
 * document-gated provider refuses us.
 *
 * There is deliberately no separate webhook secret -- Paystack signs callbacks
 * with the secret key itself.
 */
export const paystackConfig = {
  secretKey: env('PAYSTACK_SECRET_KEY'),
  publicKey: env('NEXT_PUBLIC_PAYSTACK_PUBLIC_KEY') ?? env('PAYSTACK_PUBLIC_KEY'),
} as const;

/**
 * Flutterwave. Also self-serve.
 *
 * `webhookHash` is a static shared secret echoed in a `verif-hash` header, not
 * a signature over the body -- see the provider module for why that matters
 * and what compensates for it.
 */
export const flutterwaveConfig = {
  secretKey: env('FLUTTERWAVE_SECRET_KEY'),
  publicKey: env('NEXT_PUBLIC_FLUTTERWAVE_PUBLIC_KEY') ?? env('FLUTTERWAVE_PUBLIC_KEY'),
  webhookHash: env('FLUTTERWAVE_WEBHOOK_HASH'),
} as const;

/**
 * Which ingress provider the corridor collects naira through.
 *
 * Explicit when `INGRESS_PROVIDER` is set; otherwise the first provider with
 * usable credentials wins, in descending order of how much of the rail is
 * genuinely exercised. Kotani is last not because it is worst -- it is the
 * only one that does NGN collection *and* stablecoin settlement in one hop --
 * but because it is the one we could not obtain credentials for, so falling
 * back to it means falling back to the mock.
 */
export type IngressProviderId = 'kotani' | 'paystack' | 'flutterwave';

export const ingressProviderId: IngressProviderId = (() => {
  const explicit = env('INGRESS_PROVIDER')?.toLowerCase();
  if (explicit === 'kotani' || explicit === 'paystack' || explicit === 'flutterwave') {
    return explicit;
  }
  if (paystackConfig.secretKey) return 'paystack';
  if (flutterwaveConfig.secretKey) return 'flutterwave';
  return 'kotani';
})();

export const appConfig = {
  /**
   * Public origin of this deployment.
   *
   * `VERCEL_PROJECT_PRODUCTION_URL` / `VERCEL_URL` are injected by the
   * platform and are the only values that are correct *before* the deployment
   * has a URL to configure. Without this fallback a production build inherits
   * `http://localhost:3000` from the developer's env, and every self-directed
   * callback quietly targets the deploying machine instead of the deployment.
   *
   * Neither Vercel variable carries a scheme, so one is added.
   */
  host:
    env('NEXT_PUBLIC_HOST') ??
    withScheme(env('VERCEL_PROJECT_PRODUCTION_URL')) ??
    withScheme(env('VERCEL_URL')) ??
    'http://localhost:3000',
  /**
   * When true, mock engines reproduce realistic network latency. Disabled in
   * tests so the suite does not spend wall-clock time simulating the transfer rail.
   */
  simulateLatency: env('SPORA_SIMULATE_LATENCY') !== 'false',
} as const;

/**
 * Gas sponsorship needs a funded XLM source account to wrap envelopes in a
 * fee bump. Without that secret there is nothing to sponsor *from*, so the
 * rail degrades even if Pollar itself is configured.
 */
export const gasSponsorMode: RailMode = stellarConfig.gasWalletSecret ? 'live' : 'mock';

/** Pollar needs an API key; everything else has a working default. */
export const pollarMode: RailMode = pollarConfig.apiKey ? 'live' : 'mock';

/**
 * Kotani needs both an API key (to dispatch STK pushes) and a webhook secret
 * (to verify the callbacks those pushes generate). One without the other is an
 * unusable half-configuration -- accepting unverifiable webhooks would be
 * strictly worse than running the mock, so both are required for `live`.
 */
export const kotaniMode: RailMode =
  kotaniConfig.apiKey && kotaniConfig.webhookSecret ? 'live' : 'mock';

/** The escrow can only be driven on-chain once it has been deployed. */
export const chainMode: RailMode =
  stellarConfig.contractId && stellarConfig.adminSecret ? 'live' : 'mock';

/** Open-Meteo is keyless, so the climate oracle is always live-capable. */
export const oracleMode: RailMode = 'live';

export interface RailStatus {
  rail: string;
  mode: RailMode;
  detail: string;
}

/**
 * Machine-readable posture of every external dependency. Rendered in the
 * dashboard header so a judge can see at a glance which rails are live without
 * reading server logs.
 */
export function railStatuses(): RailStatus[] {
  return [
    {
      rail: 'Kotani Pay (Nigeria ingress)',
      mode: kotaniMode,
      detail:
        kotaniMode === 'live'
          ? `Live against ${kotaniConfig.baseUrl}`
          : 'Sandbox NIBSS/USSD engine with HMAC-signed callbacks',
    },
    {
      rail: 'Pollar (wallets, Earn, BOB egress)',
      mode: pollarMode,
      detail:
        pollarMode === 'live'
          ? `Live against ${pollarConfig.baseUrl} (${pollarConfig.network})`
          : 'Mock Earn venues and offramp quotes with authentic payload shapes',
    },
    {
      rail: 'Gas wallet fee-bump sponsorship',
      mode: gasSponsorMode,
      detail:
        gasSponsorMode === 'live'
          ? 'Envelopes wrapped in signed FeeBumpTransactionEnvelope'
          : 'Fee bump constructed and signed with an ephemeral sponsor keypair',
    },
    {
      rail: 'Soroban escrow contract',
      mode: chainMode,
      detail: chainMode === 'live' ? `Contract ${stellarConfig.contractId}` : 'In-memory state machine mirroring contract semantics',
    },
    {
      rail: 'Open-Meteo climate oracle',
      mode: oracleMode,
      detail: `Archive + forecast precipitation for ${KANO_COORDINATES.label}`,
    },
  ];
}


/** Prefix a bare host with https, leaving a full URL untouched. */
function withScheme(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}
