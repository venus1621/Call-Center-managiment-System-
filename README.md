# Call Center Scheduling Bot (Telegram)

Agents **reserve available time slots**, the bot **shows the call center account** to use for that slot,
and supervisors **monitor booked vs. worked hours** per agent and per account for any date range.

Stack: Node.js 18+, Telegraf, MongoDB (Mongoose), node-cron.

## 1. Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) and copy the token.
2. Have MongoDB running (local, Docker or Atlas).
3. Install and configure:
   ```bash
   npm install
   cp .env.example .env
   # generate the encryption key and paste it into .env:
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```
4. Start the bot and send `/id` to it to get your Telegram ID, put it in `ADMIN_IDS`, restart.
   ```bash
   npm start
   ```

The bot uses long polling, so it needs no public URL. On a VPS you can run it with
`pm2 start src/index.js --name call-center-bot`, or deploy the included `Dockerfile` (e.g. with Coolify)
and set the same variables from `.env.example`.

### Admin bot (optional, recommended)

Create a **second bot** in @BotFather and put its token in `ADMIN_BOT_TOKEN`. Then:
- the **agents bot** only has the agent commands (agents never see admin tools), and
- the **admin bot** is for supervisors only (everyone not in the admin list is refused). Open it and press Start to see the panel.

If `ADMIN_BOT_TOKEN` is empty, everything runs in the single bot and supervisors open the panel with `/panel`.
Supervisors must press Start in the admin bot once to receive the daily summary there.

## 2. First-time supervisor setup

Set the supervisor's Telegram ID in `ADMIN_IDS` and have them send `/start` to the bot (or the separate admin bot). New agents send `/start` to the agents bot and press **Request to join**, or send `/join`. They cannot use agent commands until approved.

Supervisors receive the request with **Approve** and **Reject** buttons. They can also open **Join requests** in `/panel` or send `/requests` to review pending applications. The agent is notified of the decision. Repeated submissions do not create duplicate requests; rejected or deactivated users must contact a supervisor. `/adduser` remains available for manual registration.

### Default daily slots

Each active account automatically gets **one-hour slots from morning 2:00 to night 4:00, Ethiopian local time**. Time buttons, confirmations, bookings, reminders and reports all use the Ethiopian clock, with morning, afternoon and night labels. For example, the first slot is **2:00 morning–3:00 morning** and the last is **3:00 night–4:00 night**. The underlying schedule is 08:00–22:00 in Addis Ababa. A new installation with no accounts starts with a `CC-01` booking calendar; add its real login later with `/addaccount CC-01 your-login`.

Agents open `/start` → **Choose time & reserve**, or send `/slots`, select one or several times using the checkbox buttons, then press **Reserve selected times**. Tap a selected time again to deselect it, or use **Clear selection**. Selections are kept separately for each date and show the total hours before confirmation; they expire after 30 minutes of inactivity. After the last available starting time today, the default view opens tomorrow. **My reservations** shows bookings and cancellation buttons.

All selected times must be available, fit within the daily hours limit, and avoid overlapping each other or existing reservations. If a slot becomes unavailable during reservation, the bot releases the places acquired for that attempt so you can review and try again.

Defaults are created for today and tomorrow on startup and daily at midnight. Browsing another future date creates that day's slots. Existing bookings and custom schedules are preserved. `/delslots` stops automatic slots from being restored for that date/account; `/addslots` provides an explicit schedule instead. Disabled accounts cannot accept reservations.

Optional `.env` settings: `DEFAULT_SLOT_START=08:00`, `DEFAULT_SLOT_END=22:00`, `DEFAULT_SLOT_MINUTES=60`, and `DEFAULT_SLOT_CAPACITY=1`. The slot length must divide the daily window exactly.

Configuration values use the standard 24-hour clock. For `/addslots`, supervisors can enter Ethiopian times with `day` or `night` appended, without spaces: `/addslots 2026-10-08 2:00day 4:00night all 60`. `12:00day` means 06:00 and `12:00night` means 18:00. Standard 24-hour command inputs remain supported. Dates use `YYYY-MM-DD`.

```
/addaccount CC-01 agent01 MyPassword      (password optional; stored encrypted, your message is deleted)
/addaccount CC-02 agent02
/adduser 123456789 Abel agent             (agent's Telegram ID; they can send /id to the bot to learn it)
/addslots 2026-10-08 2:00day 4:00night all 60      (morning 2 to night 4; one-hour slots, 1 user per slot)
/addslots 2026-10-09 2:00day 4:00night CC-01 60 2  (same, but up to 2 users may reserve each slot)
```

## 3. Commands

**Agent**
| Command | What it does |
|---|---|
| `/join` | Request access; an admin must approve before agent commands become available |
| `/slots [date]` | Select one or several times, then press Reserve selected times. Ethiopian hours: morning 2 to night 4 |
| `/mybookings` (`/cancel`) | Upcoming reservations, with cancel buttons |
| `/myaccount` | Account for my current/next reservation |
| `/startwork`, `/endwork` | Start / end a work session on the reserved account (also available as buttons) |
| `/myhours [range]` | My booked vs. worked hours |

