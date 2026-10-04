# Vision — one phone, many bridges, one network, many trees

Raised 09-30/10-01 (user), reviewed by veraldar main. This is the product
north star; features below trace to it.

## The structure

```
        one phone
      ┌───────────┐
      │ Bifrost   │  one PWA — swipe between as many bridges as you want
      └─────┬─────┘
   roots:   │   one private network (Tailscale, or its open twin Headscale)
      ┌─────┴──────────────┬──────────────────┐
      ▼                    ▼                  ▼
  Yggdrasil PC          Yggdrasil PC       Yggdrasil PC
  (by the TV:           (game creation)    (building a company)
   "play the movie")     agent core         agent core
   agent core
```

- **Veraldar** = the world (the organisation)
- **Yggdrasil** = the tree = the agent core on each PC (opencode today; a
  Rust-optimized one-click build is the evidence-triggered evolution — the
  shelved bifrostd idea, properly named)
- **Bifrost** = the bridge = this PWA, one per connection, many per phone
- **Tailscale/WebRTC** = the roots and rivers (private networking + media)

## Review verdict (veraldar main)

Agreed — and it is ~80% true today: the PWA + opencode + bootstrap already
deliver "one-click agent core on any PC" and "talk to your code from the
phone". The genuinely NEW engineering piece is the **instance switcher**:
one PWA holding several backends (per-PC identity, swipe to change tree).
That is a real feature candidate — spec before building.

## PIVOT 10-02 (user): federation, not switching

The user challenged the instance switcher — and won. If all trees share one
tailnet, one Bifrost can KNOW its siblings and contact them directly: the
phone sees ALL sessions from ALL trees in ONE unified list. No switching, no
mode change — one world view. Technically: peer discovery over the tailnet,
the phone's own instance fans out server-to-server (one-seam invariant stays;
peers talk over the tailnet), sessions carry their tree label. Auth between
peers = instance tokens (same seam as S1). This replaces the switcher as the
v1.1+ architecture: spec name becomes "federation/peering", not "switcher".

## Commitments traced to this vision

1. Instance switcher (multi-backend PWA) — feature candidate, needs spec
2. Tailscale elevated to a named pillar — research session on trust +
   open alternatives (Headscale/Netbird) in flight
3. Yggdrasil naming for the agent core — brand-level now, engineering stays
   evidence-triggered
4. The story told everywhere — brand session weaving it into lore, website,
   and the narration for a future report/design/movie
5. "What AI can simulate, AI can create." — manifesto line, brand book

## The tree is the door (10-02, user)

veraldar.org: the tree at the top, clickable — "hold to start" — runs the
vocal onboarding (voice collects who they are + provider choice, hands the
personalized install command/QR). PWA first-run: the tree fills the screen,
alone; clicking it runs vocal onboarding and creates THE MAIN session
(caps-tagged); afterwards the tree shrinks to its corner but stays the door
— clicking it always opens main. One gesture on two surfaces: you knock on
the tree, the bridge opens.

## bifrost-net (10-02, user — recorded, not scheduled; corrected 10-03: the access point is a BIFROST — bridges connect; Yggdrasil = the trees on machines)

The ambitious end-state of the sovereign tier: OUR OWN safe access point in
Rust — a BIFROST NODE for the sky: private mesh (WireGuard-protocol via
proven crates like boringtun) + WebRTC server (str0m-class) = ONE binary on
a VPS: your own tailscale-replacement + WebRTC + the bridge. Trees
(Yggdrasils) stay on the user's machines and connect THROUGH it. Auditable,
AGI-assembled from proven crates — never hand-rolled crypto.

## FACTUAL BASELINE (10-03): two trees already live
- omarchy: bifrost + opencode (building bifrost + yggdrasil)
- Mac Studio: its own bifrost + its yggdrasil (opencode-serve, skid
  workers, seidr) — used through a bifrost for a DIFFERENT project
Federation is not future: two bridges, two trees exist today. The user
already crosses between them.

Status: was never proposed to AGI (the reviews simplified transport to
client-side multi-bridge to avoid scope explosion). Not rejected — deferred
by omission. De-risk path: a [LAB] spike (M0 = two nodes meshed via
boringtun + one str0m echo test) measuring whether AGI can assemble it.
Trigger: sovereign-tier demand after v1.0, or the user calls the spike.

## The phone-join gaps (10-03, user questions) — answers + open items

Q: does the onboarding deploy bifrost-net on a VPS? A: NOT in v0.8 — first-run
is home/tailnet only (simplest). The "access from anywhere" branch comes at
v0.9 and the onboarding DEPLOYS it agentically: the user picks a provider +
country, creates the account (their money, their choice), AGI deploys
bifrost-net via API — the conversation deploys the access point.

Q: when scanning the QR, how does the phone join bifrost-net? A: IT DOESN'T
— the phone pairs to the BRIDGE, never to the network. The bridge is the
phone's only peer. Remote access = the BRIDGE joins the access point
(bifrost-net), and relays for the phone. The phone's world stays one URL.

OPEN (needs decision before v0.9):
1. RELAY PRIVACY: does bifrost-net relay CIPHERTEXT (E2E by design — keys
   live on phone+bridge, the VPS routes what it cannot read) or terminate?
   Proposal: ciphertext-only relay — the privacy story stays intact. Cost:
   key exchange over the relay must be designed.
2. VPS ACCOUNT FLOW: user creates the account at a provider of their
   choice/country; AGI deploys via the provider's API with a scoped token.
   Which providers at launch: Hetzner, OVH, Infomaniak (CH), plus
   user-already-has-SSH path.
3. PHONE WITHOUT TAILSCALE OUTSIDE HOME (pre-bifrost-net interim): the
   tailscale app on the phone is the interim answer (2-min install) —
   document it as the official interim remote path in v0.8.
