#!/usr/bin/env bash
#
# Build, optimize, deploy and initialize the Spora escrow contract on Stellar
# testnet, then write the resulting CONTRACT_ID into .env.local.
#
# Idempotent where it can be: identities that already exist are reused, and the
# .env.local rewrite replaces the CONTRACT_ID line rather than appending a
# second one.
#
# Usage:
#   ./scripts/deploy.sh                 # full build + deploy + init
#   ./scripts/deploy.sh --skip-build    # reuse the existing wasm
#   SPORA_THRESHOLD_MM=20 ./scripts/deploy.sh

set -euo pipefail

# ---------------------------------------------------------------- settings

NETWORK="${STELLAR_NETWORK:-testnet}"
RPC_URL="${STELLAR_RPC_URL:-https://soroban-testnet.stellar.org}"
PASSPHRASE="${STELLAR_NETWORK_PASSPHRASE:-Test SDF Network ; September 2015}"
THRESHOLD_MM="${SPORA_THRESHOLD_MM:-20}"

# Circle USDC SAC on Stellar testnet.
USDC_CONTRACT="${USDC_CONTRACT_ID:-CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$ROOT/.env.local"
WASM="$ROOT/target/wasm32-unknown-unknown/release/spora_escrow.wasm"
WASM_OPT="$ROOT/target/wasm32-unknown-unknown/release/spora_escrow.optimized.wasm"

SKIP_BUILD=0
[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

# ----------------------------------------------------------------- output

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
info()  { printf '  \033[2m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[32m✓\033[0m %s\n' "$*"; }
die()   { printf '  \033[31m✗\033[0m %s\n' "$*" >&2; exit 1; }

# ------------------------------------------------------------ preflight

bold "Spora escrow deployment → $NETWORK"

command -v stellar >/dev/null 2>&1 || die \
  "The 'stellar' CLI is not installed. Install it with:
     cargo install --locked stellar-cli
   or see https://developers.stellar.org/docs/tools/developer-tools/cli"

command -v cargo >/dev/null 2>&1 || die "cargo is not installed"

rustup target list --installed 2>/dev/null | grep -q wasm32-unknown-unknown || {
  info "Adding wasm32-unknown-unknown target"
  rustup target add wasm32-unknown-unknown
}

# --------------------------------------------------------- identities

# Each identity is created only if absent. `stellar keys address` exits
# non-zero for an unknown identity, which is what gates the generate.
ensure_identity() {
  local name="$1"
  if stellar keys address "$name" >/dev/null 2>&1; then
    info "identity '$name' already exists"
  else
    info "generating identity '$name' (funded via friendbot)"
    stellar keys generate "$name" --network "$NETWORK" --fund >/dev/null
  fi
  stellar keys address "$name"
}

bold "1. Identities"
ADMIN_ADDR="$(ensure_identity spora-admin)"
ORACLE_ADDR="$(ensure_identity spora-oracle)"
COOP_ADDR="$(ensure_identity spora-cooperative)"
SUPPLIER_ADDR="$(ensure_identity spora-supplier)"
GAS_ADDR="$(ensure_identity spora-gas-wallet)"

ok "admin       $ADMIN_ADDR"
ok "oracle      $ORACLE_ADDR"
ok "cooperative $COOP_ADDR"
ok "supplier    $SUPPLIER_ADDR"
ok "gas wallet  $GAS_ADDR"

# -------------------------------------------------------------- build

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  bold "2. Build"
  info "compiling contracts/spora_escrow to wasm32-unknown-unknown"
  (cd "$ROOT" && stellar contract build)
  [[ -f "$WASM" ]] || die "expected wasm at $WASM"
  ok "built $(basename "$WASM") ($(wc -c < "$WASM" | tr -d ' ') bytes)"

  bold "3. Optimize"
  # Optimization strips debug sections and runs wasm-opt. It materially reduces
  # the deployed footprint, and footprint is what the install fee is priced on.
  if stellar contract optimize --wasm "$WASM" >/dev/null 2>&1; then
    if [[ -f "$WASM_OPT" ]]; then
      ok "optimized → $(wc -c < "$WASM_OPT" | tr -d ' ') bytes"
      WASM="$WASM_OPT"
    fi
  else
    info "optimizer unavailable; deploying the unoptimized wasm"
  fi
else
  bold "2-3. Build/optimize skipped (--skip-build)"
  [[ -f "$WASM_OPT" ]] && WASM="$WASM_OPT"
  [[ -f "$WASM" ]] || die "no prebuilt wasm found; run without --skip-build"
fi

# ------------------------------------------------------------- deploy

bold "4. Deploy"
CONTRACT_ID="$(
  stellar contract deploy \
    --wasm "$WASM" \
    --source spora-admin \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$PASSPHRASE" 2>/dev/null | tail -n 1
)"

