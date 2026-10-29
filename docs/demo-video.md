# Demo video script (2:30)

Target length: 2:30. The narration is about 210 words, which takes roughly 1:30 at a steady pace. The rest of the time is the owner and the app speaking.

Everything is in English: the app's screens, the owner's words and the app's voice. Captions show what the owner and the app say, so viewers can follow even with the sound off. The narrator speaks over silent or fast-forwarded shots only.

---

## Before you film

1. Reset the demo shop in English. You can run this as many times as you like.
   ```
   npx tsx scripts/seed-demo.ts --lang en
   ```
   It prints the login details and the booking page path:
   - email `demo@example.com` / password `12341234`
   - passphrase (spoken) `sunny room`. It is only asked for cancellations and settings, so you won't need it in this script
2. Film in Chrome on the Mac. Open the app, press **English** at the top right, and log in. Turn the volume up.
3. For the cash scene, Chrome on the Mac opens a file picker instead of the camera. Pick the photo of the 5,000-yen note, the 1,000-yen note and the 500-yen coin laid side by side (6,500 yen; Takahashi owes 5,000, so the change is 1,500). Copy it to the Mac beforehand. Film the real notes on the cloth separately with a phone for the cutaway.
4. Open the customer booking page (`/book/<slug>` from the seed output) in a second window, not logged in (an Incognito window).
5. Do one full rehearsal, then reset with step 1 before the real take. The rehearsal creates real bookings.
6. Film between 10:00 and 11:00. Scene 6 takes payment for Takahashi's 11:00 booking, and the opening announcement changes once that time has passed. Don't film on a Saturday: Sunday is a closed day, so the Tanaka booking for "tomorrow" would fail (the seed script warns you).

**Retakes:**
- Scenes 3, 5 and 7 are only questions. Redo them as often as you like.
- Scene 4 (Tanaka booking), scene 6 (recording the payment) and scene 8 (web booking) change the data. To redo any of them, reset the shop and start again from scene 2. If one of them goes wrong, keep filming to the end of the take, then reset.

What the demo shop contains:
- Customers: Ichiro Tanaka (bad lower back, likes firm pressure), Hanako Sato, Ken Suzuki, Misaki Takahashi
- Today: Takahashi at 11:00 (acupuncture, ¥5,000, pay at the shop) and Sato at 17:00
- Tomorrow: Sato at 10:00 and Takahashi at 16:00. **14:00–15:30 is free for the Tanaka booking.**
- About 45 days of past visits, so "this month's sales" gives a real figure (¥304,500 when last tested)
- This month's rent, supplies and utilities, so the advice question has numbers to work with
- No ticket types yet, so the ticket-price question gets a fresh answer

Emails are switched off for this shop, so nothing is sent to anyone while you film.

---

## Time-coded script

How to read this table:
- **Owner** and **App** lines are heard in the video and captioned. The app's lines show what it is expected to say. If the real answer is worded differently, caption what it actually says.
- **Narrator** lines are added in the edit. The narrator never talks over the owner or the app. Narration goes over silent or fast-forwarded shots only.
- **▶▶** marks a wait (speech being recognised, the model thinking). Fast-forward it ×8 with the sound off. Each one ends up about 1 second long.

