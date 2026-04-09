# Website Robustness Roadmap

## Goal

Turn the website into a reliable, production-safe league hub that can support nightly player traffic, admin operations, website-native score submission, trade workflows, and future player-facing features without constant fragile patching.

This roadmap is focused on practical hardening for a league-sized app:

- safer deploys
- clearer code ownership
- more predictable API behavior
- fewer hidden regressions when new features are added

## Current Reality

The site now supports:

- Discord OAuth website login
- linked manager accounts
- RPCN / Zamboni tag capture and validation
- mobile-friendly player dashboard entry
- website-native eligible games
- direct score submission
- Zamboni-assisted score matching with manual fallback
- admin approval workflows
- pending review UI
- trade proposal and review flows
- Discord bot posting and notification integration

That means the site is no longer just admin tooling. It is now a real multi-user product surface.

It also means the current architecture is showing strain:

- `app.js` is getting large and multi-purpose
- player portal, admin tools, and public site behaviors are coupled together
- some deployment assumptions were hardcoded
- missing API routes could fall through to SPA HTML
- repeated external lookups can get noisy and expensive
- debugging becomes harder because failures can look like frontend bugs, backend bugs, or deploy/config bugs

## Guiding Principles

### 1. Keep the user flows simple

The player experience should remain:

- fast
- mobile-friendly
- low-friction
- resilient to Zamboni failures

### 2. Make writes targeted, not global

Player-facing actions should not depend on rewriting the full league state blob unless absolutely necessary.

Prefer explicit server operations such as:

- link this user
- fetch my games
- submit this score
- create this trade offer
- respond to this trade offer

### 3. Protect correctness before scale

Thirty nightly users is not large infra scale, but it is enough that stale state, race conditions, caching mistakes, and partial failures will become visible.

### 4. Harden incrementally

Do not rewrite the entire app at once. Improve the parts that affect real user workflows first.

### 5. Fail loudly and predictably

Unknown API routes, expired sessions, invalid links, and external API failures should produce explicit, diagnosable errors.

Never silently fall into:

- SPA HTML for missing API routes
- generic frontend parse failures
- unclear user-facing states

### 6. Prefer separation by responsibility

The public dashboard, admin tools, player portal, and Discord notification layer should be able to evolve without constantly breaking each other.

## Immediate Problems To Solve

These are the practical robustness issues already visible in the current codebase:

- **[deployment assumptions]**
  - hardcoded app path assumptions like `/league`
  - localhost-oriented defaults in bot/server config

- **[API safety]**
  - unknown API routes must never fall through to `index.html`
  - frontend fetch paths must not assume JSON blindly

- **[frontend size and coupling]**
  - `app.js` now owns too many responsibilities
  - portal, admin, public dashboard, and trade UI are tightly mixed

- **[external lookup noise]**
  - repeated Zamboni lookups can multiply quickly
  - caching and invalidation rules are not yet explicit enough

- **[operational debugging]**
  - some failures require too much guesswork to isolate
  - logs and startup validation should make configuration issues obvious

- **[legacy surface area]**
  - older portal routes and newer portal routes both exist
  - older paths can create confusion even if mostly unused

- **[slop and patch residue]**
  - debug logging added during firefighting can linger too long
  - temporary compatibility fixes can become permanent clutter
  - dead helpers, duplicated flows, and abandoned code paths make the app harder to trust

## Phase 1 — Deployment and Runtime Safety

### Objective

Make the app safe to deploy and safer to debug before doing deeper refactors.

### Work

#### 1. App base path and URL hygiene

- standardize `APP_BASE_PATH` usage for website redirects
- remove hardcoded `/league` assumptions from active flows
- document when to use:
  - `APP_BASE_PATH`
  - `APP_URL`
  - `API_BASE`
  - `DISCORD_REDIRECT_URI`

#### 2. Safe API fallback behavior

- unknown `/api/*` routes must return JSON 404s
- frontend fetch helpers should check content type before parsing JSON when needed
- make user-facing errors more explicit for auth, missing routes, and conflicts

#### 3. Startup validation

- warn clearly if critical env vars are missing
- identify invalid OAuth config at startup instead of at runtime where possible
- highlight suspicious defaults like localhost values in non-dev environments

#### 4. Session and auth safety

- require a stable `FLASK_SECRET_KEY`
- make session expiry behavior explicit in UI
- separate player portal auth assumptions from admin auth assumptions

### Definition of done

- deploy path is configurable
- bad API paths fail as JSON, not HTML
- portal login redirects do not assume one environment
- startup logs make config mistakes obvious

## Phase 2 — Player Portal Stability

### Objective

Make the portal reliable enough that players can use it nightly without weird edge-case failures.

### Work

#### 1. Score flow hardening

- validate eligibility again at submit time
- reject already-scored games cleanly
- show conflict states clearly in the portal
- preserve manual score entry as the guaranteed fallback

#### 2. Trade flow hardening

