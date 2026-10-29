# Demo video script (under 3 minutes)

Target length: about 2:45. The narration is about 260 words, which takes roughly 1:50 at a calm pace. The rest of the time is the app speaking.

The owner speaks to the app in Japanese. Show English subtitles for everything the owner and the app say. The narrator speaks English over the top.

---

## Before you film

1. Reset the demo shop. You can run this as many times as you like.
   ```
   npx tsx scripts/seed-demo.ts
   ```
   It prints the login details and the booking page path:
   - email `demo@example.com` / password `demo-pass-2026`
   - passphrase (spoken) `ひだまり`. It is only asked for cancellations and settings, so you won't need it in this script
2. Log in on the phone you will film. Turn the screen brightness and the volume up.
3. For the cash scene, lay out a 5,000-yen note, a 1,000-yen note and a 500-yen coin side by side on a dark cloth, not overlapping (6,500 yen; Takahashi owes 5,000, so the change is 1,500). Keep a 10,000-yen note as a backup.
4. Open the customer booking page (`/book/<slug>` from the seed output) in a second browser, not logged in.
5. Do one full rehearsal, then reset with step 1 before the real take. The rehearsal creates real bookings.

What the demo shop contains:
- Customers: 田中 一郎 (bad lower back, likes firm pressure), 佐藤 花子, 鈴木 健, 高橋 美咲
- Today: 高橋 at 11:00 (acupuncture, ¥5,000, pay at the shop) and 佐藤 at 17:00
- Tomorrow: 佐藤 at 10:00 and 高橋 at 16:00. **14:00–15:30 is free for the Tanaka booking.**
- About 45 days of past visits, so "this month's sales" gives a real figure (¥304,500 when last tested)
- This month's rent, supplies and utilities, so the advice question has numbers to work with
- No ticket types yet, so the ticket-price question gets a fresh answer

Emails are switched off for this shop, so nothing is sent to anyone while you film.

---

## Shot list and narration

### 1. The problem (0:00–0:18)
**Picture:** A practitioner's hands on a treatment table, or the phone lying dark on the counter.

**Narration:**
> In Japan, many massage, acupuncture and shiatsu practitioners are blind or have low vision. Booking tools are built for eyes: calendars, forms, small buttons. So many of them still rely on paper, phone calls, and help from someone who can see.

### 2. One button (0:18–0:32)
**Picture:** The admin screen. One large glowing microphone button, nothing else.

**Narration:**
> GoYoyaku-chan Neo turns that around. The whole screen is one button. It glows, so it is easy to find with low vision. Everything else happens by voice.

### 3. Free time (0:32–0:50)
**Picture:** Press the button.

| Owner says | Subtitle |
|---|---|
| 明日の空いている時間は？ | When am I free tomorrow? |

Let the app answer. Subtitle its answer. You can cut the end of the answer if it is long.

**Narration (after the answer):**
> Every answer comes from the shop's real bookings, through tool calls. Nothing is guessed.

### 4. Booking (0:50–1:20)

| Owner says | Subtitle |
|---|---|
| 田中さん、明日2時から3時半 | Tanaka, tomorrow from 2 to 3:30 |
| *(app reads one confirmation sentence)* | *(subtitle it)* |
| はい | Yes |

**Narration (over the confirmation):**
> Before anything is written, the app reads back one sentence and waits for a yes. For someone who can't glance at a screen to check, a confident "done" that isn't true is the worst failure. So nothing changes without a yes.

### 5. Money questions (1:20–1:35)

| Owner says | Subtitle |
|---|---|
| 今月の売上は？ | What are this month's sales? |

Then, if there is time:

| Owner says | Subtitle |
|---|---|
| 未払いは？ | Anything unpaid? |

(佐藤 came yesterday and has not paid yet. The app should mention that.)

### 6. Taking payment (1:35–1:55)
Keep the cash photo short. The point of this scene is that the payment is recorded safely.

**Picture:** A quick cut of the photo being taken: the two notes and the coin on the dark cloth, side by side, shot from straight above. Cut the app's spoken count down to the total and the change.

| Owner says | Subtitle |
|---|---|
| 高橋さんのお金を確認 | Check Takahashi's cash |
| *(photo, then the app reads the total and the change)* | *(subtitle it)* |
| 現金で受け取ったと記録して | Record it as received in cash |
| はい | Yes |

**Narration:**
> Japanese notes can be told apart by touch. For other cash, a photo is a quick second check. What matters is the record. Cash, card, or QR payments like PayPay: every payment is logged by voice.

### 7. Advice (1:55–2:15)

| Owner says | Subtitle |
|---|---|
| 回数券はいくらにすべき？ | What should a multi-visit ticket cost? |

Cut the answer to its first two or three sentences.

**Narration:**
> Questions like this go to the advisor, which answers from the shop's own prices, visits and costs.

### 8. The customer side (2:15–2:32)
**Picture:** The second browser. Book 鈴木 健 for a 60-minute massage, paying at the shop. Then go back to the owner's phone and open the admin screen. The app reads out the new booking.

**Narration:**
> Customers book on an ordinary web page, and can pay at the shop or by card in advance. The owner hears about it the next time they open the app.

### 9. Close (2:32–2:47)
**Picture:** The glowing button again. Then a title card: *GoYoyaku-chan Neo — built on NVIDIA Nemotron.*

**Narration:**
> All of the AI is NVIDIA Nemotron: Super for every spoken request and for advice, and the vision model for cash. We tried the faster model first. It said "booked" when nothing was booked. So we chose the one that never does. GoYoyaku-chan Neo: your shop, by voice alone.

---

## Editing tips
- Cut the pauses while speech is being recognised and while the model is thinking. That is where most of the time goes.
- Record the phone's sound directly (screen recording with sound) so the app's voice is clear.
- If you are over 3:00, drop the 未払いは？ question in scene 5 first, then the cash photo in scene 6 (keep the recording part).