| Time | Picture | Sound | Caption |
|---|---|---|---|
| **1. The problem** | | | |
| 0:00–0:13 | A practitioner's hands on a treatment table. Then a phone lying dark on the counter. | **Narrator:** In Japan, many massage and acupuncture practitioners are blind or have low vision. Booking tools are built for eyes, so many still rely on paper, phone calls, and help from someone who can see. | |
| **2. One button** | | | |
| 0:13–0:20 | The admin screen. One large glowing microphone button, nothing else. (Start after the opening announcement has finished.) | **Narrator:** GoYoyaku-chan Neo is one glowing button, easy to find with low vision. Everything else is voice. | |
| **3. Free time** | | | |
| 0:20–0:21 | The button is pressed (click, or the space bar). | *(button sound)* | |
| 0:21–0:23 | Screen, listening. | **Owner:** When am I free tomorrow? | When am I free tomorrow? |
| 0:23–0:24 | ▶▶ ×8 | *(muted)* | |
| 0:24–0:31 | Screen, speaking. | **App:** Tomorrow, Friday October 30, you're free at 11:30, 12:00 … 14:00, 14:30 and 18:00. *(cut the rest; the app may list times for 60 and 90-minute sessions)* | *(caption what it says)* |
| 0:31–0:37 | The button, glowing and still. | **Narrator:** Every answer comes from the shop's real bookings, through tool calls. Nothing is guessed. | |
| **4. Booking** | | | |
| 0:37–0:40 | Press the button. | **Owner:** Tanaka, tomorrow from 2 to 3:30. | Tanaka, tomorrow from 2 to 3:30. |
| 0:40–0:41 | ▶▶ ×8 | *(muted)* | |
| 0:41–0:47 | Screen, speaking. | **App:** Shall I book Tanaka from 2:00 PM to 3:30 PM on Friday, October 30, paying at the shop? | Shall I book Tanaka from 2:00 PM to 3:30 PM on Friday, October 30, paying at the shop? |
| 0:47–0:48 | Press the button. | **Owner:** Yes. | Yes. |
| 0:48–0:49 | ▶▶ ×8, then the screen. | **App:** Booked. | Booked. |
| 0:49–1:01 | The button, glowing. | **Narrator:** Nothing is written until the app reads it back and hears a yes. For someone who can't check a screen, a confident "done" that isn't true is the worst failure. | |
| **5. Sales** | | | |
| 1:01–1:03 | Press the button. | **Owner:** What are this month's sales? | What are this month's sales? |
| 1:03–1:04 | ▶▶ ×8 | *(muted)* | |
| 1:04–1:07 | Screen, speaking. | **App:** This month's sales are 304,500 yen. *(the figure depends on the filming date)* | *(caption what it says)* |
| **6. Taking payment** | | | |
| 1:07–1:09 | Press the button. | **Owner:** Check Takahashi's cash. | Check Takahashi's cash. |
| 1:09–1:16 | Cutaway (phone footage): the 5,000 and 1,000-yen notes and the 500-yen coin on the dark cloth, shot from straight above. Back on the Mac, the photo is chosen. ▶▶ for the wait. | *(app sound muted)* **Narrator:** Japanese notes can be told apart by touch. For other cash, a photo is a quick second check. | |
| 1:16–1:21 | Screen, speaking. | **App:** …6,500 yen in total. The fee is 5,000, so the change is 1,500. *(cut the count of each note)* | *(caption what it says)* |
| 1:21–1:23 | Press the button. | **Owner:** Record it as received in cash. | Record it as received in cash. |
| 1:23–1:24 | ▶▶ ×8 | *(muted)* | |
| 1:24–1:28 | Screen, speaking. | **App:** Should I record that you received 5,000 yen in cash from Misaki Takahashi …? | *(caption what it says)* |
| 1:28–1:29 | Press the button. | **Owner:** Yes.  **App:** Recorded. | Yes. / Recorded. |
| 1:29–1:36 | The button, glowing. | **Narrator:** What matters is the record. Cash, card, or QR payments like PayPay: every payment is logged by voice. | |
| **7. Advice** | | | |
| 1:36–1:38 | Press the button. | **Owner:** What should a multi-visit ticket cost? | What should a multi-visit ticket cost? |
| 1:38–1:39 | ▶▶ ×8 (the advisor takes longer, so the wait is longer before speeding up) | *(muted)* | |
| 1:39–1:46 | Screen, speaking. | **App:** *(the first two or three sentences of the advice)* | *(caption it)* |
| 1:46–1:53 | The button, glowing. | **Narrator:** Questions like this go to the advisor, which answers from the shop's own prices, visits and costs. | |
| **8. The customer side** | | | |
| 1:53–2:04 | Split screen: the Incognito window on the left, the owner's screen on the right. In the Incognito window, book Ken Suzuki for a 60-minute massage tomorrow at 11:30, paying at the shop. ▶▶ through the form and the wait (up to 20 seconds). | *(muted)* **Narrator:** Customers book on an ordinary web page, and can pay at the shop or by card in advance. The owner hears about it right away, by voice. | |
| 2:04–2:10 | Split screen, the owner's screen speaking. | **App:** One new online booking: Ken Suzuki on Friday, October 30 at 11:30. | *(caption what it says)* |
| **9. Close** | | | |
| 2:10–2:25 | The glowing button, slowly fading out. | **Narrator:** All of the AI is NVIDIA Nemotron, including the vision model that counts cash. We tried the faster model first. It said "booked" when nothing was booked, so we chose Super. | |
| 2:25–2:30 | Title card: *GoYoyaku-chan Neo — built on NVIDIA Nemotron.* | **Narrator:** GoYoyaku-chan Neo: your shop, by voice alone. | |

---

## Notes for each scene

### 2. One button
Every time the admin screen opens, the app reads today's schedule aloud ("You have 2 bookings today. Next is Misaki Takahashi at 11…"). Wait for it to finish before you start this shot, or cut it in the edit.

### 6. Taking payment
Keep the cash photo short. The point of this scene is that the payment is recorded safely. When the file picker opens, the app says "Opening the camera…". That line is muted under the narration.

### 8. The customer side
Keep the owner's window on the admin screen, with the button idle. The app checks for new bookings every 20 seconds, so the announcement comes up to 20 seconds after the booking. It only announces while the window is visible and the app is not in the middle of a conversation. If it stays silent, check that the owner's window is in front and that the previous answer has finished.

Tomorrow at 11:30 is the first free time after Sato (her session ends at 11:00, and 15 minutes are kept free between sessions). Tanaka starts at 14:00.

---

## Editing tips
- Fast-forward the waits instead of cutting them (the ▶▶ rows). Speed them up 6 to 8 times, mute the sound, and show a small "▶▶ ×8" mark in a corner. That is where most of the time goes, and showing the waits openly tells viewers nothing was hidden.
- The app's voice comes from the Mac mini speaker. Record the room sound with the Android phone's voice recorder, and clap once at the start of each take so you can line the sound up with the screen recording in Canva.
- The app's answers may be longer than the table allows. Cut them at the end of a sentence.
- If you are still over 2:30, shorten the cash photo in scene 6 first (keep the recording part), then drop scene 5.
