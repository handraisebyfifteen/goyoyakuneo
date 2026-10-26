# GoYoyaku-chan Neo (ご予約ちゃん Neo)

**A voice-first booking assistant that lets blind and low-vision massage and bodywork practitioners run bookings, money and staff by voice alone.**

In Japan, many massage, acupuncture and shiatsu practitioners are blind or have low vision. Booking tools are built around screens, calendars and forms, so many of them still depend on paper, phone calls and help from sighted people. GoYoyaku-chan Neo inverts that. The main screen is one large microphone button. The owner says what they want ("Tanaka, tomorrow from 2 to 3:30"), hears a one-sentence confirmation, says "yes", and it is done.

What the owner can do by voice:

- **Bookings**: add, move, cancel, repeat weekly, ask "when am I free tomorrow?"
- **Money**: hear sales and unpaid amounts. Take a photo of the cash a customer handed over, and the app counts it and works out the change.
- **Customers**: keep notes ("Tanaka has a bad back"), which are read back before the next visit.
- **Staff**: clock-ins checked against the plan, payroll, and who can be booked by name.
- **Shop**: multi-visit tickets, coupons, expenses and profit, follow-up emails to customers who haven't come back.
- **Advice**: "What should a multi-visit ticket cost?" is answered from the shop's own numbers.

Customers book on an ordinary web page. They can pay at the shop or pay by card in advance.

---

## How Nemotron is used

All AI in the app is **NVIDIA Nemotron**, and no other model provider is used. Model names are defined in one place, [`server/ai/llm.ts`](server/ai/llm.ts), and each can be overridden with an environment variable.

| Role | Model | What it does | Where |
|---|---|---|---|
| **Daily voice operations** | `nvidia/nemotron-3-super-120b-a12b` | Takes each utterance, chooses among 57 tools (bookings, sales, customers, staff, tickets, expenses…) and drafts the action. Read-only tools run straight away. Write tools stop for confirmation (see *Safety by design*). | [`server/ai/agent.ts`](server/ai/agent.ts), [`server/ai/tools.ts`](server/ai/tools.ts) |
| **Advice and confirmation sentences** | `nvidia/nemotron-3-super-120b-a12b` | (1) Writes the single spoken sentence that asks the owner to confirm an action, e.g. "Shall I book Tanaka on Wednesday, October 28 from 14:00 to 15:30, paying at the shop?" (2) Answers "why / what should I do" questions with no tools, using the shop's real figures. | `confirmText` and `consult` in [`server/ai/agent.ts`](server/ai/agent.ts) |
| **Counting cash from a photo** | `nvidia/Nemotron-3.5-Super-VL` | Counts the banknotes and coins in a photo and returns them as JSON. The server recalculates the total and marks the reading "not confident" if the model's sum disagrees. The photo is never stored. | [`server/ai/vision.ts`](server/ai/vision.ts) |

### Why Super and not Lightning for daily operations

Our brief named Nemotron Lightning (`nvidia/Nemotron-3_5-Lightning`) for the fast, per-utterance role. We tested it and switched to Super:

- **2026-10-21, CLI prototype:** asked "What bookings do I have tomorrow?" or "What are this month's sales?", Lightning answered **without calling any tool** in 7 out of 8 tries. It made up bookings and amounts from the conversation instead. Stricter instructions and temperature 0 did not fix it. Forcing tool use (`tool_choice: "required"`) produced hundreds of tool calls in one reply. Super called the tools every time, in 3 to 5 seconds per question. (Commit `b6ba53b`.)
- **2026-10-22, web app:** the same behaviour came back in the web version. Lightning replied "I've booked it" when no booking had been made.

For a blind user who cannot glance at a screen to check, a confident false "done" is the worst possible failure. So both text roles use Super. Lightning can be switched back on with `GOYOYAKU_FAST_MODEL` without code changes.

## How Token Factory is used

Every model call goes through **Nebius Token Factory**, using its OpenAI-compatible API. [`server/ai/llm.ts`](server/ai/llm.ts) creates a single client with the official `openai` SDK:

```ts
new OpenAI({ baseURL: "https://api.tokenfactory.nebius.com/v1/", apiKey: process.env.NEBIUS_API_KEY, timeout: 60_000, maxRetries: 1 });
```

- **Text roles** use `chat.completions.create` with function calling (`tools`) at temperature 0.2.
- **Vision** uses `chat.completions.create` with an image part at temperature 0.
- The client is created lazily, so the app starts and the tests run without a key. Without one, the voice panel says AI is not configured.
- Reasoning output (`<think>…</think>`) is stripped, and replies are cleaned of markdown and emoji before they are spoken aloud.

---

## Safety by design

The AI proposes, and code decides. The rules below are enforced in code ([`server/ai/agent.ts`](server/ai/agent.ts)), not by prompt.

- **Every write is confirmed out loud first.** When the model picks a tool that changes data, the server checks the arguments and does not run it. Nemotron writes a one-sentence confirmation, and the owner must answer "yes" (by voice or button) before anything happens. A sentence that does not end as a yes/no question is replaced by a fixed one.
- **Money and records need a passphrase too.** Cancelling a booking, recording cash received, correcting clock records, and changing settings or booking rules also need the owner's spoken passphrase.
  - The passphrase is never sent to the AI and never saved in the chat history.
  - After 3 wrong tries, these actions are locked for 5 minutes.
  - A correct passphrase is remembered for 10 minutes.
- **Unknown tool names are refused.** If the model names a tool that doesn't exist, nothing runs.
- **Payments are test-mode only.** Card payment uses Stripe Checkout and Stripe Connect.
  - Card numbers never pass through this app, and money goes straight to each shop's own Stripe account.
  - The server **refuses to start if a live Stripe key (`sk_live_` / `pk_live_`) is set.**
