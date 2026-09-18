# Spora — demo video brief

Target runtime **2:30**. Judged on: working end-to-end payment flow, SDK
integration quality, proof of real usage, project clarity. Every second should
be serving one of those four.

Live site: <https://spora-jackson-abetianbes-projects.vercel.app>

---

## Part 1 — What to record

Record at **1920×1080, 60fps**, browser in fullscreen with no bookmarks bar, no
extensions visible, no notifications. Use a clean profile. Cursor visible.

Do each take **twice**: once at normal speed, once slowly. The editor needs
slack to retime.

### A. Hero globe — 20s

`/` at the top. Let the globe rotate untouched for 8 seconds, then scroll
slowly through the story section until the cockpit threshold appears. **Do not
move the mouse** while the globe spins — a still cursor makes the motion read
as the subject rather than as a page being fiddled with.

### B. The corridor map — 15s

`/corridor`. Scroll to the map. Hold while the marching flow animates from
Caranavi up across the equator to Kano. Then scroll once through the five
settlement legs.

### C. A live Paystack payment — 30s  ⭐ most important shot

`/cooperative` → **Contribute** → **Pay ₦316,000 with Paystack**.

Record the whole thing: the modal, the "Paystack is live" green badge, the new
tab opening on `checkout.paystack.com`, and the payment completing. Then cut
back to the app and show the escrow figure change.

This is the "working end-to-end payment flow" criterion in one shot. Do not
speed it up in the edit — the realism is the point.

### D. The Pollar wallet — 25s  ⭐ second most important

`/wallet`. Record: **Connect a wallet** → email → the code arriving → signed in
→ the embedded Stellar address appearing → Earn venues loading.

Also capture the "What the server can and cannot do" table, holding on the
column of `401`s. That table *is* the SDK-integration argument.

### E. The oracle — 20s

`/oracle`. Show the three named models with their readings and the spread.
Then drag the **Simulate Climate Volatility** slider past 21 dry days with
rainfall under 20 mm, and let the breach fire.

### F. The settlement cinematic — 20s

Whatever the breach triggers — dual-phone takeover — record it uncut, full
screen.

### G. On-chain proof — 20s

`/audit`, top panel. Hold on the "Verified on chain" block. Then **click the
transaction hash** and record stellar.expert loading, scrolling to the operation
showing the USDC transfer and the contract invocation.

Real explorer, real hash. Do not recreate this in After Effects.

### H. Mobile — 10s

Phone-width capture (375px) of `/` and `/cooperative`, scrolling. Portrait.

### I. Code — 10s

Editor on `contracts/spora_escrow/src/lib.rs`, scrolling slowly through
`deposit_funds` and the settlement split. Dark theme, large font (18pt+).

---

## Part 2 — Voiceover script

Timed to 2:30. Cartesia Sonic — pick a calm, low-register voice. **Not**
enthusiastic. The subject is farmers losing a harvest; an upbeat read will
land badly.

> **[0:00]** Eight farmers in Kano State share forty-six hectares of rain-fed
> maize. None of them can buy a container of soil inputs alone. None of them
> can survive a failed rainy season alone either.
>
> **[0:12]** Conventional crop insurance asks them to file a claim, wait for an
> adjuster, and prove a loss — a process that routinely outlasts the season it
> was meant to rescue.
>
> **[0:22]** Spora is a parametric escrow. Naira in Kano. Bolivianos in
> Caranavi. Stellar in between.
>
> **[0:32]** Farmers pay in over the same bank rail behind every Nigerian USSD
> code. It settles as USDC into a Soroban contract, which splits it ninety-ten:
> inputs, and a climate buffer that earns yield while the shipment crosses the
> Atlantic.
>
> **[0:50]** This is a real Paystack checkout. Real API, real webhook, real
> signature verification on the way back.
>
> **[1:05]** Farmers don't hold XLM and haven't written down a seed phrase. So
> Pollar issues an embedded Stellar wallet from an email address.
>
> **[1:18]** We built this server-side first, and it didn't work. Pollar's
> user-scoped endpoints reject an application key — their tokens are bound to a
> keypair that never leaves the browser. That's not a bug; it's the design.
>
> **[1:32]** So the wallet lives in the browser where it can hold a session,
> and every signing key stays on the server where it belongs.
>
> **[1:42]** The trigger is rainfall. Three weather agencies — European, American,
> German — read independently. If they disagree beyond tolerance, the oracle
> refuses to sign. A number no model believes should never move money.
>
> **[1:58]** Under twenty millimetres across twenty-one days, and the contract
> pays. Sixty percent emergency relief to the cooperative. Forty to the supplier,
> who already shipped. No claim. No adjuster.
>
> **[2:14]** And this is not a mock-up. Twenty USDC moved on Stellar testnet.
> The contract took the transfer, executed the split itself, and we checked the
> invariant against chain state rather than our own arithmetic.
>
> **[2:28]** When the rain fails, the money moves.

