# Spora

**Cross-continental parametric climate escrow.** The Dawakin Kudu Farmers
Cooperative — eight smallholders farming 46 hectares of rain-fed maize and
sorghum in **Kano State, Nigeria** — finances biological soil inputs from an
exporter in **Caranavi, Bolivia**, with an automated drought circuit breaker
governed by satellite precipitation telemetry.

Stellar Soroban · Pollar SDK v0.11.3 · Paystack · Open-Meteo

**Live:** <https://spora-jackson-abetianbes-projects.vercel.app>
**Contract:** [`CB3L4HIOKM5A...O7MK`](https://stellar.expert/explorer/testnet/contract/CB3L4HIOKM5A6YGYAD4JSRHZYCPLWNJ26DN4YBBINBIGSDLXT4JDO7MK) on Stellar testnet

---

## What it does

Naira is collected over NIBSS instant transfer — the rail behind every
Nigerian bank app and USSD code — aggregated into native Stellar USDC, and held
in a Soroban escrow. Ninety percent buys inputs; ten
percent is held back as a climate buffer that earns yield in a Blend pool or
DeFindex vault while the shipment crosses the Atlantic. The supplier is paid in
Bolivianos against an ASFI-conformant QR Simple code.

If the rains fail, nobody has to file a claim. A signed satellite reading
showing **under 20 mm of rain over 21 days *and* 21+ consecutive dry days**
fires the contract's circuit breaker, which splits the escrow **60% emergency
cash relief to the Kano cooperative / 40% input indemnity to the Bolivian
supplier** — atomically, in the same transaction that accepts the reading.

```
 NGN bank transfer →  Stellar USDC Escrow  →  Pollar Float Vault  →  BOB QR Bancario
   Paystack / NIBSS     Soroban contract        Blend / DeFindex        ASFI QR Simple
```

---

## What is live right now

Every badge in the interface is a **probe result**, not a check for whether an
API key string exists. A rail marked `mock` is genuinely not connected, and a
rail marked `live` answered an authenticated request within the last minute.

| Rail | Status | What "live" means here |
|---|---|---|
| Paystack — naira ingress | **live** | Real `api.paystack.co` calls creating real checkout URLs. Test mode: the API and its webhooks are genuine, the money is not. |
| Pollar — wallets, Earn, BOB egress | **live** | Authenticated as application `Spora` on `testnet`, chain `STELLAR`. |
| Soroban escrow contract | **live** | Deployed and initialized on Stellar testnet. Balances on every page are read from chain. |
| Gas-wallet fee-bump sponsorship | **live** | Envelopes signed as real `FeeBumpTransactionEnvelope`s. |
| Open-Meteo climate oracle | **live** | ECMWF IFS, NOAA GFS and DWD ICON, read per request. |

**What is still simulated, stated plainly:** the escrow's full USD 2,000 demo
balance runs against the process-local mirror, because Circle's testnet faucet
dispenses 20 USDC every two hours and `deposit_funds` performs a real
`token::transfer`. Contract *reads* are live on every page; the large demo
*writes* are mirrored. The audit trail records each one as a reconciliation
item rather than reporting a success that did not happen.

Kotani Pay remains implemented and selectable — it is the only provider that
does NGN collection *and* stablecoin settlement in one hop — but we could not
obtain credentials before the deadline, so Paystack collects instead. Swapping
back is one environment variable: `INGRESS_PROVIDER=kotani`.

---

## Quick start

Nothing is required to run the demo. Every external rail degrades to a
high-fidelity mock with realistic latency, authentic payload shapes and
genuinely valid signatures.

```bash
npm install
npm run dev
npm run seed     # in a second terminal
```

Open <http://localhost:3000>. Drag the **Simulate Climate Volatility** slider
past 21 dry days with rainfall under 20 mm to fire the circuit breaker.

### Deploying the contract

The host toolchain must be `gnu`, and the wasm must be rewritten to baseline
encoding before Soroban will accept it — see *Two build notes* below for why.

```bash
npm run deploy      # build + wasm-opt + deploy + initialize
npm run fund:usdc   # USDC trustlines for the cooperative and supplier
```

To run against live rails, copy `.env.example` to `.env.local` and fill in what
you have. Each rail is independent — a missing Kotani key does not disable
Pollar, and the dashboard shows a live/mock badge per rail.

### Contract tests

```bash
npm run contract:test          # 26 unit tests
```

`deploy.sh` generates and funds five testnet identities, deploys, initializes
with a 20 mm threshold, verifies `get_escrow` responds, and writes
`NEXT_PUBLIC_SPORA_CONTRACT_ID` into `.env.local`. It is idempotent.

---

## Architecture

### On chain — `contracts/spora_escrow/`

A single Soroban contract owning the escrow lifecycle.

```
Initialized ──deposit──▶ Funded ──set_in_transit──▶ InTransit
                           │                          │
                           ├──complete_milestone───────┤──▶ Completed
                           ├──report_weather(breach)───┤──▶ ParametricTriggered
                           └──refund (admin, pre-ship)─┴──▶ Refunded
```

**The accounting invariant.** With `A_total` the cumulative deposit in stroops:

```
A_input  = floor(A_total × 9000 / 10000)
A_buffer = A_total − A_input
```

The second leg is derived by **subtraction, not by a second multiplication**.
Computing `floor(A_total × 1000 / 10000)` independently would strand up to one
stroop per deposit in an unaccounted residue. The same discipline governs the
60/40 parametric split. `test::allocation_split_is_lossless_across_remainders`
sweeps every remainder class mod 10 000 to prove it.

### Off chain — `src/lib/`

| Module | Responsibility |
| --- | --- |
| `money.ts` | Integer stroop arithmetic. No float ever touches a settled value. |
| `kotani.ts` | STK push dispatch; HMAC verification, freshness, payload validation. |
| `oracle/weather.ts` | Open-Meteo ingestion, 21-day reduction, Ed25519 attestation. |
| `oracle/chaos.ts` | Deterministic anomaly injection with feasibility checking. |
| `pollar/gas-sponsor.ts` | `FeeBumpTransactionEnvelope` construction — users pay zero XLM. |
| `pollar/funding.ts` | Deferred recipient derivation + atomic sponsored activation. |
| `pollar/earn.ts` | Provider fan-out across Blend and DeFindex, highest APY wins. |
| `pollar/qr-bancario.ts` | EMVCo TLV + CRC-16/CCITT-FALSE Bolivian QR Simple. |
| `soroban/escrow.ts` | build → simulate → assemble → sign → fee-bump → submit → poll. |

---

## The design system

One rule governs every colour, and it can be taught in a sentence:

| | |
|---|---|
| **Green** | land. Farms, harvest, Kano, things growing, things safe. |
| **Blue** | water. The Atlantic crossing, the chain, money settling. |
| **Amber** | motion. Value in flight, not yet landed. |
| **Red** | drought. Nothing else. Ever. |

The discipline is the point. Red appears on exactly one condition in the whole
interface, so when a judge sees red they know the rains failed without being
told. A palette where red also means "delete" throws that away.

The page is ordered so each visitor stops where their understanding does:

```
  hero          "when the rain fails, the money moves"    <- anyone
  four steps     plain language, technical line demoted   <- anyone
  ── cockpit ─────────────────────────────────────────────
  treasury       live figures, exact to the stroop        <- operator
  oracle         consensus, signatures, chaos slider      <- engineer
  audit          every ledger event, explorer links       <- auditor
```

Nobody chooses a mode or hunts for a toggle. Depth arrives by scrolling, which
is the one interaction every visitor already knows.

## Decisions worth knowing about

### The spec's fee-bump snippet had transposed arguments

The real signature is
`buildFeeBumpTransaction(feeSource, baseFee, innerTx, networkPassphrase)`.
Beyond fixing the order, the base fee is **derived from the inner envelope**
rather than hardcoded: a fee bump is only valid if its fee is at least
`(innerOps + 1) × innerBaseFee`, and Soroban envelopes carry a resource fee that
routinely exceeds any fixed constant. A hardcoded fee works until the
contract's footprint grows, then fails silently.

### `Address::has_auth()` does not exist

The reference design gated `complete_milestone` on `admin.has_auth()`. Soroban's
`Address` exposes only `require_auth`/`require_auth_for_args`, so that would not
compile. The contract takes an explicit `caller: Address`, calls `require_auth`
on it, and compares against the two permitted principals.

### Terminal settlements sweep the full balance, and `sweep_residual` exists

Capping disbursement at `total_deposited` would strand accrued Earn yield in a
contract that can never move it again. And because a breach can fire while the
buffer is still in a vault, the redemption can land *after* settlement —
`sweep_residual` distributes late arrivals using the same split the settlement
recorded.

### Three defences, three different attacks

| Attack | Defence |
| --- | --- |
| Forged callback | HMAC-SHA256 over the **raw** body |
| Replayed genuine callback | Idempotency ledger keyed on transaction id |
| Captured-then-delayed replay | 5-minute freshness window |

A signature alone stops none of the last two — a replayed message carries a
perfectly valid MAC, because it *is* the original message.

### The Bolivian QR is generated locally, and it is real EMVCo

Pollar's ramp models bank rails as `CLABE | PIX | PSE | ACH | BREB`. Bolivia's
ASFI QR Simple is not a member, but the offramp body accepts a free-form
`qrCode` and can return an `opaque` scannable — so Spora mints a
standards-compliant payload and hands it over as the opaque instruction.

It is genuine tag-length-value with a **CRC-16/CCITT-FALSE** checksum, verified
before it leaves the server. (The CRC implementation is checked against the
algorithm's published constant: `CRC("123456789") == 0x29B1`.)

### The chaos slider's two axes are physically coupled

A "dry day" is by definition below 1.0 mm. So once the dry run covers the whole
21-day window, cumulative rainfall is capped at 21 mm — asking for 40 mm
alongside 25 dry days describes weather that cannot exist. Rather than
silently honouring one axis and dropping the other, the engine clamps to the
feasible value and says so, in the API response and in the UI.

### The hero is React Three Fiber, not Spline

Spline exports a static `.splinecode` bundle authored once in its editor. It
cannot know that rainfall just dropped below 20 mm. The globe here can:
`breached` re-colours the arc, doubles the packet's speed and shifts the
atmosphere from blue to red, so the hero *is* a live readout of the contract
rather than a decoration above one. It also costs no external download, where a
Spline scene is typically 2-8 MB.

The landmass is ~9 k sampled points rather than an equirectangular texture. A
texture is megabytes and reads as a stock asset; points cost one draw call and
give the planet the instrument-grid character the rest of the interface has,
while leaving the two endpoints as the only solid things on the globe.

### Three weather agencies must agree before anyone is paid

A parametric contract that trusts one feed has a single point of failure that
is also a single point of attack. The oracle now reads three independently
operated numerical models -- **ECMWF IFS**, **NOAA GFS** and **DWD ICON** -- and
requires quorum before the breaker may fire.

Disagreement **blocks** rather than averages. Averaging three sources when one
is wildly wrong produces a number no model reported and launders the outlier
into a payout. Refusing to pay on bad data is recoverable; paying on bad data is
not.

Be precise about what this buys: sharing Open-Meteo as a transport means a
compromise of Open-Meteo is still common-mode. What quorum removes is the far
likelier failure -- one model producing a bad grid cell or a stale run.

### Motion is rationed, not sprinkled

Every animation had to name a purpose — feedback, spatial consistency, state
indication, or preventing a jarring change — and fit a duration budget. Things
that were considered and **deliberately left static**: the chaos slider's
numeric readouts (functional data the operator is reading to make a settlement
decision), the pooling table (a financial table re-rendered every six seconds),
and the risk gauges (a spring overshoot would visually cross the threshold tick
and imply a breach that hasn't happened).

What did earn motion:

- **The settlement count-up.** `0.00 → 1,200.68` over 900 ms. It interpolates
  the underlying **integer stroop** value with `bigint` arithmetic, not the
  display string — so every intermediate frame is an exactly representable
  amount and the last frame is bit-identical to the input.
- **The audit drawer** slides on `transform`, not `max-height`. `max-height`
  isn't compositable, and because the transition runs to the *max* rather than
  to the content height, its easing lands early and the drawer appears to snap.
- **Press feedback** at `scale(0.97)` / 140 ms — deliberately near-imperceptible,
  because it fires dozens of times per session.
- **The meter** scales on `transform`, never `width`.

Reduced-motion is *gentler, not zero*: looping and travelling animations stop,
but state-change transitions survive at a short flat duration. Killing them all
would reintroduce the teleporting figures the motion exists to prevent.

### The design language is nested, not flat

Panels use a **double-bezel**: an outer tray carrying the hairline and ambient
shadow, an inner plate carrying the fill and inner highlight, with radii
computed as `outer − padding` so the curves stay concentric. Recessed wells
invert the highlight to the bottom edge, which is where light actually catches
a depression. A fixed, `pointer-events-none` film grain at 2.8% dithers the
gradient banding that deep greens produce on 8-bit panels.

Every text and badge colour was measured against both surfaces it sits on.
`--spora-text-dim` was failing WCAG AA at 3.89:1 on a panel and 4.14:1 in a
recessed well, and it carries real content: input hints, rail descriptions,
derivation paths. It is now `#74a08f`, measuring 5.48:1 and 5.83:1, still a
clear step below the muted tier so the three-level hierarchy survives. All 13
measured pairs pass AA.

Icons come from Phosphor rather than Unicode glyphs. `U+258F` (the gauge
threshold tick) and `U+21C4` (the corridor arrows) are block-drawing and
arrow-block codepoints with patchy font coverage. They render as tofu on
systems without a matching glyph, which is a poor outcome for a marker whose
entire job is showing where a payout threshold sits.

The agency-tier playbook this drew on also calls for `py-24` to `py-40`
macro-whitespace and rotated Z-axis card cascades. Both were rejected: this is
an information-dense cockpit where a judge needs treasury, corridor, pooling,
weather and QR legible at once, and rotated overlapping cards over a financial
table is a touch-target and readability problem, not a flourish.

### Simulated weather, real settlement

A chaos reading travels the same path as a live one: canonicalised,
Ed25519-signed, submitted to `report_weather` through the sponsored gas wallet.
Only the *provenance of the numbers* is synthetic, and that is recorded
explicitly as `source: "synthetic"` on every emitted event. A demo that faked
the settlement would prove nothing.

---

## Verification

Run against the live dev server:

```bash
npm run typecheck        # 0 errors
npx eslint src scripts --ext .ts,.tsx   # 0 problems
npm run build            # production build
npm run contract:test    # 26/26 contract tests
npm run seed             # exercises the full ingress → escrow → yield pipeline
```

What has been verified end to end in this build:

- **Webhook security** — 6/6: forged signature rejected, missing header
  rejected, valid settlement credited, **replay rejected as duplicate**, stale
  timestamp rejected, post-signing tamper rejected.
- **Parametric boundaries** — 9/9, including `19 mm → fire` vs `20 mm → no fire`
  (the rule is `< 20`, not `<= 20`) and the physically impossible combination.
- **EMVCo conformance** — 9/9 structural checks, TLV re-parsed independently
  including nested templates; CRC verifies.
- **Accounting** — `A_input + A_buffer == A_total` and
  `coop + supplier == pool` asserted on every settlement path.
- **Contract** — **26/26 unit tests pass**, and it compiles clean to
  `wasm32-unknown-unknown` (30 KB) with all 11 entry points exported.

```
running 26 tests
...
test result: ok. 26 passed; 0 failed; 0 ignored; finished in 0.90s
```

Both settlement paths carry exact-balance assertions, and
`allocation_split_is_lossless_across_remainders` sweeps every remainder class
mod 10 000.

### Two build notes

**A pinned transitive dependency.** `soroban-env-host 21.2.1` declares
`ed25519-dalek = ">=2.0.0"` with no upper bound, so Cargo resolves it to 3.0.0,
which reshaped the `CryptoRng` trait. The host's own `testutils.rs` then fails
to compile. The workspace pins `ed25519-dalek = "2.2"` to cap that resolution;
see the comment in `Cargo.toml`.

**Rust 1.82+ emits wasm Soroban cannot parse.** The upload fails with
`reference-types not enabled: zero byte expected`. The cause is not this
crate's codegen: rustup ships a *precompiled* `core` for `wasm32-unknown-unknown`
that uses the reference-types encoding of `call_indirect`, so no `RUSTFLAGS`
value reaches it — `-C target-feature=-reference-types` and `-C target-cpu=mvp`
both leave the offending bytes in place.

The fix is to re-emit the finished module in baseline encoding with Binaryen.
Nothing here uses reference types semantically, so the rewrite is lossless;
it only changes how `call_indirect` writes its table index.

```bash
wasm-opt spora_escrow.wasm -o spora_escrow.optimized.wasm   -Oz --mvp-features --enable-sign-ext --enable-mutable-globals
```

`npm run deploy` does this automatically, and `scripts/deploy.ts` prefers the
rewritten module when it exists.

**Windows needs a host C linker.** The `x86_64-pc-windows-gnu` toolchain that
rustup ships includes `dlltool` and `ld` but no assembler, and GNU `dlltool`
shells out to `as`. Building the native test harness therefore needs MinGW-w64
on `PATH`:

```bash
winget install BrechtSanders.WinLibs.POSIX.MSVCRT
# or extract https://github.com/brechtsanders/winlibs_mingw releases
export PATH="/c/Users/<you>/mingw64-toolchain/mingw64/bin:$PATH"
rustup default stable-x86_64-pc-windows-gnu
npm run contract:test
```

Linux and macOS need none of this; `npm run contract:test` works out of the box.
The wasm build needs no host linker on any platform.

---

## Security notes

- `POLLAR_DERIVATION_SEED` keys the HMAC that derives deferred recipient
  addresses. **Anyone holding it can derive — and spend from — every deferred
  wallet.** It must be set in any shared deployment and treated as a signing
  secret. Unset, a random per-process seed is used, so addresses stay
  self-consistent within one run but do not survive a restart. There is
  deliberately no checked-in fallback.
- Mobile numbers are masked everywhere they are logged or rendered.
- The wallet PIN in the handset simulation is shape-checked locally and never
  transmitted, stored, or logged. On the real rail, PIN entry happens inside the
  SIM applet and never reaches an application server at all.
- The in-memory ledger is the right scope for a demo and explicitly **not** a
  production durability story: a process restart clears the idempotency set. The
  interface is narrow (`hasSeen`/`markSeen`/`append`) so it can be swapped for
  Redis or Postgres without touching a call site.

---

## Layout

```
contracts/spora_escrow/     Soroban contract, types, 26 unit tests
scripts/deploy.sh           build → optimize → deploy → initialize → write env
scripts/seed.ts             demo seeder, drives the real HTTP API
src/app/api/                kotani/, oracle/, pollar/, escrow/ route handlers
src/components/dashboard/   corridor map, pooling matrix, cockpit, portal, drawer
src/lib/                    money, config, kotani, oracle/, pollar/, soroban/, store/
```