- unify how portal trade data is fetched and rendered
- show explicit empty/loading/error states
- keep badge counts and modal views consistent
- make manager/team resolution explicit instead of inferred from fragile client state

#### 3. External lookup discipline

- audit all automatic calls to `/api/v2/me/score/matches/*`
- reduce repeated match lookup churn on re-render
- debounce or gate prefetch behavior
- add short-lived server-side memoization for repeated Zamboni player/history lookups

#### 4. Portal state cleanup

- make `_portalSession` and `_portalGames` ownership clearer
- standardize when portal state is refreshed
- avoid duplicated fetches on repeated renders

### Definition of done

- login, linking, score submission, and `My Trades` work predictably
- repeated renders do not trigger noisy duplicate fetch bursts
- failures degrade to understandable UI states

## Phase 3 — Frontend Structure and Maintainability

### Objective

Reduce the fragility caused by a single large `app.js` owning too many concerns.

### Work

#### 1. Separate major UI responsibilities

Split frontend concerns into clear modules or logical sections for:

- public dashboard
- admin settings/tools
- player portal
- trades
- shared API/fetch/state utilities

This does not need a framework rewrite. It just needs cleaner boundaries.

#### 2. Standardize fetch and error patterns

- one pattern for admin fetches
- one pattern for portal fetches
- shared response handling for:
  - auth failures
  - validation failures
  - conflict responses
  - non-JSON or unexpected responses

#### 3. Reduce render-trigger side effects

- rendering should not casually trigger expensive remote work
- async prefetch behavior should be intentional, cached, and scoped

### Definition of done

- frontend changes are easier to reason about
- adding one portal/admin feature is less likely to break another
- network behavior is more predictable

## Phase 3.5 — Slop Cleanup and Legacy Debt Reduction

### Objective

Remove the temporary, duplicated, or low-confidence code that accumulates while shipping features quickly.

### Work

#### 1. Remove temporary debugging residue

- remove console logging that was only added for active debugging
- remove temporary error scaffolding once proper handling exists
- make sure user-facing toasts remain useful without noisy developer-only output

#### 2. Eliminate dead or duplicated code paths

- identify helpers that are no longer called
- remove outdated portal flow remnants where safe
- reduce overlap between legacy portal and active portal implementations
- identify one-off patches that should be replaced by proper shared logic

#### 3. Clean state and render slop

- remove state fields that no longer drive real UI behavior
- reduce duplicated rendering branches that exist only because of incremental patches
- tighten naming for portal/admin/trade responsibilities where it improves readability

#### 4. Normalize feature integration quality

- make sure newly added features follow the same fetch/error/loading conventions
- fold “works but bolted on” UI pieces back into the main patterns
- ensure trade, portal, and admin additions look like first-class code, not emergency add-ons

### Definition of done

- dead code is reduced
- temporary debug residue is removed
- active code paths are easier to identify
- new contributors can tell which implementation is authoritative

## Phase 4 — Data Model and Write Path Maturity

### Objective

Continue moving real user workflows out of the giant `league_state` blob and into safer dedicated storage.

### Current direction to continue

- `user_links`
- `score_submissions`
- pending approval workflows

### Work

#### 1. Trade storage maturity

- clarify whether pending trades remain entirely in `pending_requests` or graduate into a dedicated trade table
- ensure trade history, actor metadata, and status transitions are easy to query

#### 2. Narrow transactional operations

Prefer explicit operations like:

- link manager
- submit score
- approve score
- propose trade
- review trade

instead of broad state mutation whenever possible.

#### 3. Audit metadata consistency

Standardize metadata like:

- `submitted_by`
- `submitted_at`
- `reviewed_by`
- `reviewed_at`
- `source`
- `status`

### Definition of done

- user-facing writes are narrow and conflict-safe
- admin review actions are auditable
- trade and score records are easier to inspect directly in the database

## Phase 5 — Observability and Admin Repair Tools

### Objective

Make failures diagnosable and recoverable without ad hoc database surgery.

### Work

#### 1. Logging and diagnostics

Add structured or at least consistent logs for:

- OAuth failures
- linking conflicts
- score submission conflicts
- trade proposal/review failures
- Zamboni API failures
- bot posting failures
- startup config warnings

#### 2. Admin repair tools

Add or improve admin UI for:

- viewing linked users
- correcting broken manager links
- reassigning wrong links
- reviewing recent submissions
- identifying recent failed actions

#### 3. Safer operational workflows

- add smoke-test checklist after deploy
- identify critical routes to verify after restart
- document recovery actions for broken OAuth, broken links, and stale sessions

### Definition of done

- you can diagnose common failures quickly
- admins can repair the most common bad states from the UI
- deploy verification becomes repeatable

## Phase 6 — Performance and External Service Discipline

### Objective

Keep the app responsive while minimizing unnecessary dependency on Zamboni availability and latency.

### Work

#### 1. Layered caching strategy

- keep server-side cache for Zamboni API responses
- keep session/browser cache where useful for portal match selection
- document cache TTLs and invalidation rules

#### 2. Invalidation rules

