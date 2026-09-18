import 'server-only';

import { ingressProviderId } from '@/lib/config';
import { FlutterwaveProvider } from './flutterwave';
import { KotaniProvider } from './kotani';
import { PaystackProvider } from './paystack';
import type { IngressProvider, ProviderHealth, ProviderId } from './types';

export * from './types';

/**
 * Provider registry.
 *
 * Instances are constructed once and hold no per-request state, so they are
 * safe to share across the whole server. Each one reads its own credentials
 * from config at call time rather than at construction, which means a key
 * added to the environment takes effect without a rebuild.
 */
const REGISTRY: Record<ProviderId, IngressProvider> = {
  kotani: new KotaniProvider(),
  paystack: new PaystackProvider(),
  flutterwave: new FlutterwaveProvider(),
};

/** The provider the corridor is currently collecting through. */
export function activeIngress(): IngressProvider {
  return REGISTRY[ingressProviderId];
}

/**
 * Resolve the provider that should handle a specific callback.
 *
 * Webhooks are not guaranteed to arrive from the *active* provider: switching
 * providers mid-season leaves in-flight callbacks from the previous one, and
 * refusing those would strand money that was genuinely collected. The header
 * shape identifies the sender, and only then does verification run.
 */
export function providerForCallback(headers: Headers): IngressProvider {
  if (headers.has('x-paystack-signature')) return REGISTRY.paystack;
  if (headers.has('verif-hash')) return REGISTRY.flutterwave;
  return REGISTRY.kotani;
}

export function providerById(id: ProviderId): IngressProvider {
  return REGISTRY[id];
}

/**
 * Health across every provider, probed concurrently.
 *
 * Sequential probes would make the dashboard wait for the slowest unconfigured
 * rail before rendering any of them. An unconfigured provider answers
 * immediately without a network call, so this is cheap.
 */
export async function allIngressHealth(): Promise<
  Array<{ id: ProviderId; displayName: string; active: boolean; health: ProviderHealth }>
> {
  const entries = Object.values(REGISTRY);
  const results = await Promise.all(entries.map((p) => p.health()));

  return entries.map((provider, index) => ({
    id: provider.id,
    displayName: provider.displayName,
    active: provider.id === ingressProviderId,
    health: results[index],
  }));
}
