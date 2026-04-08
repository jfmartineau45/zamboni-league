# Website Robustness Roadmap

## Goal

Turn the website from an admin-first companion app into a reliable multi-user league hub that can comfortably support nightly player traffic, website-native signups, direct score submission, and future user-facing workflows like trades and notifications.

This roadmap is focused on practical robustness for a league-sized application, not overengineered infrastructure.

## Current Reality

The site now supports:

- Discord OAuth website login
- linked manager accounts
- RPCN / Zamboni tag capture and validation
- mobile-friendly player dashboard entry
- website-native eligible games
- direct score submission
- Zamboni-assisted score matching with manual fallback

That means the site is no longer just admin tooling. It now has real player-facing workflows and must be hardened accordingly.

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

Thirty nightly users is not large infra scale, but it is enough that stale state, race conditions, and partial failures will become visible.

### 4. Harden incrementally

Do not rewrite the entire app at once. Improve the parts that affect real user workflows first.

## Phase 1 — Immediate Hardening

### Objective

Stabilize the current website login, linking, and scoring experience for real users.

### Work

#### 1. Session hardening

- use a stable `FLASK_SECRET_KEY` in all environments
- configure secure session cookie settings for production
- separate admin session assumptions from player session assumptions
- make logout and expired session behavior explicit in the UI

#### 2. Better server-side validation for score submission

- verify the game is still unplayed at submit time
- reject duplicate submissions cleanly
- verify the submitter is linked to one of the two teams in the game
- confirm the selected game is still eligible at submit time
- keep a server-side audit trail for who submitted what and when

#### 3. Logging and observability

Add structured logs for:

- OAuth start/callback failures
- failed link attempts
- score submission failures
- Zamboni API failures
- duplicate or conflicting score attempts
- admin repair actions

#### 4. Better fallback behavior

- if Zamboni is slow or unavailable, show a clear fallback state immediately
- never silently fail into confusing UI
- preserve manual score entry as the safety net

#### 5. Frontend loading and stale-data handling

- show loading state when fetching match candidates
- show explicit retry buttons where useful
- make stale-game errors clear if a game was already scored elsewhere

### Outcome

The current player website flows become reliable enough for real nightly use.

## Phase 2 — Concurrency and Data Safety

### Objective

Prevent data corruption or confusing behavior when multiple users interact with the site at the same time.

### Work

#### 1. Add targeted transactional write paths

Move user-facing writes toward narrow operations instead of broad state rewrites.

Examples:

- link manager account
- submit score
- create trade offer
- accept/reject trade offer

#### 2. Add optimistic concurrency protections

For example:

- game still unplayed?
- trade still pending?
- manager still unlinked?

If not, return a clear conflict response and refresh the client state.

#### 3. Add audit metadata

Persist metadata like:

- `submittedBy`
- `submittedAt`
- `updatedBy`
- `updatedAt`
- `source` (`website`, `discord-bot`, `admin`)

### Outcome

User actions stay correct even when several managers are active simultaneously.

## Phase 3 — Data Model Evolution

### Objective

Reduce pressure on the giant `league_state` blob by moving user-facing workflows into more structured storage.

### Recommended candidates for dedicated tables

#### 1. Website user links

A dedicated table for:

- discord user id
- manager id
- discord display info
- rpcn / zamboni tag
- linked timestamps

#### 2. Score submission audit log

A dedicated log table for:

- league game id
- submitter
- zamboni game id
- score payload
- manual vs zamboni source
- timestamps

#### 3. Trade offers

A dedicated table for:

- from manager
- to manager
- assets offered
- assets requested
- note
- status
- created/updated timestamps

### Outcome

The website becomes easier to reason about and less fragile under active multi-user usage.

## Phase 4 — Performance and Caching

### Objective

Make the player site feel consistently fast, especially for the score flow.

### Work

#### 1. Keep Zamboni caching layered

Continue using:

- server-side cache for Zamboni API responses
- client-side match prefetch/cache for recent eligible games
- session-level cache reuse inside a browser session

#### 2. Add smart invalidation

Invalidate or refresh caches when:

- a game is submitted
- a manager link changes
- a session changes users

#### 3. Minimize repeated expensive lookups

- prefetch likely next actions only
- avoid fetching all large Zamboni data for every click
- reuse known manager/tag mappings

### Outcome

The score flow remains fast even with many players checking games around the same time.

## Phase 5 — User Workflow Expansion

### Objective

Support more player-facing features without making the site brittle.

### Recommended order

#### 1. Admin repair tools

Add admin UI for:

- viewing linked website users
- fixing broken Discord / RPCN links
- clearing/reassigning incorrect links

#### 2. Trade offers

Build a website trade system with:

- create offer
- accept / reject
- admin approval before final application

#### 3. Notifications / inbox

Add league-user messaging for:

- trade offers
- trade responses
- admin decisions
- score issues

Discord notifications can remain complementary.

### Outcome

The website becomes a true player hub instead of only a score portal.

## Phase 6 — Production Readiness

### Objective

Make deployment and operations safer as the site becomes more important to the league.

### Work

#### 1. Environment consistency

Standardize:

- OAuth environment config
- session secrets
- API base URLs
- production callback URLs

#### 2. Safer deployment process

- checklist for env vars
- smoke test after deploy
- verify OAuth login
- verify linking
- verify score submission
- verify admin tools

#### 3. Operational recovery tools

- admin repair tools for links
- score correction path
- visibility into recent submissions and failures

### Outcome

The site becomes easier to deploy, support, and trust during active league use.

## Recommended Execution Order

1. Harden sessions, validation, and logging
2. Add better concurrency/conflict protection
3. Add admin repair tools for account links
4. Move user-facing workflows into more structured storage
5. Build trade offers on top of the hardened foundation
6. Add notifications and inbox features
7. Formalize production deployment and recovery processes

## What Not To Do Yet

Avoid these until the app actually needs them:

- microservices
- Kubernetes
- distributed queues
- Redis-first architecture
- full rewrite away from Flask

Those would add complexity without solving the real near-term problems.

## Success Criteria

The website should be considered robust enough for nightly league usage when:

- players can sign in reliably
- linked accounts stay correct
- score submissions are fast and conflict-safe
- Zamboni failures degrade gracefully
- admins can repair broken links or submissions quickly
- logs make failures diagnosable
- new user-facing features can be added without risking the core score flow

## Summary

The path forward is not a giant rewrite. It is a staged hardening plan:

- strengthen session and write safety
- reduce global state dependence for player workflows
- improve logging and recovery
- add structured storage where it matters
- build trades and other user features on top of that stronger base
