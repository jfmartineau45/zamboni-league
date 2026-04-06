# Discord OAuth Signup & Manager Profiles

Add Discord OAuth authentication for web-based signups with auto-approval for existing managers, waiting list for new players, and comprehensive manager profile cards showing league history.

## Overview

Create a web-based signup system using Discord OAuth that:
- Auto-links existing managers to their Discord accounts
- Places new players in a waiting list for admin review
- Provides admin tools to edit/fix signup errors
- Displays manager profile cards with league history

## Key Features

### 1. Discord OAuth Integration

**Backend (`server/routes/discord_oauth.py`):**
- New `/api/discord/auth` endpoint to initiate OAuth flow
- New `/api/discord/callback` endpoint to handle Discord redirect
- Store Discord OAuth credentials in environment variables
- Exchange OAuth code for Discord user info (ID, username, avatar)

**Frontend:**
- Add "Sign Up with Discord" button (prominent, accessible to all users)
- OAuth flow: redirect to Discord → user authorizes → redirect back to site
- After OAuth: show form to select manager (if existing) or enter new player info
- Collect: Manager name (dropdown or text), RPCN tag (required)

### 2. Signup Logic

**For Existing Managers:**
- Show dropdown of managers without Discord linked
- Auto-approve and immediately link Discord ID + RPCN tag to manager
- Update `state.managers[].discordId`, `discordUsername`, `zamboniTag`
- Show success message: "Account linked! You can now use Discord commands."

**For New Players (Waiting List):**
- If user doesn't select existing manager, treat as new signup
- Create entry in new `waitingList` array in state
- Store: `{id, discordId, discordUsername, managerName, zamboniTag, signupDate, status: 'pending'}`
- Admin can later convert waiting list entry to full manager

**Admin Override:**
- Settings → Managers: Add "Edit Link" button for each manager
- Allow admin to manually change Discord ID, username, RPCN tag
- Useful for fixing human errors in signup process

### 3. Waiting List Management

**Backend Storage:**
- Add `waitingList` array to league state
- Each entry: `{id, discordId, discordUsername, managerName, zamboniTag, signupDate, status, notes}`

**Admin Interface (Settings → Managers):**
- New "Waiting List" tab showing pending signups
- For each entry: Show Discord user, requested name, RPCN tag, signup date
- Actions: "Create Manager" (converts to full manager), "Reject" (removes from list)
- "Create Manager" button: Creates new manager entry, assigns color, removes from waiting list

### 4. Manager Profile Cards

**Profile Page/Modal:**
- Accessible by clicking manager name anywhere in the app
- **Header Section:**
  - Manager name, color badge
  - Team logo (if assigned)
  - Discord username + avatar (if linked)
  - RPCN tag (if linked)
  - Status badges: Team assigned, Discord linked, RPCN linked

**League History Section:**
- **Current Season:**
  - Team record (W-L-OT)
  - Points, standings position
  - Current roster (player names + positions)
  
- **All-Time Stats (if multi-season):**
  - Total games managed
  - Win percentage
  - Championships won
  - Playoff appearances
  
- **Recent Activity:**
  - Last 5 games (scores, opponents)
  - Recent trades
  - Draft history (if available)

**Implementation:**
- Add `showManagerProfile(managerId)` function in `app.js`
- Make manager names clickable throughout app (standings, games, trades)
- Use modal for profile display (similar to box score modal)
- Calculate stats from `state.games`, `state.trades`, `state.seasons`

### 5. Discord Channel Integration

**Signups Channel (Optional):**
- No automatic posts to Discord for OAuth signups
- All signup management happens in web interface
- Signups channel ID stored but not used for OAuth flow

## Technical Implementation

### Backend Routes

```
POST   /api/discord/auth          - Initiate OAuth, return Discord auth URL
GET    /api/discord/callback      - Handle OAuth callback, exchange code for user info
POST   /api/signup/oauth          - Submit OAuth signup (manager selection + RPCN)
GET    /api/waiting-list          - Get all waiting list entries (admin only)
POST   /api/waiting-list/:id      - Convert to manager or reject (admin only)
PATCH  /api/managers/:id/link     - Admin override to edit Discord/RPCN links
```

### Frontend Components

```
- SignupButton: "Sign Up with Discord" button
- SignupForm: Post-OAuth form (manager select + RPCN input)
- ManagerProfile: Modal showing manager stats/history
- WaitingListPanel: Admin interface in Settings → Managers
```

### Data Schema Updates

**Manager Object:**
```javascript
{
  id, name, color,
  discordId,         // Discord user ID
  discordUsername,   // Discord username
  discordAvatar,     // Discord avatar URL (new)
  zamboniTag         // RPCN account
}
```

**Waiting List Entry:**
```javascript
{
  id,
  discordId,
  discordUsername,
  discordAvatar,
  managerName,       // Requested name
  zamboniTag,
  signupDate,
  status,            // 'pending' | 'approved' | 'rejected'
  notes              // Admin notes
}
```

## User Flow

### Existing Manager Signup:
1. Click "Sign Up with Discord" button
2. Authorize on Discord → redirect back
3. See form: "Select your manager" dropdown + "RPCN Account" input
4. Submit → Auto-approved, immediately linked
5. Success message, can now use Discord bot commands

### New Player Signup:
1. Click "Sign Up with Discord" button
2. Authorize on Discord → redirect back
3. See form: "Manager Name" text input + "RPCN Account" input
4. Submit → Added to waiting list
5. Message: "Signup received! Admin will review and create your manager profile."

### Admin Workflow:
1. Settings → Managers → Waiting List tab
2. See pending signups with Discord info
3. Click "Create Manager" → New manager created, removed from waiting list
4. Or click "Reject" → Removed from waiting list

## Files to Create/Modify

**New Files:**
- `server/routes/discord_oauth.py` - OAuth endpoints
- `server/routes/waiting_list.py` - Waiting list management

**Modified Files:**
- `server/server.py` - Register new blueprints
- `app.js` - Add signup button, OAuth flow, manager profiles, waiting list UI
- `index.html` - Add signup button to header/dashboard
- `styles.css` - Style signup button, profile modal, waiting list panel
- `.env` / `server/.env` - Add Discord OAuth credentials

## Environment Variables Needed

```
DISCORD_CLIENT_ID=your_discord_app_client_id
DISCORD_CLIENT_SECRET=your_discord_app_client_secret
DISCORD_REDIRECT_URI=http://localhost:3001/api/discord/callback
```

## Testing Checklist

- [ ] OAuth flow works (redirect to Discord and back)
- [ ] Existing manager can link account (auto-approved)
- [ ] New player goes to waiting list
- [ ] Admin can create manager from waiting list
- [ ] Admin can edit Discord/RPCN links manually
- [ ] Manager profile displays correct stats
- [ ] Profile accessible from all manager name links
- [ ] Waiting list shows in Settings → Managers
