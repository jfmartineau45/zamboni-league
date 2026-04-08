# Bot Posting Refactor Roadmap

## Goal

Refactor the Discord bot so it is no longer the primary place where users complete league workflows.

The website becomes the main product for player actions.
The bot becomes a lightweight league communication layer focused on posting updates, links, and notifications.

## Product Direction

### Website handles

- account signup and linking
- score submission
- trade offers and responses
- user profile / account management
- future inbox and player-facing workflows

### Bot handles

- posting newly submitted or approved scores
- posting trade offers, trade responses, and approved trades
- posting reminders and announcements
- linking users back to the website
- optional admin notifications and moderation alerts

## Refactor Principles

### 1. Remove duplicated user flows

Do not maintain parallel Discord and website flows for the same task unless absolutely necessary.

### 2. Bot should notify, not orchestrate

The bot should be excellent at:

- broadcasting updates
- deep-linking users to the right web page
- summarizing league events

It should stop owning complex input workflows.

### 3. Keep admin utility where useful

If some admin-only bot controls remain valuable, keep them only if they do not duplicate website logic.

## Phase 1 — Freeze New Interactive Bot Features

### Objective

Stop expanding the bot as a player workflow surface.

### Work

- do not add new player-facing interactive bot commands
- stop extending `/signup` and `/score` beyond transitional support
- document that website is the primary path for user actions

### Outcome

The codebase stops drifting into duplicate interaction patterns.

## Phase 2 — Convert Bot Commands into Website Entry Points

### Objective

Make bot commands redirect users to the website instead of handling full workflows in Discord.

### Work

#### `/signup`

Refactor to:

- explain that signup/linking now happens on the website
- post a direct link to the portal
- optionally show a short summary of what the player can do there

#### `/score`

Refactor to:

- explain that score submission now happens on the website
- post a direct link to the player score portal
- optionally mention that linked users can submit scores faster there

#### Future commands

Prefer commands like:

- `/portal`
- `/myteam`
- `/league`

that simply open useful website pages.

### Outcome

Discord becomes a clean launchpad into the web experience.

## Phase 3 — Add Event Posting Services

### Objective

Turn the bot into an automatic posting engine for league activity.

### Core event types

#### 1. New scores

When a score is submitted and approved:

- post final result
- include teams, score, OT if applicable
- include short metadata like submitter or source if desired
- optionally include a website deep link to the game page / box score

#### 2. Trades

Support bot posts for:

- new trade offer sent
- trade accepted / rejected
- trade approved by admin
- completed trade summary

#### 3. League reminders

Examples:

- games due reminder
- playoff round started
- missing score reminder
- trade deadline reminder

#### 4. Admin alerts

Examples:

- failed website OAuth attempts
- score conflicts
- broken or duplicate account links
- moderation review needed

### Outcome

The bot becomes highly useful without carrying the UX burden of input flows.

## Phase 4 — Introduce a Notification Pipeline

### Objective

Centralize how league events become Discord messages.

### Recommended architecture

Create a small internal notification layer with event producers and event consumers.

#### Event producers

These emit structured events such as:

- `score_submitted`
- `score_approved`
- `trade_offer_created`
- `trade_offer_accepted`
- `trade_approved`
- `deadline_reminder`

#### Event consumer

A bot posting service listens for those events and formats Discord messages.

### Suggested benefits

- keeps website/backend logic separate from Discord message formatting
- makes it easier to add email or website notifications later
- reduces hardcoded posting logic spread across many files

### Outcome

Bot posting becomes clean, reusable, and extensible.

## Phase 5 — Retire Old Interactive Bot Logic

### Objective

Remove old player-facing Discord workflow code once website adoption is stable.

### Work

- identify bot commands that duplicate website functionality
- mark them as deprecated
- replace them with link-only behavior first
- remove obsolete modals/views/helpers after transition period
- keep only posting, moderation, and useful admin utilities

### Candidates for retirement or simplification

- interactive signup flow
- interactive score submission flow
- Discord-specific UI state for user workflows
- duplicated linking helpers that only exist for old bot UX

### Outcome

The bot codebase becomes smaller, clearer, and easier to maintain.

## Phase 6 — Channel and Content Strategy

### Objective

Make bot output useful and not noisy.

### Suggested channel split

- `#scores` for approved score posts
- `#trades` for trade activity
- `#announcements` for league-wide notices
- `#admin-alerts` for operational issues

### Message quality goals

- concise
- visually readable
- branded consistently
- includes website CTA when relevant

### Outcome

The bot adds value instead of clutter.

## Suggested Technical Work Items

### Backend

- add notification event hooks to score submission flow
- add notification event hooks to future trade flow
- centralize event payload creation

### Bot

- create posting service module
- create message formatters for scores, trades, reminders, alerts
- add configurable channel routing
- add retry/error logging for failed Discord posts

### Config

Add environment variables or config for:

- score post channel id
- trade post channel id
- announcements channel id
- admin alerts channel id
- website base url for deep links

## Recommended Rollout Order

1. Freeze new interactive player bot work
2. Refactor `/signup` and `/score` into website-link commands
3. Add automatic approved-score posting
4. Add trade posting once website trade flow exists
5. Add admin alerts and reminder jobs
6. Remove old interactive Discord workflow code

## Success Criteria

The bot refactor is successful when:

- players naturally use the website for all real actions
- bot commands mostly deep-link to the website
- approved scores post automatically in Discord
- trade activity posts automatically in Discord
- duplicated Discord workflow code is removed or minimized
- the bot remains useful without being the main product surface

## Summary

The bot should evolve from an interactive workflow engine into a league communications and notification service:

- website for actions
- bot for posting, reminders, alerts, and links