[[ -n "$CONTRACT_ID" ]] || die "deployment returned no contract id"
ok "contract $CONTRACT_ID"

# --------------------------------------------------------- initialize

bold "5. Initialize"

# The order hash binds the escrow to an off-chain purchase order. Deriving it
# from stable order facts (rather than a random nonce) means the same order
# always produces the same commitment, so it can be independently recomputed
# and verified by either counterparty.
ORDER_HASH="$(
  printf 'spora:order:NYERI-COOP-01:CARANAVI-BIOFERT:2026-Q1' \
    | openssl dgst -sha256 -hex 2>/dev/null \
    | awk '{print $NF}'
)"
[[ -n "$ORDER_HASH" ]] || die "could not derive the order hash (is openssl installed?)"
info "order hash $ORDER_HASH"

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source spora-admin \
  --network "$NETWORK" \
  --rpc-url "$RPC_URL" \
  --network-passphrase "$PASSPHRASE" \
  -- initialize \
  --admin "$ADMIN_ADDR" \
  --oracle "$ORACLE_ADDR" \
  --cooperative "$COOP_ADDR" \
  --supplier "$SUPPLIER_ADDR" \
  --usdc_token "$USDC_CONTRACT" \
  --threshold_mm "$THRESHOLD_MM" \
  --order_hash "$ORDER_HASH" >/dev/null

ok "initialized with a ${THRESHOLD_MM} mm parametric threshold"

# ------------------------------------------------------------- verify

bold "6. Verify"
VIEW="$(
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source spora-admin \
    --network "$NETWORK" \
    --rpc-url "$RPC_URL" \
    --network-passphrase "$PASSPHRASE" \
    -- get_escrow 2>/dev/null
)"
echo "$VIEW" | head -20
ok "contract responds to get_escrow"

# --------------------------------------------------------- write env

bold "7. Write .env.local"

# `stellar keys show` prints the secret seed. It is written to .env.local,
# which is gitignored — these are throwaway testnet identities, but the file
# should still never be committed.
ADMIN_SECRET="$(stellar keys show spora-admin 2>/dev/null || echo '')"
ORACLE_SECRET="$(stellar keys show spora-oracle 2>/dev/null || echo '')"
COOP_SECRET="$(stellar keys show spora-cooperative 2>/dev/null || echo '')"
GAS_SECRET="$(stellar keys show spora-gas-wallet 2>/dev/null || echo '')"

touch "$ENV_FILE"

# Replace-or-append, so re-running does not accumulate duplicate keys.
set_env() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "$ENV_FILE" 2>/dev/null; then
    # A portable in-place edit: BSD and GNU sed disagree about `-i`.
    sed "s|^${key}=.*|${key}=${value}|" "$ENV_FILE" > "$ENV_FILE.tmp"
    mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

set_env NEXT_PUBLIC_SPORA_CONTRACT_ID "$CONTRACT_ID"
set_env STELLAR_NETWORK "$NETWORK"
set_env STELLAR_RPC_URL "$RPC_URL"
set_env "STELLAR_NETWORK_PASSPHRASE" "$PASSPHRASE"
set_env USDC_CONTRACT_ID "$USDC_CONTRACT"
set_env STELLAR_ADMIN_SECRET "$ADMIN_SECRET"
set_env ORACLE_SECRET_KEY "$ORACLE_SECRET"
set_env COOPERATIVE_SECRET "$COOP_SECRET"
set_env POLLAR_GAS_WALLET_SECRET "$GAS_SECRET"

ok "wrote $ENV_FILE"

printf '\n'
bold "Deployed."
info "contract   $CONTRACT_ID"
info "explorer   https://stellar.expert/explorer/testnet/contract/$CONTRACT_ID"
info "next       npm run seed && npm run dev"
