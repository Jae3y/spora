# Spora — film brief

For an agentic editorial engine. Footage is shot and ingested. You decide the
cuts.

This document gives you **intent, constraints and raw material**. It does not
give you an EDL, because you build better ones than a human writing in advance
can. Where it specifies, the specification is load-bearing. Where it doesn't,
it's yours.

**Runtime** 2:30 · **Delivery** 2160p60 + 1080p60 · **Music** `home` (supplied)

Live product: <https://spora-delta.vercel.app>

---

## 1 · Creative Intent Graph

**Root intent:** make a viewer who has never thought about crop insurance
understand, in two and a half minutes, that money can move itself when the rain
fails — and believe it, because they watched real software do it.

Three child intents, in priority order when they conflict:

| Intent | Serves | Wins when |
|---|---|---|
| **Believe it's real** | proof of usage | always — this outranks everything |
| **Understand the mechanism** | clarity | conflicts with delight |
| **Enjoy watching it** | attention | conflicts with nothing else |

**Register:** a flagship SaaS product film. Linear's launch videos, Stripe
Sessions, Vercel Ship, Arc's browser reveal. Confident, fast, designed, funny
in the way competent things are funny. Not a documentary. Not a crypto ad.
Not earnest.

The subject is agricultural finance in northern Nigeria, and the temptation is
to shoot it as a charity appeal. **Don't.** These farmers are running a
business, and the film should treat them like operators, not subjects. The
emotional beat lands harder from restraint than from strings.

**Nothing in this film may read as a demo, a mock, or a prototype.** Every rail
in the product is live, the contract is deployed, and the transactions on
screen are real. Cut it as what it is: a working product.

---

## 2 · Raw material

Shot, ingested, unlabelled, variable length. Use your vision pipeline to
identify and segment — do not trust my ordering.

- **Hero globe** — R3F point-cloud earth, arc Kano↔Caranavi
- **Corridor map** — SVG, marching flow across the Atlantic
- **Paystack payment** — full flow to a real `checkout.paystack.com` success
- **Pollar wallet** — email login → embedded Stellar wallet → Earn venues
- **Server/session capability table** — the `401` column on `/wallet`
- **Oracle** — three named weather models; sliders driven into drought
- **Settlement** — the `Execute parametric settlement` press and the dual-phone
  takeover that follows
- **On-chain proof** — `/audit` panel, then stellar.expert with a real hash
- **Mobile** — portrait scrolls
- **Code** — `lib.rs`, `deposit_funds` and the settlement split

Retrieval and tracking are yours. If a take is unusable, generate a
replacement with Google video rather than forcing it — but **never** generate
a substitute for the Paystack success, the explorer page, or the settlement
press. Those three must be the real capture.

---

## 3 · Visual system

Sample from the footage. Do not invent a palette.

```
ground   #05141c     land green   #21c77a → #3ce392
panel    #082031     water blue   #2b9ff5 → #5cbcff
void     #030d14     motion amber #f0a024
ink      #eef6fa     drought red  #f0452e
muted    #9db8c9
```

**Colour is semantic and that constraint is absolute.** Green is land and
safety. Blue is water and settlement. Amber is value in motion. Red is drought.
Everything else in the film — graphics, transitions, grade, light — obeys this.
A red accent on a non-drought beat is a continuity error the quality pass must
catch.

Type: **Instrument Sans** for titles, **Geist Mono** for every numeral, hash and
address. The product uses these; the film inherits them.

Grade in Resolve: lift the blues in the corridor and settlement sections, push
green in the land sections, and let the drought section go genuinely hot. Use
the Resolve MCP to build the node tree per-section rather than one master grade.

---

## 4 · Motion graphics — Remotion / HyperFrames

This is where the film stops being a screen recording and becomes a product
video. Build these as Remotion compositions and comp them over the captures.

**Required:**