Refresh or clear relevant cached data when:

- a score is submitted
- a user links or relinks an account
- a portal session changes users
- a trade state changes

#### 3. Prefetch discipline

- prefetch only likely next actions
- avoid expensive lookups for every render
- prefer opt-in lookup when reliability matters more than cleverness

### Definition of done

- portal feels fast
- repeated background lookups are controlled
- Zamboni downtime degrades gracefully instead of causing chaos

## Phase 7 — Feature Expansion On Top Of A Stronger Base

### Objective

Build new website-first workflows only after the core app is safer to maintain.

### Recommended order

#### 1. Finish trade UX maturity

- full player visibility into sent/received trade proposals
- better notifications and status presentation
- stronger admin trade review ergonomics

#### 2. Inbox / notification center

- website-native notifications for trade events and score issues
- Discord remains complementary, not required

#### 3. Additional player account tooling

- self-service account review where safe
- better visibility into linked manager and RPCN state

### Definition of done

- new features layer onto stable infrastructure instead of expanding fragility

## Recommended Execution Order

1. deployment/path/env hardening
2. API-safe fallback behavior and startup validation
3. portal stability and duplicate-fetch cleanup
4. frontend structure cleanup in `app.js`
5. slop cleanup and legacy debt reduction
6. stronger write-path and trade/score storage discipline
7. observability and admin repair tooling
8. performance/caching discipline
9. new player-facing expansion

## Concrete Near-Term Sprint Plan

### Sprint A — Prod safety

- review whether startup warnings should become hard failures in stricter production mode
- add deployment smoke checklist steps to operational docs

### Sprint A progress

- completed server startup warnings for risky env/config states
- completed bot startup warnings for risky env/config states
- completed API JSON 404 fallback for unknown `/api/*` routes
- documented `APP_BASE_PATH`, `APP_URL`, and production callback expectations

### Sprint B — Portal stability

- standardize portal loading/error states
- verify trade portal flows end-to-end
- continue reducing unnecessary portal refresh chains after successful actions

### Sprint B progress

- completed in-flight dedupe for portal score match requests
- reduced portal match prefetch pressure
- added short-lived portal trades caching and in-flight dedupe
- reduced repeated trade badge/modal fetch churn
- cleaned up portal state reset behavior and removed small pieces of debug residue

### Sprint C — Frontend maintainability

- separate major `app.js` responsibilities
- reduce render-driven side effects
- continue incremental file extraction one seam at a time

### Sprint C progress

- completed first incremental extraction seam: `portal-shared.js`
- moved portal shared session/cache/trade-fetch/autocomplete helpers out of `app.js`
- wired `portal-shared.js` before `app.js` in `index.html`
- verified the extracted helpers are now authoritative in the new file

### Sprint C2 — Slop cleanup

- reduce legacy route ambiguity where safe
- align newer features with shared patterns
- continue removing stale compatibility residue only after confirming it is unused

### Sprint C2 progress

- removed legacy `PLAYER_DB` from `app.js`
- replaced old trade/player fallback name lookups with live `state.players` resolution
- removed leftover playoff debug logging and dormant `autoLoadRatings` patch comments

## Current Recommended Next Steps

1. extract **portal UI/actions** into the next dedicated file
   - `showMyTrades`
   - `updatePortalTradesBadge`
   - `showProposeTrade`
   - `submitTradeProposal`
   - portal login/link/logout handlers

2. extract **trade rendering/helpers** after that
   - `renderTradeCard`
   - trade formatting helpers
   - shared trade modal helpers where practical

3. then extract **admin pending trade helpers**
   - `loadPendingTrades`
   - `reviewTrade`

## Notes For Next Session

- continue using **incremental extraction only**
- prefer one seam at a time with quick verification
- avoid a broad `app.js` rewrite while quota/time is tight
- `SYS-DATA` support is still active and should not be removed as legacy code

### Sprint D — Admin operations

- linked-user admin repair tools
- recent failure visibility
- deploy smoke checklist

## What Not To Do Yet

Avoid these until the app actually needs them:

- microservices
- Kubernetes
- distributed queues
- Redis-first architecture
- full rewrite away from Flask
- frontend framework rewrite just to escape `app.js`

Those would add complexity without solving the real near-term problems.

## Success Criteria

The website should be considered robust enough for active league usage when:

- players can sign in reliably across environments
- linked accounts stay correct and are repairable
- score submissions are fast and conflict-safe
- trade flows are visible, understandable, and admin-manageable
- unknown API failures never masquerade as frontend bugs
- Zamboni failures degrade gracefully
- logs make failures diagnosable
- deploys no longer require a trail of small emergency fixes
- new features can be added without destabilizing portal or admin flows

## Summary

The next step is not a rewrite. It is a structured hardening pass:

- make deployment assumptions explicit
- make API behavior predictable
- reduce portal/admin/public coupling
- control external lookup churn
- improve observability and repair tooling
- then continue expanding website-first league workflows on top of that stronger foundation
