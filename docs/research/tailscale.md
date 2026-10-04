# Tailscale: trust report + open-source alternatives — for bifrost

*Research session, 2026-10-02. Mission from user (Veraldar): verify Tailscale's origin and trustworthiness (it is a core bifrost pillar: private networking phone ↔ many agent PCs, WebRTC media over it), and seriously compare open-source alternatives. Facts carry links; anything not confirmed is marked **TO-VERIFY**.*

---

## 1. Origin: who built it, when

**Tailscale Inc. was founded in 2019 in Toronto by four ex-Google engineers: Avery Pennarun, David Crawshaw, David Carney, and Brad Fitzpatrick** ([Wikipedia](https://en.wikipedia.org/wiki/Tailscale), citing [TechCrunch](https://techcrunch.com/2022/05/04/tailscale-lands-100-million-to-transform-enterprise-vpns-with-mesh-technology/)). The name comes from the 2013 Google paper *The Tail at Scale* (Dean & Barroso) ([Wikipedia](https://en.wikipedia.org/wiki/Tailscale)).

Founder / people credentials:

- **Brad Fitzpatrick** — created LiveJournal, memcached, and OpenID; worked on the Go language team at Google ([Wikipedia: Brad Fitzpatrick](https://en.wikipedia.org/wiki/Brad_Fitzpatrick)). He led the userspace Go port of WireGuard (`wireguard-go`) that Tailscale is built on.
- **Avery Pennarun (CEO)** — author of `sshuttle` ("the poor-man's VPN") and of the widely-cited essay [*How NAT traversal works*](https://tailscale.com/blog/how-nat-traversal-works).
- **David Crawshaw** — Go contributor from the Google Go ecosystem (**TO-VERIFY**: exact role).
- **David Carney** (Chief Strategy Officer) — ex-Google (**TO-VERIFY**: pre-Tailscale background).
- **Advisory board**: Jason Donenfeld (creator of WireGuard itself) and Joe Beda (co-creator of Kubernetes) ([tailscale.com/company](https://tailscale.com/company)).
- First small-user launch **December 2019** (per Tailscale's own incident timeline in [TS-2025-004](https://tailscale.com/security-bulletins#ts-2025-004)).

**Funding** (total ≈ $272M disclosed):

| Round | When | Amount | Lead |
|---|---|---|---|
| Seed | 2019–2020 | n/a | Heavybit, Uncork Capital |
| Series A | Nov 2020 | $12M | Accel ([TechCrunch](https://techcrunch.com/2020/11/10/tailscale-raises-12-million-for-its-wireguard-based-corporate-vpn/)) |
| Series B | May 2022 | $100M | CRV + Insight Partners ([TechCrunch](https://techcrunch.com/2022/05/04/tailscale-lands-100-million-to-transform-enterprise-vpns-with-mesh-technology/), [Tailscale blog](https://tailscale.com/blog/series-b)) |
| Series C | Apr 2025 | $160M | Accel ([Tailscale blog](https://tailscale.com/blog/series-c)) |

Reference customers named by Tailscale: Instacart, Mercury, Duolingo, Mercari, Retool ([tailscale.com/security](https://tailscale.com/security)). Release cadence is healthy — v1.102.5 shipped 2026-09-29 ([releases](https://github.com/tailscale/tailscale/releases)).

### Was AI used in its creation or security? (what's real vs. marketing)

- **Not created with AI.** Tailscale predates the LLM era (founded 2019, first launch Dec 2019). The stack is the WireGuard protocol ([cryptographically reviewed](https://eprint.iacr.org/2018/080.pdf), in the Linux kernel since 5.6 in early 2020) plus Go userspace code (`wireguard-go`, `tailscaled`, DERP relay) — all human-written in that period. No credible claim of AI-generated foundations exists.
- **AI in security — the verified connection is inbound, not outbound:** several 2026 client vulnerabilities were found and reported to Tailscale by **Anthropic's infrastructure security team and Ada Logics** (e.g. [TS-2026-008](https://tailscale.com/security-bulletins#ts-2026-008), [TS-2026-009](https://tailscale.com/security-bulletins#ts-2026-009), [TS-2026-011](https://tailscale.com/security-bulletins#ts-2026-011)). I.e., AI-industry players are *pentesting Tailscale*; Tailscale itself says it has **no bounty program** and relies on peer review, static analysis, and [Latacora](https://www.latacora.com/) audits ([tailscale.com/security](https://tailscale.com/security)). Any claim that "AI secures Tailscale" beyond that is unproven — **TO-VERIFY** if anything more specific is claimed elsewhere.
- **The "AI" they publicize is product positioning, aimed at AI agents:** "Secure AI Agent Connectivity" ([use-case](https://tailscale.com/use-cases/securing-ai)), an AI gateway, and **Aperture by Tailscale** — an AI-governance platform ([aperture.tailscale.com](https://aperture.tailscale.com), [independent write-up](https://workos.com/blog/tailscale-ai-gateway-agents-identity)). This is Tailscale as *infrastructure for* AI, not AI-built Tailscale.
- **"Azure" is customer-side integration, not their backend.** Tailscale publishes Azure reference architectures and supports Microsoft Entra ID SSO ([Azure ref arch](https://tailscale.com/docs/reference/reference-architectures/azure)). But its own production **coordination server runs on AWS** — Linux in AWS VPCs, metadata in SQLite backed up to S3, analytics in Snowflake — per its own security FAQ ([tailscale.com/security](https://tailscale.com/security)).

---

## 2. Trust assessment

### Open vs proprietary

| Component | Status |
|---|---|
| Client daemon (`tailscaled`), `wireguard-go`, DERP relay server | **Open source, BSD-3** ([github.com/tailscale/tailscale](https://github.com/tailscale/tailscale)) — DERP code is auditable/self-hostable ([custom DERP docs](https://tailscale.com/kb/1118/custom-derp-servers)) |
| GUI clients for Windows / macOS / iOS | Partially closed (proprietary-OS GUIs) |
| **Coordination (control) server** | **Proprietary SaaS** — the core concession; summarized by Headscale's README: "Everything in Tailscale is Open Source, except the GUI clients for proprietary OS… and the control server" ([headscale README](https://github.com/juanfont/headscale)) |
| Mitigation for trusting the control server | **Tailnet Lock** — nodes only talk to keys signed by your own trusted signing nodes, so the coordination server can't silently add peers ([kb/1226](https://tailscale.com/kb/1226/tailnet-lock)) |

### Audits & certifications

- **SOC 2 Type II** (security, availability, confidentiality); report available under NDA ([tailscale.com/security](https://tailscale.com/security)).
- **Ongoing security audits by Latacora** (assessments, design review, advisory); reports available on request via the DPA — **not public** (**TO-VERIFY**: no public third-party pentest report exists).
- **Public security policies** on GitHub ([tailscale/security-policies](https://github.com/tailscale/security-policies)) and a public [incident disclosure policy](https://tailscale.com/security-policies/incident-disclosure).

### Security track record (disclosed incidents)

Tailscale maintains a candid public ledger: [tailscale.com/security-bulletins](https://tailscale.com/security-bulletins) (20+ bulletins visible for 2024–2026; page goes back further). Representative ones:

- **TS-2025-004** — the most user-facing one: users with the same *shared email domain* could land in each other's tailnets (664 known shared domains of 166k total); mitigated May 2025 by defaulting user approval on for new tailnets and decomposing affected tailnets ([bulletin](https://tailscale.com/security-bulletins#ts-2025-004)).
- **TS-2025-003** — timing side-channel in DERP mesh auth (patched, mesh secrets rotated).
- **TS-2026-006/-009** — Tailscale SSH ACL bypasses allowing `root` sessions (UID `0` / `-i` username tricks), fixed in 1.98.9.
- **TS-2026-003** — OAuth tokens recorded (redacted later) in audit logs; 1-hour validity window limited exposure.
- Auth-key TOCTOU race (control plane, fixed server-side).

**Pattern:** real bugs, none breaking WireGuard's end-to-end encryption; disclosure is unusually detailed, credits reporters, and fixes ship fast. That is a *good* incident culture. The recurring lesson: most risk lives in **Tailscale SSH / Serve / Funnel extras**, not in the WireGuard tunnel itself — bifrost uses none of those by default.

### What the coordination server sees

Straight from Tailscale's security page and FAQ ([tailscale.com/security](https://tailscale.com/security)):

- **Sees (metadata):** account identity/email (via your IdP), device inventory (OS, hardware, machine names, client version), **public IP addresses and endpoints**, ACL/policy configuration, online/offline presence and connection metadata. Stored AES-256 at rest, backed up hourly.
- **Never sees:** traffic contents — everything is end-to-end WireGuard-encrypted; private keys never leave devices. DERP relays route only ciphertext and don't log payload. MagicDNS queries are claimed not logged.
- **Client logs** can be switched off (`--no-logs-no-support`, [kb/1011](https://tailscale.com/kb/1011/log-mesh-traffic)) — but "You cannot limit coordination server logs."
- **Structural honesty:** transport is peer-to-peer, *authority* is centralized — the control server could in principle see your topology and is a chokepoint. Tailscale's own mitigations: Tailnet Lock, custom/self-hosted DERP, ACLs; the ecosystem's mitigation: Headscale (below). Also worth knowing: control-plane availability is *not* needed for existing connections to keep flowing — only for admin changes/re-keying.

---

## 3. Open-source alternatives, seriously compared

### Headscale — self-hosted control server, official Tailscale clients

- **What:** open-source (BSD-3) reimplementation of the Tailscale *coordination server*; you keep using the stock Tailscale apps on phone and PCs ([github.com/juanfont/headscale](https://github.com/juanfont/headscale)).
- **Maturity:** very mature and active — **44.3k stars**, 4.6k commits, v0.29.4 released **2026-09-23** (min supported client v1.80.0), CI-integration-tested against real Tailscale clients including HEAD; FOSDEM 2026 talk. One maintainer (Kristoffer Dalby) is **employed by Tailscale** to work on it, openly sanctioned ([README disclaimer](https://github.com/juanfont/headscale#disclaimer), [tailscale.com/blog/opensource](https://tailscale.com/blog/opensource)) — which dramatically lowers the "abandonment" risk.
- **Scope caveat by design:** a *single* tailnet, aimed at self-hosters/hobbyists; CLI + config file, **no official web admin UI** (third-party ones exist — **TO-VERIFY**); project explicitly "does not support nor encourage reverse proxies and containers" — happiest as a single binary on a small public VM with embedded ACME/TLS.
- **Effort for a non-techie:** moderate-high (one public VPS + DNS + config + client login-server override). For an LLM-driven setup like bifrost: trivial to script.
- **Fit for bifrost:** **excellent escape hatch** — identical phone apps and UX, data plane untouched, only the key-exchange/ACL brain moves home. Lose: SSO polish, admin console, MagicDNS extras may lag upstream (**TO-VERIFY** on specific feature parity incl. Tailnet Lock support).

### NetBird — fully open-source WireGuard mesh (control + data tooling)

- **What:** complete WireGuard overlay with management, signaling, STUN/TURN-style relay, and web dashboard — client **BSD-3**, control-plane components (management/signal/relay) **AGPLv3** ([github.com/netbirdio/netbird](https://github.com/netbirdio/netbird)).
- **Maturity:** strong and fast-rising — **29.7k stars**, 3.4k commits. Backed by a real company: NetBird GmbH, Berlin (started as WireTrustee ~2021–22, founders Misha Bragin & Maycon Santos; **€4M seed** Dec 2024, **$10M Series A** Jan 2026 led by Pace Capital with Nauta, InReach, Antler — [Nauta](https://www.nautacapital.com/news-insights/netbird-10m-series-a), [seed](https://www.nautacapital.com/news-insights/netbird-raises-4m-seed-funding)); security partnership with **CISPA / German BMBF StartUpSecure** since Nov 2022 (per README).
- **Tech:** NAT traversal via WebRTC-style ICE (pion) + STUN + relay fallback — philosophically the same machinery LiveKit uses; optional **Rosenpass post-quantum** key exchange; apps for Linux/Win/macOS/**iOS/Android**/Android TV/Apple TV/pfSense/Synology/Proxmox; web admin UI, SSO via any OIDC IdP, activity + traffic event logging, posture checks.
- **Effort for a non-techie:** NetBird **Cloud** is as easy as Tailscale. **Self-hosted** is heavier than Headscale: management + signal + relay + dashboard + an identity provider on one public VM (2GB RAM, ports 80/443/3478) — but there's a one-script quickstart ([selfhosted guide](https://docs.netbird.io/selfhosted/selfhosted-guide)).
- **Fit for bifrost:** the purist's full-stack choice; nothing Tailscale-only is needed. Current version number **TO-VERIFY** (moves fast).

### Plain WireGuard

- **What:** the protocol itself ([wireguard.com](https://www.wireguard.com/)) — tiny audited codebase, in the Linux kernel since 5.6 (early 2020, [Ars Technica](https://arstechnica.com/gadgets/2020/03/wireguard-vpn-makes-it-to-1-0-0-and-into-the-next-linux-kernel/)), official iOS/Android apps.
- **Maturity:** gold standard, formal analysis exists ([crypto review](https://eprint.iacr.org/2018/080.pdf)).
- **Effort for a non-techie:** trivial for 2–3 fixed peers; bad beyond that — no coordination, so **n·(n−1)/2** key exchanges done by hand, no DNS names, no roaming NAT traversal help, no ACLs/UI.
- **Fit for bifrost:** wrong tool for *one phone + many PCs*; phone roaming on carrier NAT makes manual endpoints painful.

### Others noted (and why they lose)

- **Nebula** (Slack lineage, now Defined Networking) — certificate-based overlay, solid mobile apps, but CA/YAML ceremony and the managed console is commercial; less turnkey for phone+PCs ([defined.net](https://defined.net)).
- **Netmaker** — open-core WireGuard mesh manager; ops-heavy, more server-fleet oriented ([netmaker.io](https://www.netmaker.io)).
- **Innernet** (tonari) — elegant Rust/WireGuard overlay but niche, low activity (**TO-VERIFY** current maintenance).
- **ZeroTier** — great L2 overlay but its core is **BSL-1.1 licensed, not open source**, cloud controller by default ([ZeroTier](https://www.zerotier.com)) → disqualified for an open pillar.

### Comparison table

| | **Tailscale** | **Headscale** (+Tailscale clients) | **NetBird** (self-hosted) | **Plain WireGuard** |
|---|---|---|---|---|
| License | Client BSD-3; **control server proprietary** | **BSD-3**, control 100% yours | Client BSD-3; mgmt/signal/relay **AGPLv3** | Kernel/GPL, all yours |
| Maturity (2026) | 7 yrs, $272M funded, v1.102.x | 44.3k★, v0.29.4 Sep 2026, active, Tailscale-employed maintainer | 29.7k★, Series A Jan 2026, CISPA-linked | Kernel-grade, eternal |
| Company risk | VC-backed SaaS; free tier at their discretion | None (community; Tailscale-blessed) | VC-backed; self-host = no dependency | None |
| Non-techie effort | **Near zero** (install, log in, done) | Moderate (public VPS + config; scripted = easy here) | Moderate-high self-hosted (multi-service + IdP); near-zero on their cloud | Low for 2 peers, painful for many |
| Phone support | **Excellent** (iOS/Android, always-on) | Same official apps | Good native apps | Official apps, manual config |
| NAT traversal / relay | Best-in-class + global DERP | Same clients; DERP self-host extra | ICE/STUN/TURN (WebRTC-style) + relay | Manual endpoints only |
| Discovery / DNS / ACLs | MagicDNS + ACLs, admin console | MagicDNS + ACLs via config file | DNS + groups/rules + **web UI** | None |
| Coordination-server sees | Metadata (see §2), not content | You (self-hosted) | You (self-hosted) | Nobody — no coordination |
| bifrost fit | **Default** | **Sovereign escape hatch** | Purist alternative | Point-fixes only |

---

## 4. Recommendation for bifrost

**Keep Tailscale as the default, with Headscale as the documented sovereign escape hatch; do not go NetBird-first.** Tailscale is the only option that is near-zero-effort on the phone — and the phone is bifrost's center of gravity — while its trust story is strong for a commercial SaaS: WireGuard end-to-end encryption means the coordination server sees topology metadata (public IPs, device inventory, ACLs) but never content, the company discloses incidents with unusual candor, holds SOC 2 Type II plus ongoing Latacora audits, and is well-funded through a 2025 Series C. The "AI/Azure" story checks out as marketing and integrations (their control plane actually runs on AWS), not as something AI-built. The two Tailscale-specific risks — a proprietary control server and VC-funded free-tier economics — are both covered by an unusually good exit: Headscale reimplements the control server under BSD-3, works with the same official phone apps, is actively maintained (v0.29.4, Sep 2026) with a maintainer formally employed by Tailscale itself, so migration is a config flip, not a rebuild. Concretely: run the tailnet locked down (user/device approval on, minimal ACLs, `--no-logs-no-support` on agent PCs, optionally Tailnet Lock, self-hosted DERP if ever needed), keep a one-page Headscale runbook in `docs/` as the break-glass path, and revisit NetBird only if bifrost ever needs a fully self-hosted *control plane with a web UI* — plain WireGuard only for isolated point fixes.

---

## TO-VERIFY ledger

- David Carney's and David Crawshaw's exact pre-Tailscale roles.
- Whether any Tailscale/Latacora audit report is public (currently NDA/DPA-only), and whether any claim exists of AI being used *by* Tailscale in its own security processes.
- Headscale feature-parity details: Tailnet Lock support, embedded DERP server, third-party admin UIs (e.g. headscale-admin) maintenance status.
- NetBird: current exact release version; self-hosted mobile-app onboarding friction details.
- Tailscale: current free-plan device/user limits (check [pricing](https://tailscale.com/pricing) at time of use); date of general availability (post-Dec-2019 beta).
- Innernet maintenance status.

## Sources

- [Wikipedia: Tailscale](https://en.wikipedia.org/wiki/Tailscale) · [TechCrunch Series A](https://techcrunch.com/2020/11/10/tailscale-raises-12-million-for-its-wireguard-based-corporate-vpn/) · [TechCrunch Series B](https://techcrunch.com/2022/05/04/tailscale-lands-100-million-to-transform-enterprise-vpns-with-mesh-technology/) · [Tailscale Series C](https://tailscale.com/blog/series-c) · [Tailscale company page](https://tailscale.com/company)
- [Tailscale security](https://tailscale.com/security) · [Security bulletins](https://tailscale.com/security-bulletins) · [Security policies repo](https://github.com/tailscale/security-policies) · [Log opt-out kb/1011](https://tailscale.com/kb/1011/log-mesh-traffic) · [Tailnet Lock kb/1226](https://tailscale.com/kb/1226/tailnet-lock) · [Custom DERP kb/1118](https://tailscale.com/kb/1118/custom-derp-servers)
- [github.com/tailscale/tailscale](https://github.com/tailscale/tailscale) (BSD-3 client + DERP) · [WireGuard](https://www.wireguard.com/) · [WireGuard crypto review](https://eprint.iacr.org/2018/080.pdf) · [Ars: WireGuard 1.0/kernel](https://arstechnica.com/gadgets/2020/03/wireguard-vpn-makes-it-to-1-0-0-and-into-the-next-linux-kernel/)
- [github.com/juanfont/headscale](https://github.com/juanfont/headscale) + [release v0.29.4](https://github.com/juanfont/headscale/releases/tag/v0.29.4) + [Tailscale open-source post](https://tailscale.com/blog/opensource)
- [github.com/netbirdio/netbird](https://github.com/netbirdio/netbird) · [NetBird selfhosted guide](https://docs.netbird.io/selfhosted/selfhosted-guide) · [Nauta: $10M Series A](https://www.nautacapital.com/news-insights/netbird-10m-series-a) · [Nauta: €4M seed](https://www.nautacapital.com/news-insights/netbird-raises-4m-seed-funding)
- AI/Azure angle: [Secure AI Agent Connectivity](https://tailscale.com/use-cases/securing-ai) · [Aperture](https://aperture.tailscale.com) · [WorkOS: Tailscale AI gateway](https://workos.com/blog/tailscale-ai-gateway-agents-identity) · [Azure reference architecture](https://tailscale.com/docs/reference/reference-architectures/azure)
