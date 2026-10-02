# Veraldar — legal memo: entity, token, GDPR, AI liability, IP strategy

Status: ACTIVE ADVICE — wake memo, triggered by user questions 10-01 (relayed via product session).
Author: ORG session. Standing decision of 09-28 unchanged: **no legal entity before launch**.
Scope: Switzerland (domicile), EU/CH users (GDPR/FADP), FOSS distribution (AGPL-3.0).
Every number marked **[TO-VERIFY]** was not confirmed against a primary source today; facts
without the mark were verified today against ige.ch (trademark fees) or are settled law.

## 0. TL;DR

| Question | Answer |
|---|---|
| Token? | **No.** A buyable token is either an asset token (securities law, CHF 50k+ compliance) or a payment token (AMLA/KYC duty). Kills the brand. Sponsors/OpenCollective deliver the same "be part of it" with zero regulatory surface. Revisit only post-traction under the conditions in §1.4. |
| Swiss company? | **Not yet, Verein when triggered.** Legal minimum 2 members (we want 3), no capital, statutes can be free, register entry optional, total cost CHF 0–3k one-off + ~CHF 200–500/yr. Trigger: money getting real or a counterparty needing formality (§6). |
| GDPR? | **Tiny — and a feature.** Compliance subject: RGPD (EU) + revFADP (CH). Site: privacy page + mentions légales (host **Infomaniak, Switzerland** = data residency in an adequate country). No cookies/no trackers → **no consent banner, by design**. PWA: self-hosted single-user = user is controller of their own data → veraldar out of scope. Push consent = the browser's own permission prompt. Launch checklist in §3.7. |
| OpenAI/Meta-style liability? | **Doesn't attach.** They train models on scraped data; we train nothing, host nothing public, touch no one's content (tailnet-private, user's own key, user's own box). AGPL no-warranty + no-sale + private network = the liability firewall. Keep the architecture as the legal strategy. |
| Patents? | **No.** Software-as-such is unpatentable in CH/EU practice, useless defensively at our scale, and trade secrets contradict a public AGPL repo. Copyright is automatic and already handled by AGPL + DCO. **Trademark is the only filing worth money:** CH word marks for Veraldar + Bifrost ≈ **CHF 700 total** (verified fee schedule). |

---

## 1. Token — why no, and the door's exact conditions

### 1.1 The Swiss framework (FINMA)
FINMA's ICO guidelines (16.02.2018, supplemented 04/2019 on stable coins — **[TO-VERIFY: official current
document URL]**) sort tokens into classes; classes decide the regime:

- **Payment token** — usable as means of payment/transfer. An ICO of payment tokens makes the
  organizer a financial intermediary under **AMLA** → KYC on every buyer, SRO/self-regulation
  affiliation (VQF; setup ~CHF 5–10k, ongoing ~CHF 2–5k/yr **[TO-VERIFY: fee schedule]**) or a
  full license.
- **Utility token** — grants access to a digital service, functional at issuance, no investment
  purpose → typically **not** a security. But the moment buyers are promised/expecting profit, or
  the function doesn't exist yet (pre-sale), FINMA reads it as **asset token**.
- **Asset token** — profit share, dividend, claim, "in the journey" appreciation → **security**
  under FIDLEG: prospectus duty (exemptions won't fit a public token sale; prospectus liability
  is personal and criminal-tinged), possibly collective-investment law → banking/securities-firm
  authorization (capital in the millions, months of process).
- Hybrids are classified by their *most* regulated function. There is no "supporter" class.

### 1.2 What the user's ask actually is
"Buy safely to be part of the journey" = people give money expecting future belonging/value.
That description is **payment + asset**, the two worst classes. "Safely" is the tell: safety in
CH token sales comes from legal opinions, whitelisting, KYC — a compliance budget, not a feature.

### 1.3 Non-regulatory cost: the brand
Brand law §3 (docs/brand/brand.md, binding): free for everyone, your hardware, your words.
A token introduces: speculators with profit expectations, securities-liability pressure to
*restrict* freedom (geo-blocks, KYC walls, delisting risk), and a permanent "is veraldar a
crypto project?" anchor. It converts the strongest asset — trust — into the weakest.

### 1.4 IF ever pursued (post-traction only), the minimal clean shape
1. **Utility only, function already live**: token grants a real, working product function at
   issuance (e.g., priority support queue, feature-vote weight). No profit right, no buyback,
   no staking/rewards, no appreciation talk — ever, anywhere, including by moderators.