**Admin panel** (`/panel`, or Start in the admin bot): a button menu with
- **Join requests**: approve or reject pending applicants; approval gives agent access
- 👥 **Team**: open a person, see their week, activate/deactivate, make admin/agent
- 🔑 **Accounts**: open an account for its **full report** (Today / Yesterday / Week / Month): live status, published vs reserved time, places taken, booked vs worked hours, no-shows, per-agent table, recent sessions; enable/disable the account
- 🗓 **Schedule**: browse any day, see who is in each slot
- 📊 **Reports**: hours per account / per agent for a quick range
- ✉️ **Messages**: send a direct message to one agent or to everyone, and see who received and confirmed it
- 📡 **Live now**: which accounts are in use and by whom, which are free and what is reserved next

**Supervisor commands** (the same things by typing; `/panel` has an ℹ️ Commands button)
| Command | What it does |
|---|---|
| `/requests` | Review pending join requests with Approve / Reject buttons |
| `/adduser <id> <name> [admin\|agent]`, `/users`, `/removeuser` | Manage the team |
| `/addaccount <name> <login> [password]`, `/accounts`, `/idle` | Manage accounts, see who uses what right now |
| `/addslots <date> <from> <to> <account\|all> [minutes] [users]` | Publish available times. `users` = 1 or 2 people per slot (optional, default `DEFAULT_SLOT_CAPACITY`) |
| `/delslots <date> <account\|all>` | Remove slots of a day that have no reservations |
| `/schedule [date]` | Who is booked when |
| `/msg <@username\|id\|all> <text>` | Direct message to an agent (or all agents). The bot shows a preview and sends only after you press ✅ Send |
| `/messages` | History: delivered and confirmed counts |
| `/accountreport <account> [range]` | Full report of one account (default: this week) |
| `/hours <@name\|all> [range]` | Booked vs. worked hours per agent |
| `/accounthours <account\|all> [range]` | Booked vs. worked hours per account |

**Range** = `today`, `yesterday`, `week`, `month`, one date `2026-10-07`, or two dates `2026-10-01 2026-10-07`.

### Direct messages

1. Supervisor: `/msg @abel Please start 15 minutes earlier tomorrow.` (or `/panel` → Team → person → ✉️ Send message, or 📢 Message everyone).
2. The bot shows a **preview** with who will receive it. Nothing is sent until the supervisor presses **✅ Send** (or **❌ Cancel**). Drafts expire after 30 minutes.
3. The agent receives the message through the agents bot with a **✅ Got it** button. When pressed, the supervisor is notified.
4. If a message cannot be delivered (the agent never pressed Start in the agents bot), the supervisor is told who was missed.

## 4. Automatic behavior

- **Default schedule**: daily morning 2 to night 4 in Ethiopian local time, for each active account; one hour per slot by default.
- **Pre-shift alarm** `ALARM_MIN_BEFORE` minutes before a reserved slot (default 15) with the account and a Start button.
- **Start reminder** if the agent has not started `START_REMINDER_MIN` minutes after the slot began.
- **Auto-close** of sessions where the agent forgot to press End (closed at the slot end time).
- **No-show detection** after a reserved slot ends with no session.
- **Daily summary** to supervisors at 12:00 night Ethiopian time by default (`DAILY_SUMMARY_HOUR=18` in the standard clock, `TZ_NAME` timezone).

## 5. Rules (configurable in `.env`)

`MAX_HOURS_PER_DAY` per agent, `MIN_NOTICE_MIN` before a slot starts, `CANCEL_DEADLINE_MIN` before a slot starts.
No overlapping reservations for the same agent. **Slot capacity is optional: 1 user (default) or at most 2 users per slot.** Capacity is checked atomically, so a slot can never be over-booked. When 2 users share a slot they both use the account assigned to that slot, and each user's start/end and hours are tracked separately.

## 6. Security notes

- Only registered Telegram IDs can use the bot, and only in private chats.
- Passwords are stored with AES-256-GCM using `ENCRYPTION_KEY` (keep it safe, losing it makes stored passwords unreadable).
- By default the bot shows only the account **name and login**. Set `SHOW_PASSWORD=true` to also send the password to the agent who reserved the slot.
- Worked hours are based on the agents' Start/End presses. For exact login/logout times, integrate with your call center system's API.

## 7. Project structure

```
src/
  index.js            bot startup
  config.js           environment settings
  jobs.js             alarms, reminders, auto-close, no-shows, daily summary
  middleware/auth.js  registered-users-only + admin guard
  handlers/           agent.js, admin.js, join.js (access requests), reports.js, panel.js (admin button menu), messages.js (direct messages)
  models/             User, Account, Slot (capacity 1-2), ScheduleOverride, Booking (one per user per slot), Session, Message
  services/defaultSlots.js  automatic daily slots and explicit schedule overrides
  services/report.js  booked vs worked aggregation + report table
  utils/              time (timezone, ranges), crypto, format
```

## 8. Tests

Run `npm test` (or `npm.cmd test` in Windows PowerShell) with local MongoDB running. Join and reservation integration tests use separate temporary databases and mock Telegram, so no messages are sent and application data is untouched. Set `JOIN_TEST_MONGO_URI` to use another test MongoDB server.