---

## Part 3 — Prompt for the AI video editor

Paste from here down.

---

You are editing a 2:30 hackathon demo film for **Spora**, a parametric climate
escrow on Stellar. Assets: screen captures A–I (see manifest), a Cartesia VO
track, and the project's own design system.

### Creative intent

The register is **restrained technical documentary** — closer to a Stripe or
Linear product film than to a crypto promo. The subject is Nigerian farmers
losing a harvest. Nothing may read as hype. Specifically banned: whoosh
transitions, glitch effects, neon grids, "blockchain" stock footage, particle
bursts, drone shots of cities, upbeat corporate synth, countdown timers,
lens flares.

The film earns trust by showing real software doing real things, uncut.

### Visual system — match the product exactly

Sample these from the captures; do not invent a palette.

- Ground `#05141c`, panels `#082031`, void `#030d14`
- Land green `#21c77a` / bright `#3ce392`
- Water blue `#2b9ff5` / bright `#5cbcff`
- Motion amber `#f0a024`, drought red `#f0452e`
- Ink `#eef6fa`, muted `#9db8c9`

**Colour carries meaning here and must not be used decoratively.** Green is
land and safety. Blue is water and settlement. Amber is value in motion. Red is
drought. A red accent on a non-drought beat is a continuity error.

Typography: **Instrument Sans** for titles, **Geist Mono** for every numeral,
address and hash. Lower-third titles only, left-aligned, 4–5 words maximum.
Never centre a title over the globe.

### Edit DNA

- **Cut on the VO's sentence boundaries, not on the beat.** Music is a floor,
  not a driver.
- Average shot length **3.5–4.5s**. The two hero shots (Paystack payment,
  on-chain proof) run **8s+ uncut** — their length *is* the argument.
- Motion: ease-out `cubic-bezier(0.23, 1, 0.32, 1)`, 300–500ms. Nothing bounces.
- Zero speed ramps on the payment and explorer shots. Those must read as
  unedited.
- Screen recordings: scale 100–104% max. Never pan-and-scan a UI; it reads as
  hiding something.

### Structure

| Time | Shot | Title card | Notes |
|---|---|---|---|
| 0:00–0:22 | A | *When the rain fails* | Globe untouched. Let it breathe. |
| 0:22–0:32 | B | *Kano → Caranavi* | Trace the arc with a subtle amber highlight |
| 0:32–0:50 | B, I | *90% inputs · 10% buffer* | Cut to `lib.rs` on "splits it ninety-ten" |
| 0:50–1:05 | **C** | *A real payment* | **Uncut. No speed ramp.** |
| 1:05–1:42 | **D** | *A wallet from an email* | Hold on the `401` table 3s minimum |
| 1:42–1:58 | E | *Three agencies must agree* | Isolate each model name as VO says it |
| 1:58–2:14 | E, F | *60 relief · 40 indemnity* | Breach → cinematic, amber→red shift |
| 2:14–2:28 | **G** | *Verified on chain* | **Uncut.** Hold on the hash, then explorer |
| 2:28–2:30 | H, logo | *spora* | Mark + tagline, 2s, silence |

### Audio

- Music: single sustained low bed, no drop, no build. Duck to **-22 LUFS**
  under VO, rise to -16 only in the 0:00–0:12 cold open and the last 2s.
- SFX: **sparse and diegetic only** — a soft UI click on button presses, one
  low confirmation tone when the on-chain hash resolves. Nothing else. No
  risers, no impacts.
- Master to **-14 LUFS** integrated, true peak **-1.0 dBTP**.
- The 2:28–2:30 logo card is **silent**. Cut the music dead on the last word.

### Captions

Burn in. Instrument Sans, bottom third, 90% white on a 60%-opacity dark plate.
Word-level timing from WhisperX. Every figure and identifier — `20 USDC`,
`CB3L4…O7MK`, `1d7efadc…` — renders in Geist Mono and holds on screen for a
full 2s so a judge can read it.

### Quality gate — reject and re-cut if any fail

1. Any shot implies something works that the interface shows as `mock`.
2. The Paystack or explorer shot has been sped up, cut, or re-created.
3. A colour is used against its semantic (red on a non-drought beat).
4. Average shot length under 3s — it will read as a crypto ad.
5. Music is audible over a spoken numeral.
6. Any title card exceeds 5 words.
7. The film ends on anything other than the mark and the tagline in silence.

### Deliverables

- `spora-demo-2160p.mp4` — H.264, 2160p, 60fps, CRF 18
- `spora-demo-1080p.mp4` — H.264, 1080p, 60fps, CRF 20, under 100 MB
- `spora-demo.srt`
- A 6-second silent loop of the globe (shot A) for the submission card