2. **No pre-sale**: distribute only after the function exists (removes the "investment" reading).
3. **CH legal opinion** (FINMA classification) before any code exists: CHF 15–30k **[TO-VERIFY: market rates]**.
4. **AMLA check**: if the token can be transferred person-to-person it drifts toward payment
   token → SRO membership + KYC or restrict transfers (soulbound-style).
5. **Issuer = the Verein, only if statutes' purpose covers it** (they currently shouldn't — that
   is a feature). Otherwise a separate vehicle → separate memo.
6. Marketing silence rule: the org never quotes a price, never lists, never airdrops to insiders.

**Honest recommendation: never.** Sponsorships deliver "be part of the journey" (§2.3) with
zero regulatory surface. This section exists so that if the question returns at traction, the
answer starts from conditions, not vibes.

---

## 2. Swiss entity — forms, facts, costs

### 2.1 Forms considered
| Form | Verdict | Why |
|---|---|---|
| Einzelunternehmen (sole prop.) | **No once strangers rely on us** | Free, but owner liable with **private assets, unlimited** (OR). Register duty at CHF 100k revenue. Fine for a dormant hobby, wrong for anything users depend on. |
| **Verein (Art. 60–79 ZGB)** | **The form.** | Built for exactly us: ideal-purpose org, no minimum capital, members not liable (Art. 75a ZGB pins fault-liability on the *board*, manageable), register entry **voluntary** (mandatory only if running a commercial business — we won't; revenue = donations/sponsorship). |
| GmbH / AG / Stiftung | No | Capital (GmbH CHF 20k, AG CHF 100k), auditor/accounting duties, commercial purpose contradicts free-for-everyone. Overkill until there is commercial activity to shield — which brand law says we don't want. |

### 2.2 Verein facts (settled law)
- **Members:** legal minimum **2**; standing analysis says found with **3** (credibility + board redundancy).
- **Statutes must fix:** purpose (promote free/self-hosted software — ideal purpose), membership
  admission/termination, bodies (general meeting = supreme; board ≥1, **recommend 3** with
  defined quorum), notice periods, **liability limitation clause** (member/board liability limited
  to intent/gross negligence), **dissolution clause** (assets must go to a tax-exempt purpose —
  e.g., another free-software org; never to members).
- **Register:** entry optional for non-commercial Vereine. Entry costs ~CHF 100–300 **[TO-VERIFY:
  canton-dependent]** and requires a CH-resident signatory on the board **[TO-VERIFY: practice]**.
  Even unregistered, a Verein has enough legal capacity for a bank account and contracts.
- **Tax:** ideal-purpose Vereine are income/tax exempt (federal + cantonal) if purpose and
  actual practice are non-economic; unrelated business income above small thresholds gets taxed
  **[TO-VERIFY: current UABI thresholds]**. Donation deductibility for donors needs a
  public-benefit ruling — nice-to-have, not needed for CHF 0.1–10k/yr scale.
- **Accounting:** cash-basis simple books suffice for a non-commercial Verein; AGM once a year
  with minutes. Board carries Art. 75a ZGB fault-liability → policy: never take debt, never
  sign leases, never hold user data (see §3–4).
- **Costs (realistic):** statutes from VSH/zefix templates + own adaptation: **CHF 0–500**;
  lawyer-reviewed: CHF 1.5–3k **[TO-VERIFY: market rates]**; register ~CHF 100–300; recurring:
  CHF 200–500/yr (paper, fees, small accounting help) + a 1-hour AGM. Timeline: 1–4 weeks.

### 2.3 Money path without any entity (today's answer)
- **OpenCollective / GitHub Sponsors / Polar**: the fiscal host *is* the legal wrapper, holds
  funds, pays expenses, shows a public ledger (which is also brand-positive). Host fee ~5–10%
  **[TO-VERIFY: current pricing]**.
- Cross-over point: when donations ≳ **CHF 5–10k/yr**, the host's percentage exceeds the
  Verein's fixed costs — that is the economic trigger; the counterparty trigger (§6 #2) can
  fire earlier.

---

## 3. RGPD (+ CH-revFADP) — veraldar.org and the PWA, concretely

Terminology for all comms: **RGPD** (Règlement Général sur la Protection des Données) is the
French/European name for GDPR; Switzerland's equivalent is the **revFADP** (in force 01.09.2023).
The obligations are near-equivalent at our scale: one compliance pass satisfies both.
Two distinct compliance subjects — do not conflate them:
- **veraldar.org** = the public org website (this is where RGPD duties for *the org* live);
- **the bifrost PWA** = served by each user's own box, never by veraldar.org → different regime (§3.3).

### 3.1 Privacy policy + mentions légales (veraldar.org)
One page can carry both (linked in the footer): RGPD Art. 13 information **and** the legal notice.

**Mentions légales** (FR law habit; CH has the same duty as *Impressumspflicht*, UWG Art. 3 —
every CH website offering services must name the operator):
- **Editor/publisher (controller):** Veraldar — legal form per §2 (until the Verein exists: the
  individual founder, name + address; after: "Veraldar, Verein nach Schweizer Recht, address").
- **Contact:** an email that a human reads (e.g., hello@veraldar.org).
- **Publication director / responsible:** same as editor (one-person show — say so).
- **Host:** **Infomaniak (Switzerland)** — Infomaniak SA, Geneva **[TO-VERIFY: exact registered
  address from the contract, e.g. Rue Eugène-Marziano 25, 1227 Les Acacias]**. Say it plainly:
  host and datacenter location Switzerland.
- **Identification:** no VAT number yet (donations-only, no commercial activity); add when one exists.

**Data-residency angle (say it out loud — it is an asset):** Infomaniak hosts in **Swiss
datacenters**; Switzerland is an **adequate** third country under GDPR (settled EU decision,
reaffirmed after the revFADP). Result: no transfer saga, no standard contractual clauses needed
— "your data stays in Switzerland" is both true and simple. Infomaniak itself markets
RGPD-compliance/no-data-resale **[TO-VERIFY: confirm in the hosting contract — no-logs/no-resale
clauses, and that only CH datacenters are used for our plan]**.

**Privacy page content (RGPD Art. 13 checklist):** controller identity (→ mentions légales),
data processed (§3.2), purposes (site security), legal basis (legitimate interest),
retention (≤14 days for logs), recipients (none, beyond the host), transfers (none — CH hosting),
rights (access/rectification/erasure → the contact email), right to lodge a complaint (CH FDPIC;
EU users: their local authority), and that no cookies/tracking exist (→ §3.2).

### 3.2 Cookies/consent — NO banner, stated as a design principle to defend
The site ships **no cookies, no trackers, no analytics, no ads, no third-party requests**
(fonts self-hosted/inlined, no CDN widgets). ePrivacy/RGPD consent duties only trigger when
something is stored or read on the user's device beyond strictly necessary — we store nothing
→ **no consent banner is required, and none will be shipped.**
Defend this as a **design principle, not a gap**: every PR that adds a script, font, embed, or
analytics tag to veraldar.org re-opens RGPD consent review and adds a banner — the rule is
"if it needs a banner, it doesn't ship." Server logs (host-side, IP addresses) are RGPD
personal data: keep retention short (≤14 days), purpose = security/abuse only, and cover them
in the privacy page. That is the entire site compliance.

### 3.3 PWA surface — what bifrost touches, and who is controller
The PWA is **served by the user's own box** (their instance), not by veraldar.org. Data it touches:

| Data item | Where it lives | Who is controller | RGPD reading |
|---|---|---|---|
| Push subscription endpoint (vendor URL + keys) | User's own instance DB | **The user** (their box) | Self-hosted single-user → household scope, out of the regulation's field |
| Diagnostics: UA, screen, timezone, IP (`.diag` logs) | Local to the user's box | The user | Same — nothing is sent to veraldar (there is **no telemetry channel at all**) |
| Service-worker / local caches | The user's device | The user | On-device data, not org processing |
| Voice audio → STT/TTS | User's LAN (speech models on their machine) | The user | Never leaves the machine — no transfer exists to regulate |
| LLM traffic | User's own key → provider of *their* choice | The user vis-à-vis that provider | veraldar is not a party; no processor role |

**The compliance reading:** for a **self-hosted single-user instance**, the user is the
controller of their own data (GDPR Art. 2(2)(c) household exemption, recital 18) — **veraldar
the org processes nothing and is effectively out of scope**. This is only true because there
is **no telemetry**: the moment any instance phones home (crash reports, analytics, version
pings), veraldar becomes a controller for that data and the whole §3.7 checklist grows a
PWA chapter. Keep "no telemetry" a **hard design principle** alongside "no cookies".
**Public org site (veraldar.org)** never runs the PWA — its surface is §3.1–3.2 only.

### 3.4 Push notifications — consent is already built in
Web Push cannot exist without the **browser's own permission prompt** (explicit, informed,
specific, refusable — exactly what RGPD Art. 4(11)/ePrivacy want from consent). Subscriptions
are revocable in browser settings and by deleting the subscription on the instance. One policy
line to state on the site and keep: **push is used only for the user's own instance events;
veraldar sends no marketing push, ever.** Note for docs: iOS requires install-to-home-screen
for PWA push (platform rule, not law).

