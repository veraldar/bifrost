# Veraldar — funding setup: the user-only activation checklist

Status: ACTIVE (one-shot) — FUNDING-SETUP wake, user approved the ladder 10-01.
Companion to `docs/org/legal-memo.md` (§2 entity ladder, §6 trigger table). Nothing here
creates a legal entity; both rails below are entity-free by design.
Every step here is **user-only** (identity, bank, KYC, approval clicks). Sessions can draft
tier copy/README text on request, but can click none of this.
Facts not carried over from the legal memo are marked **[TO-VERIFY]** — numbers are indicative,
check the live page during the step.

## Rail 0 — prerequisite: public presence (~1–2 h, do first)

- [ ] GitHub Sponsors and OpenCollective reviewers look for a real, public project. Bifrost
      itself is tailnet-private, so establish the minimum public surface first:
  - [ ] Make `veraldar` GitHub org public-facing: publish the **veraldar.org** repo (the static
        site — AGPL, no secrets) and/or a **public bifrost mirror/release repo** (AGPL — a
        tarball of the repo with docs is enough; secrets stay in `.env`/`docs/local.md`, already
        gitignored).
  - [ ] README + LICENSE (AGPL-3.0) + a screenshot or the site link — one honest page of
        "what this is" (the wireframe copy is ready to reuse).
- [ ] Time estimate: 1–2 h (mostly writing the README). Wait: none.

## Rail 1 — GitHub Sponsors (~30 min active + 2–14 days approval)

- [ ] **Check eligibility** at github.com/sponsors: account in good standing with **public
      repo/contribution history** (Rail 0 is exactly this). Switzerland is a supported payout
      region via Stripe Connect **[TO-VERIFY: region list at signup]**.
- [ ] **Apply** ("Get sponsored") → GitHub reviews the profile. Expected wait: **2–14 days**
      **[TO-VERIFY]**; rejections are usually "not enough public history" → strengthen Rail 0
      and reapply.
- [ ] **Stripe Connect onboarding** (same flow, after approval): identity document, mobile
      number, **bank account (IBAN)**, tax residency → payouts land in the **personal** bank
      account (no entity exists — correct; sponsorship income is personal taxable income
      until a Verein exists, see legal memo §2).
- [ ] **Configure the profile**: one-time "Sponsor" button + 2–3 tiers (keep tier copy aligned
      with brand copy law — "support the journey", **no rewards, no returns, no tokens**,
      legal memo §1).
- [ ] **Wire it in**: add the Sponsor link to the public repo README + veraldar.org footer.
- [ ] Total active time: ~30 min. First payout: after approval + Stripe setup, paid out per
      Stripe schedule (weekly/monthly) **[TO-VERIFY]**.

## Rail 2 — OpenCollective collective (~45 min active + days of verification)

- [ ] Create account at opencollective.com (GitHub login) → **Create a Collective** →
      name `Veraldar`, slug `veraldar`, goal + description (reuse wireframe copy).
- [ ] **Pick the fiscal host** — this is the one real decision (the host is the legal wrapper,
      legal memo §2.3):
      - Primary candidate: **Open Source Collective** (the OSS-focused host; host fee ~5%,
        platform fee 0% since 2023, card processing extra **[TO-VERIFY: current fee table]**).
      - If OSC refuses (acceptance is per-host policy): Social Change Nest / Open Collective
        Europe as fallbacks **[TO-VERIFY: current hosts + fees]**.
- [ ] **Verification** (host-side): connect the GitHub org, describe the project, identity
      check of the admin (you). Expected wait: **1–7 days** **[TO-VERIFY]**.
- [ ] No personal bank needed — the **host holds the funds** and pays expenses (that is the
      point; it is also why fees exist). Money is held for the project, not you personally.
- [ ] **Wire it in**: same footer/README links; decide the primary rail (recommend: OC as the
      org-shaped "back Veraldar" button, GitHub Sponsors as the personal "tip the author"
      button — both fine to show).
- [ ] Total active time: ~45 min.

## Rail 3 — Verein trigger checklist (when to outgrow the rails)

Fire the process in legal memo **§2.2 (facts/costs) + §6 #2 (trigger table)** when **any** of:

- [ ] Sustained support > **CHF ~400–800/month** (≈ CHF 5–10k/yr — where the host's ~5–10%
      take exceeds the Verein's CHF 200–500/yr fixed costs; pick the exact X at the moment,
      memo leaves it a band on purpose).
- [ ] **First grant / institutional money** appears (they need a legal counterparty + invoice).
- [ ] **≥2 external contributors** demand governance voice (3 members = founding board).
- [ ] A counterparty needs formality (trademark filing holder, EU grant consortium, fiscal
      host refuses to keep hosting).

Then (user steps, in order):
1. Recruit 2 co-founders willing to be Verein members/board (must trust them — board carries
   fault-liability, memo §2.2).
2. Draft statutes from a VSH/zefix template: ideal purpose, liability-limitation clause,
   dissolution-gives-assets-to-free-software clause (memo §2.2 has the required clauses).
3. Founding general meeting (3 members, minutes) → optionally commercial-register entry
   (~CHF 100–300) → open Verein bank account.
4. Move rails: OC collective re-hosts to the Verein (OC supports org-hosted collectives) or
   GitHub Sponsors converts to org sponsorship; verify tax-exempt status with the canton
   (memo §2.2).

## Order of operations (one line)

Rail 0 → Rail 1 → Rail 2 in the same sitting if desired (~3 h total active), Rail 3 only on a
trigger. No entity, no token, no new obligations created today.

*Dormancy note: this checklist is complete until the user reports "money arrived" (→ update
§6 ladder) or a Rail 3 trigger fires. — ORG session, 10-01.*