1. **Money-flow ribbon.** A continuous animated ribbon that carries the
   viewer's eye across the whole film: naira green entering, becoming blue as
   it settles to USDC, splitting 90/10, the 10% orbiting while in transit,
   then splitting 60/40 red-and-amber at the breach. It should appear at every
   section transition so the viewer always knows where the money is. This is
   the film's spine.

2. **The 90/10 split, animated.** When the VO says it, show a bar divide itself
   with the numbers counting. Land the buffer as a distinct object — it has a
   job later and the audience needs to remember it.

3. **Stellar-native identifier treatment.** Contract IDs, transaction hashes
   and wallet addresses are 56 characters of Geist Mono. Animate them as a
   typewriter-reveal in monospace, with the middle collapsing to an ellipsis
   after it lands, and a subtle scanline while resolving. When a hash confirms,
   it should *feel* confirmed — weight, a colour shift to green, a settle.

4. **Three-model consensus.** Three gauges. When they agree, they converge and
   lock. When they disagree, the lock refuses. Make the refusal satisfying —
   it's the most interesting idea in the product.

5. **Kinetic captions.** Word-level from WhisperX. Every figure, currency and
   identifier renders in Geist Mono and pops a beat harder than the surrounding
   words. Captions are part of the design, not an accessibility afterthought.

6. **Lower thirds.** Section titles, left-aligned, 2–5 words, Instrument Sans,
   entering on a beat.

**Encouraged wherever it serves:** particle work on the globe, light streaks
along the corridor arc, glass refraction on panel reveals, whoosh and impact
design on hard cuts, glitch on the drought turn, speed ramps into and out of
hero moments, scale and pan on UI to direct attention, 3D camera moves through
the corridor, match-cuts between the map arc and the ribbon graphic.

Push it. The only thing that would embarrass this film is looking timid.

---

## 5 · Edit DNA

- **Cut to `home`.** Music drives. Analyse its beat grid, find its structural
  transitions, and hang the film's sections on them. The VO is timed *to the
  edit*, not the other way round.
- **Pace it like a product launch.** Fast, varied, deliberate. Let the
  settlement and the explorer confirmation *breathe* — not because a rule says
  so, but because a payout and a confirmed hash are the two moments the
  audience needs to feel.
- **Speed ramps welcome**, including on UI. A ramp that carries someone through
  a form and lands hard on the success state is good editing.
- **Move the camera on screen recordings.** Push in on what matters. A static
  1:1 screen capture for eight seconds is a recording, not a shot.
- **Motion physics:** spring, with restraint — `duration 0.5, bounce 0.2`
  Apple-style. Things may overshoot. Nothing may wobble.
- **Match-cut aggressively.** Green ribbon → green gauge → green success state.
  Circle wipe from the globe into a gauge. Hash characters resolving into the
  explorer's own type.

---

## 6 · Voiceover

Cartesia Sonic 3.6. Warm, mid-register, conversational — someone explaining
something they built to a friend who's smart but doesn't know the domain.
**Not** a narrator. Not reverent. A little dry.

Direct it to take its time on the first eight seconds and pick up from there.

> Amina farms seven hectares outside Kano. Maize and sorghum, one rainy season
> a year. It either comes, or it doesn't.
>
> When it doesn't, she can apply for a payout. Someone drives out to look at
> her field. Eventually. Usually after the next planting season has already
> started.
>
> So we built the thing that doesn't wait.
>
> Eight farmers put money in from the phones in their pockets — the same bank
> transfer behind every Nigerian USSD code. It lands as dollars on Stellar,
> inside a contract that splits it the moment it arrives. Ninety percent buys
> fertiliser from a supplier in Bolivia. Ten percent stays behind.
>
> Hold onto that ten percent.
>
> This is a real payment. Real checkout, real webhook, real signature checked on
> the way back in.
>
> Now — none of these farmers own a crypto wallet, and nobody's about to write
> down twelve secret words on a piece of paper. So Pollar makes them a Stellar
> wallet out of an email address.
>
> We tried to do that from our server first. It didn't work, and it took us a
> while to understand why: Pollar ties your session to a key that lives in your
> browser and never leaves it. Which is the right call. So the wallet runs where
> the farmer is, and the money stays where it's safe.
>
> That ten percent has been earning this whole time, by the way.
>
> The trigger is rain. Three weather services watch Kano — European, American,
> German. They have to agree. If they don't, nothing happens, and that's the
> point: we're not paying out on a number only one model believes.
>
> Under twenty millimetres in three weeks, and the contract moves on its own.
> Sixty percent straight to the farmers. Forty to the supplier, who already
> shipped. Nobody files anything. Nobody drives out to look at the field.
>
> And that's twenty real dollars on Stellar. The contract took the transfer,
> did the split itself, and we checked the arithmetic against the chain instead
> of against ourselves.
>
> When the rain fails, the money moves.