### 3.5 Accessibility — pointer (RGAA/WCAG)
French-facing sites point at **RGAA** (Référentiel Général d'Amélioration de l'Accessibilité),
which transposes **WCAG 2.1 level AA** (RGAA 4.1.x). Legal obligation in France binds public
bodies and large companies (net revenue > €250M) with an accessibility declaration; for
veraldar it is **voluntary good practice — adopt WCAG 2.1 AA as the target**, cheap for a
text-first monospace site: semantic HTML, aria-labels, `prefers-reduced-motion` support,
visible focus, AA contrast on primary text (current palette spot-checks pass on body/dim text
**[spot-check again if colors change]**). Publish an accessibility statement when the site
launches (one paragraph: target level, known gaps, contact).

### 3.6 Marketing handoff — "RGPD-friendly by architecture" is a feature
Hand this to comms/launch as a stated feature of veraldar.org + bifrost, not fine print:
- **Positioning line:** *No accounts. No trackers. No cookies. Nothing to consent to — your
  voice never leaves your machine.*
- **Site facts list** (veraldar.org product card / footer, one line to add alongside the
  existing "audio never leaves the LAN"): `privacy: no cookies, no analytics, no telemetry —
  RGPD-friendly by architecture`.
- **Why it lands in Europe:** post-Schrems banner fatigue is universal; "a tool with no consent
  banner because there is nothing to consent to" is a differentiator AI products cannot copy
  without re-architecting. Infomaniak CH hosting + tailnet-only PWA = the whole story is true,
  verifiable from the public repo.
