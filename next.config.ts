import path from 'node:path';
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  /**
   * Pin the Turbopack root to this project.
   *
   * Next.js walks upward looking for a lockfile to infer the workspace root.
   * On a machine with a stray `package-lock.json` in the home directory it
   * picks that instead, then warns and resolves modules from the wrong tree.
   * Pinning it removes the ambiguity.
   */
  turbopack: {
    root: path.resolve(process.cwd()),
  },

  /**
   * `@stellar/stellar-sdk` and `@pollar/core` pull in Node built-ins and
   * large WASM/crypto surfaces. Keeping them external to the server bundle
   * lets them resolve at runtime rather than being traced and inlined, which
   * both speeds the build and avoids bundler-shimmed `crypto` semantics
   * diverging from Node's.
   */
  serverExternalPackages: ['@stellar/stellar-sdk', '@pollar/core'],
};

export default nextConfig;