**Notes for the read:** "Hold onto that ten percent" and "That ten percent has
been earning this whole time, by the way" are the film's running joke — same
voice, lighter, faintly pleased with itself. The Pollar paragraph is the
honest-engineer beat; play it as someone admitting a mistake they're glad they
made. The last line is flat. No lift. Let the music finish it.

---

## 7 · Audio

- **Music:** `home`. Full presence in the cold open and the last eight seconds.
  Duck to -20 LUFS under VO. If it has a drop or a structural turn, spend it on
  the settlement.
- **SFX:** design it properly. UI clicks with weight. A rising element into the
  drought turn. A real *thunk* on the settlement press. A clean confirmation
  tone when the hash resolves. Whooshes on section transitions are fine — make
  them tonal and tuned to the track, not stock swooshes.
- **Silence is a tool.** Cut everything for a beat before the settlement fires.
- Master **-14 LUFS**, true peak **-1.0 dBTP**.

---

## 8 · Stack routing

| Stage | Tool | Job |
|---|---|---|
| Ingest | faster-whisper + WhisperX | transcribe VO, word-level timing for captions |
| Vision | reference analysis, Edit DNA | segment and label raw captures; find the real success frames |
| Reference | vision retrieval | pull Linear / Stripe / Arc launch films as similarity targets |
| Music | beat + audio DNA | beat grid and structural map of `home`; section boundaries |
| Graphics | Remotion + HyperFrames | §4 compositions, captions, lower thirds, ribbon |
| Assembly | Timeline IR + FFmpeg | cut, conform, ramp |
| Gen | Google omni / video | texture, atmosphere, transitional elements only |
| Sound | SFX intelligence + library | §7 design |
| Finish | DaVinci Resolve + Resolve MCP | per-section node trees, grain, final grade |
| Review | quality eval | §9, then revise and re-run |

Run the full autonomy loop. Plan, generate, edit, review, revise. Keep
provenance on every generated element so the review pass can trace and replace.

---

## 9 · Quality gates

Re-cut if any of these fail.

1. **Any frame shows a `mock` badge, a placeholder, a loading skeleton, an
   error state, or an empty table.** Everything in this product is live. If a
   capture caught a transitional state, use a different frame.
2. The Paystack success, the explorer page, or the settlement press is
   generated, recreated, or composited rather than the real capture.
3. A colour is used against its semantic — most likely a red or amber accent
   outside a drought or in-motion beat.
4. A spoken numeral is not legible on screen within 500ms of being said.
5. The film ends on anything other than the mark, the tagline, and the music
   resolving.
6. Reference similarity to the SaaS-launch targets scores below the documentary
   targets. If it does, you've made the wrong film.
7. Any identifier is on screen for under 1.5 seconds. A hash nobody can read is
   set dressing, not evidence.

---

## 10 · Deliverables

- `spora-demo-2160p.mp4` — H.264, 2160p60, CRF 18
- `spora-demo-1080p.mp4` — H.264, 1080p60, CRF 20, under 100 MB
- `spora-demo.srt`
- A silent 6-second globe loop for the submission card
- A 15-second vertical cut for social — settlement beat only