- **Rule for comms:** never claim "anonymous" or "GDPR certified" (no such certification for
  us); claim the architecture, which is checkable.

### 3.7 Website-launch compliance checklist (veraldar.org)
- [ ] **Privacy page** live (§3.1 content list; Art. 13 items; linked from footer).
- [ ] **Mentions légales / Impressum** live: editor, contact, publication director, host
      (Infomaniak SA, CH), registration identifiers when they exist.
- [ ] **No-cookie declaration** (one line on the privacy page: "no cookies, no trackers, no
      analytics — nothing is stored on your device") — and re-verify at launch: zero
      `Set-Cookie`, zero third-party requests in the network tab.
- [ ] **Host info** published (Infomaniak, Swiss datacenters) + contract checked for
      no-resale/no-logs clauses **[TO-VERIFY]**.
- [ ] Server-log retention configured ≤14 days.
- [ ] Newsletter (if/when): double opt-in + proof record + unsubscribe + notice section —
      before first send.
- [ ] Accessibility statement (WCAG 2.1 AA target) published.
- [ ] Contact address monitored (privacy/access/deletion requests are answered by a human).

---

## 4. Liability for "what OpenAI/Meta do" — why it doesn't attach (yet)

The exposure those companies fight over comes from **training models on copyrighted data** and
**operating public AI services**. Veraldar does neither:

1. **No training, no dataset.** Getty v Stability / NYT v OpenAI-type claims target the
   trainers of models and the hosts of outputs-at-scale. Bifrost: user brings their own LLM key;
   upstream provider's terms govern the model. STT/TTS models run **on the user's LAN**, fetched
   by the user. We ship no weights. (Swiss TDM exception, URG — **[TO-VERIFY: exact article,
   24b]** — is irrelevant for the same reason.)
2. **Nothing public.** Tailnet-only architecture: no public intermediary service, no hosted
   user content, therefore no DSA-style platform duties and no notice-and-takedown surface.
   The architecture *is* the legal strategy — every feature that makes bifrost more "public
   cloud"-like re-opens this file (see trigger §6 #4).
3. **No contract of sale.** AGPL-3.0 §7 disclaims warranty and liability to the maximum extent
   law allows; Swiss delict (OR 41) is fault-based — with free distribution and no assumed duty
   of care toward end users' model outputs, residual risk is negligible at our scale. What a
   disclaimer cannot exclude: intent and gross negligence → ordinary engineering hygiene (don't
   ship known-dangerous defaults) is the only real duty.
4. **EU AI Act:** duties sit on providers of GPAI models and on deployers of high-risk systems;
   a self-hosted voice remote for a coding agent is neither. **[TO-VERIFY: re-read when any
   hosted/multi-user feature appears]** — hosting models *for others* would be a different world.

---

## 5. Patent / copyright / trademark strategy

### 5.1 Patents — no
- CH: computer programs **as such** are not inventions (PatG; EPC Art. 52 practice); a CH
  national patent gets **no substantive examination** (weak title); real protection = EP route,
  CHF 30k+ **[TO-VERIFY: ranges]** — money to burn for an org whose artifacts are public anyway.
- Any filed patent would have to stay secret 18 months (novelty) while the AGPL repo publishes
  everything — internally contradictory.
- Trade secrets: same contradiction. **Strategy: publish fast, publish always.**

### 5.2 Copyright — automatic, already handled
- Arises on creation (Berne), no registration exists in CH. Enforcement posture: **AGPL-3.0**
  (the network clause *is* the moat: forks of a service must publish), **SPDX headers** per
  file, LICENSE present, commits authored.
- Contributions: **DCO sign-off** (inbound=outbound), **no CLA** — a CLA would make veraldar
  the sole licensor, i.e., the exact power position "free for everyone" refuses. Note the
  residual truth honestly: dual-licensing/commercial relicensing is then *permanently off the
  table*. That is the brand, priced in.

### 5.3 Trademark — the only filing worth money (fees verified at ige.ch, 01.07.2024 schedule)
- **CH word marks** for `Veraldar` (invented → strong) and `Bifrost` (mythological common term
  → weaker, prior tech uses likely — **[TO-VERIFY: Swissreg + TMview conflict search before
  filing]**).
- Fees (IPI, status 01.07.2024): filing **CHF 450 − CHF 100 e-discount = CHF 350** per mark,
  **including up to 3 Nice classes** (surcharge CHF 100/class from the 4th); expedited exam
  +CHF 400; **renewal CHF 550 / 10 years**, renewable indefinitely; non-use cancellation risk
  after 5 years of idle registration — a used repo+site satisfies use.
- Classes: **9** (downloadable software) + **42** (SaaS/software dev services) + optionally
  **38** (telecom) — 3 classes stay inside the base fee.
- Process: e-filing (e-trademark.ige.ch) → formal + absolute-grounds examination → registration,
  typically a few months **[TO-VERIFY: current duration]**. No attorney needed for clean word
  marks; ~CHF 700 total for both names buys CH-wide priority. EU (EUTM) only when traction is
  EU-visible **[TO-VERIFY: EUIPO current fees]**.
- Holder should be the **Verein** (one more reason §2 fires before §5.3 does).

---

## 6. Trigger table — what event makes each action worth its cost

| # | Trigger (any one) | Action | One-off | Recurring | Not worth before |
|---|---|---|---|---|---|
| 1 | First donation/sponsorship of any size | Turn on GitHub Sponsors / OpenCollective | 0 | ~5–10% of inflow **[TO-VERIFY]** | — (worth it from CHF 1) |
| 2 | (a) inflow ≳ CHF 5–10k/yr, (b) an institution/counterparty needs a legal counterparty, (c) ≥2 external contributors demand governance voice, (d) trademark filings ready and need a holder | **Found Verein**: 3 members, statutes (liability + dissolution clauses), optional register entry | CHF 0–3k | CHF 200–500 + AGM | No real money, no counterparty, no contributors |
| 3 | First newsletter send / first comms channel collecting emails | Website compliance checklist §3.7 (privacy page + mentions légales) + double opt-in + unsubscribe (listmonk on box) | ~0 | ~0 | Before that first send |
| 4 | Anything becomes public & hosted by veraldar (public instance, hosted models, public content feeds) | Re-open §3/§4: platform duties, AI-Act re-check, maybe entity upgrade review | review | — | Anything in the current tailnet-only design |
| 5 | A third party commercializes the names, or community confusion appears | CH trademark filings: Veraldar + Bifrost, 3 classes, e-file | CHF 700 | CHF 550/10y per mark | No users outside tailnet; do Swissreg search first |
| 6 | Someone seriously proposes a token again | §1.4 gate: utility-only, live function, CH legal opinion, AMLA path — otherwise decline in writing | CHF 15–30k if pursued | KYC/SRO if payment-like | Any time before major traction; likely forever |

---

## 7. TO-VERIFY ledger (fix when next awake)
1. FINMA ICO guidelines + 04/2019 supplement — official current URLs (fetch 404'd today).
2. VQF (or other SRO) membership fee schedule.
3. Zefix/commercial-register fee for Verein entry; CH-residency rule for board signatory.
4. Swiss banks that onboard small Vereine smoothly (PostFinance? Raiffeisen?).
5. OpenCollective (or alternative fiscal host) current fee %.
6. IPI: typical registration duration for a clean CH word mark.
7. Swissreg/TMview conflict search: Veraldar, Bifrost.
8. EUTM current fee schedule (EUIPO).
9. URG TDM exception article number; UABI tax thresholds for ideal-purpose Vereine.
10. Infomaniak contract: registered address for mentions légales, no-logs/no-resale clauses,
    confirmation only-Swiss datacenters serve our plan.
11. RGAA/WCAG target drift (WCAG 2.2 is out; RGAA updates follow it) — re-check before
    publishing the accessibility statement.

## 8. Swiss-made label check (verified at swissmadesoftware.org, 10-01)

**Official "swiss made software" label** (swiss made software GmbH — private label, membership
required; unapproved logo use prohibited):
1. **≥60% of production costs incurred in CH** (software ≈ professional salaries; apprentices
   excluded);
2. **most significant part of development in CH**;
3. **company based in CH and registered in the commercial register** (legal basis MSchG/TmPA
   Art. 48–48d, SR 232.11; false "Swiss-made" claims are punishable, Art. 61 ff).
Costs: **Level 1 CHF 120/yr** (logo + directory), Level 2 CHF 550/yr, calendar-year membership,
logo must backlink to swissmadesoftware.org; separate "swiss hosting" logo exists (CH data
storage) and would fit veraldar.org-on-Infomaniak later.

**Veraldar today:** substance passes (all development in CH, ~100% of costs in CH), but
**criterion 3 fails** — no legal entity and no commercial-register entry yet → **the label may
not be used today** (nor the logo, without membership). **After** the Verein exists (§2) with
register entry, Veraldar qualifies on all three criteria; then join at Level 1 (CHF 120/yr)
if the label is wanted. Note: the label speaks of a *company* in the register — a registered
Verein should qualify **[TO-VERIFY: label operator accepts eingetragene Vereine]**.

**Honest smaller claim, usable NOW:** *"Built in Switzerland"* / *"entwickelt in der Schweiz"* —
a factual development-location statement. Requirements: it must simply be **true and not
misleading** (MSchG Art. 48 ff, UWG Art. 3). It is: CH-resident developer, all dev on CH
hardware. Rules for comms: no Swiss flag/coat-of-arms imagery (state-controlled symbols),
no unqualified "Swiss made" or the label logo, no implying CH *hosting* of bifrost (users
self-host anywhere — only veraldar.org itself is Infomaniak/CH). Recommended wording:
**"built in Switzerland · hosted on Infomaniak, Swiss datacenters"** for the site, and simply
"built in Switzerland" for bifrost.

## 9. TO-VERIFY ledger additions from §8
12. Does the label operator (swiss made software GmbH) accept a registered Verein
    (eingetragener Verein) as member, given criterion "registered in the commercial register"?
    Email contact@swissmadesoftware.org when §2 fires.
13. MSchG/TmPA Art. 48–48d exact wording for services vs products (SwissnessOrd SR 941.301
    interplay) — re-read before any stronger claim than "built in Switzerland".
14. swiss hosting label criteria in full (for veraldar.org-on-Infomaniak, if ever wanted).

*Dormancy note: this memo stands until a §6 trigger fires or facts in §7/§9 change materially.
No action items are open today. — ORG session, 10-01.*