- **Prank bookings can't block the calendar.**
  - Online card payment is only offered for bookings at least 24 hours ahead. The owner can change this.
  - An online card booking that isn't paid within 30 minutes is cancelled automatically and the time is freed.
- **Cash counting is advisory.** The vision result is a second check. Recording the money is a separate write that needs confirmation and the passphrase.

## Accessibility

- **Screen readers:** the app is built to work alongside screen readers such as VoiceOver.
  - Every step moves focus to the input or the yes/no buttons.
  - Status text is announced through live regions.
  - There is an option to turn off the app's own speech, so it doesn't talk over the screen reader.
  - First-time voice setup (voice, gender, speed) is done by voice, by actually listening to the options.
- **Keyboard:** everything works without a mouse, and the **Space** key starts and stops the microphone.
- **Low vision:** the edge of the screen glows in different rhythms and colours for listening, thinking, speaking and waiting for yes/no. Colour is only a secondary cue, and flashing is kept at 3 times per second or less. On Android, vibration patterns are added.
- **Hearing what happened:**
  - **On opening the admin page:** the owner hears what changed since last time (new bookings, card payments, cancellations), today's next customer and their notes, and which of tomorrow's customers need a phone call.
  - **While the page is open:** new events are spoken within about 20 seconds, without interrupting a conversation.
  - **While the app is closed:** the owner can turn on **Web Push notifications**, so news arrives even with the screen locked. The notification text is written to make sense on its own when read aloud.
  - Delivery has been tested end to end against a local push endpoint, but **not yet confirmed on real Android or iPhone devices**. On iPhone, Apple only allows web notifications for apps added to the Home Screen, and the app walks the owner through that.
- **Troubleshooting:** a `/voice-check` page shows why speech is silent (browser support, autoplay permission, available voices).

---

## Setup and run

Requirements: Node.js 20 and PostgreSQL. It runs on Replit as is.

```bash
npm install
npm run db:push   # create or update tables from shared/schema.ts
npm run dev       # http://localhost:5000
npm test          # unit tests (no network or API key needed)
npm run build && npm start   # production build
```

### Environment variables (names only)

| Name | Required | Purpose |
|---|---|---|
| `DATABASE_URL` | yes | PostgreSQL connection |
| `SESSION_SECRET` | yes | Login session signing |
| `NEBIUS_API_KEY` | for AI | Nebius Token Factory |
| `GOYOYAKU_FAST_MODEL`, `GOYOYAKU_SMART_MODEL`, `GOYOYAKU_VISION_MODEL` | no | Override the Nemotron model names |
| `STRIPE_SECRET_KEY`, `VITE_STRIPE_PUBLISHABLE_KEY` | for card payment | **Test keys only** |
| `STRIPE_WEBHOOK_SECRET`, `STRIPE_CONNECT_WEBHOOK_SECRET` | for card payment | Webhook signatures (platform and connected accounts) |
| `STRIPE_PRICE_BASE`, `STRIPE_PRICE_SEAT` | no | Monthly subscription prices |
| `RESEND_API_KEY`, `RESEND_FROM` | for email | Booking confirmations and reminders. Without them, emails are printed to the log. |
| `EMAIL_DAILY_LIMIT` | no | Emails per shop per day |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | no | Web Push keys. If unset, a key pair is generated once and kept in the database. |
| `APP_BASE_URL` | no | Public URL for links in emails and from Stripe |
| `REMINDERS` | no | `on` runs reminders and the unpaid-booking cleanup in development |

Without Stripe keys, card payment uses a placeholder link so the whole flow can still be tried.

---

## Built during the hackathon

The idea and the domain come from an earlier booking app of mine, which is **not in this repository**. Everything in this repository's history was committed during the hackathon. Dates are commit dates (UTC).

**Oct 21: CLI prototype with Nemotron** (`47c1499`, `d35f649`, `b6ba53b`)
- Python CLI: a Nemotron tool-calling agent on Token Factory, plus a pure calculation layer with tests
- Country, currency, time zone and language settings
- Lightning vs Super evaluation, and the switch to Super

**Oct 22: rebuilt as a web app** (`626cbfa`)
- React + Express + PostgreSQL
- Voice panel and the agent with the confirm-then-passphrase flow
- Cash counting with Nemotron VL
- Customer booking page, Stripe Checkout (test mode), confirmation emails

**Oct 23: voice-only onboarding** (`afa070d`, `e67bc43`, `b0b9ede`, `4ed03a6`)
- Voice settings chosen by listening
- Login and sign-up conversations usable without sight
- Fixes for silent speech (Chrome quirks, iOS audio unlock) and the `/voice-check` page

**Oct 25: running a shop with staff** (`dd7f8f7`)
- Staff accounts and nomination (customers choosing who they book with)
- Shift plans and clock-ins with owner double-check
- Shop groups, calendar feed, coupons
- Day-before reminders
- The spoken briefing when the admin page opens
- Setup questions asked one at a time by the AI

**Oct 26: money and growth** (`a0e0ef2`)
- Multi-visit and prepaid tickets with QR scanning
- Expenses, books and payroll
- Follow-up emails, monthly subscription billing, read-only API keys
- "What can I do now" list, and memory of the owner's preferences
- Low-vision glow and vibration signals
- Starting without registering (shop kept on the device)

**Oct 26: payments and notifications** (`c307b41`)
- Payouts straight to each shop through Stripe Connect, with a guided sign-up
- 24-hour cut-off for online card payment, and release of unpaid card bookings after 30 minutes
- New bookings and payments spoken while the app is open
- Web Push notifications while it is closed

## License

[MIT](LICENSE) © 2026 by fifteen
