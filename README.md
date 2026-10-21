# GV Sheet Helper

A Chrome extension (Manifest V3) that sends Google Voice text messages to a list of contacts pasted from Google Sheets, Excel or a CSV file. It sends them one at a time, with a delay you choose. Everything happens in a side panel next to Google Voice:

- paste rows,
- review exactly what each person will receive,
- start, pause, resume or stop the queue,
- watch progress as it goes, and add new rows from your sheet while it runs.

> **Use responsibly.** Only text people who have agreed to hear from you. Messages go out from your own Google Voice account, one at a time. The extension does not get around Google's sending limits, CAPTCHAs or other safeguards, and delays don't guarantee you'll avoid restrictions. You're responsible for following Google's terms and messaging laws such as the TCPA.

---

## Features

- **Two ways to write messages.**
  - **From a sheet column:** each row has its own message.
  - **Same for everyone:** write one message in the extension; the sheet only needs phone numbers.
- **Variables.** `{{First Name}}`, `{{City}}` or any other column header inserts that row's value. This works in the shared message and inside Message cells.
  - **Forgiving names.** Matching ignores capitals and spacing.
  - **Fallbacks.** `{{First Name|there}}` uses "there" when the cell is empty.
  - **From a full-name column.** A "Name" column gives you `{{First Name}}` and `{{Last Name}}` automatically.
  - **Blocked when empty.** A row whose variable is empty, with no fallback, is held back so nobody gets "Hi ,".
- **Live preview.** You see the first finished message, a ready / to-fix count and clickable variable chips while you type. Each contact in the list expands to the exact text that will be sent.
- **Never texts the same number twice.** Every number you text is remembered across queues and days (as a one-way fingerprint, not the number itself). When you import your sheet again, numbers texted before are skipped automatically, so a sheet that grows every day only sends to the new rows. See [Daily sheets and the sent history](#daily-sheets-and-the-sent-history).
- **Spreadsheet-friendly import.**
  - **Load a Google Sheet by its link.** Paste the sheet's address-bar link once; the extension downloads the latest rows with your own Google sign-in every time you open the panel. The sheet can stay private.
  - **Upload a CSV file** (drag and drop or browse; CSV, TSV or TXT up to 2 MB) or **paste rows** copied from Sheets or Excel. Comma, tab and semicolon files all work.
  - Reads files in the encodings spreadsheet apps write: UTF-8 (with or without BOM), UTF-16 and older Windows/Excel exports, so accented names come through correctly.
  - Handles quoted fields with commas, quotes and line breaks, blank rows, and unquoted commas in a trailing message column.
  - Finds the header and phone column by itself, and validates every number with a specific reason when one is wrong.
- **Duplicate protection.** Repeated numbers are flagged. You choose to skip them (the default) or keep them.
- **Do-not-text list.** Numbers that replied STOP (or asked not to be texted) go on a list in **Settings**. They are never texted, not even with *Send again*, and the list survives *Clear history*. Adding a number takes it out of a running queue straight away.
- **Your call on every contact.** Before or during a run, **Don't send** takes one contact out of the queue (**Include again** puts it back). After checking Google Voice, **It was sent** resolves an *Unconfirmed* message without re-sending it.
- **Add new rows to a running queue.** Import again while a queue is running or paused and only the numbers that aren't in it yet (and weren't texted before) are added. Nothing stops.
- **A careful queue.**
  - Contacts go one at a time, never two at once.
  - The delay defaults to 60 s and can't go below 45 s.
  - **Random extra delay.** After every message a new random wait of 0 to N extra seconds (default 30) is added to the delay, so gaps are not all identical. Set it to 0 to turn it off.
  - **Sending hours.** Messages only go out between 8:00 AM and 9:00 PM on your computer's clock (the TCPA quiet hours are 9 PM to 8 AM). Change the hours or turn this off in **Settings**. Outside the hours the queue waits and continues by itself.
  - **Daily limit.** Set the most messages per day (0 = no limit, the default). Once reached, the queue waits for tomorrow's sending hours (or midnight, if sending hours are off) and then continues by itself. Every message where Send was pressed counts, across queues, so clearing or re-importing doesn't reset it.
  - Pause, resume and stop all work, and you can't start the queue twice.
  - The queue stops automatically after N failures in a row (default 3).
- **Know where it stands.** The queue shows a countdown to the next message and about how long is left; the toolbar icon shows how many are left (**II** paused, **!** stopped on a problem, **✓** finished); and a desktop notification tells you when a queue finishes or stops on a problem.
- **Results file.** The download button on the Contacts card saves a CSV (row, number, status, details) to update your sheet with.
- **Long messages.** Messages up to 5,000 characters go out in one piece. Typing is human-paced for the first 20 seconds; the rest is entered at once and checked like everything else.
- **Honest outcomes.** The status shows **Sent** (Google Voice accepted the message), **Failed**, or **Unconfirmed** (Send was pressed but the result couldn't be seen). An unconfirmed message is never retried automatically.
- **Survives restarts.** Progress is saved to `chrome.storage.local`, so the panel can be closed and reopened at any time. A Chrome or extension restart pauses the queue safely. The message you're writing is kept too, and settings save as you change them.
- **Keeps the tab alive.** While a queue runs, Chrome is told not to discard the Google Voice tab, and a tab that stops responding is reloaded once before the queue gives up.
- **Page check.** Shows which Google Voice controls the extension can find, without clicking anything.
- **Human-like behavior simulation.** Built-in anti-bot patterns simulate natural human interactions on Google Voice:
  - *Natural mouse movement:* moves cursor along cubic Bezier curved paths with variable acceleration, micro-jitter, and pre-click hesitation pauses.
  - *Human-like typing:* enters text in variable character chunks, adds punctuation/sentence pauses, and introduces occasional editing review.
  - *Reading & thinking pauses:* waits after opening the composer, pauses to inspect recipient suggestions, and scales pre-send proofreading pauses dynamically to message length.
  - *Natural scrolling:* scrolls conversation threads in multiple smooth increments with inspection pauses and realistic micro-scroll reversals.
  - *Context-aware interaction:* checks element visibility, interactability, and obstruction before clicking, and monitors confirmation bubbles and error toasts.
  - *Python & n8n Toolkits:* reusable automation modules in `tools/human_automation.py` (for Playwright/Selenium) and `tools/n8n_human_simulation.js` (for n8n Code Nodes).

## Installation

1. Open **`chrome://extensions/`** in Chrome (version 120 or later).
2. Turn on **Developer mode** (top-right switch).
3. Click **Load unpacked**.
4. Select the **`gv-sheet-automation`** folder (the one containing `manifest.json`).
5. Open **https://voice.google.com/** in a tab and sign in to the account you text from.
6. Click the extension's toolbar icon (pin it from the puzzle-piece menu if you don't see it). The side panel opens. The header should say **Connected**.

If the header says *Reload tab*, reload the Google Voice tab once. This happens when the tab was already open before the extension was installed.

## Using it

### 1. Prepare your sheet

**Message in the sheet:**

| Phone | First Name | Message |
|---|---|---|
| (212) 555-0147 | Sam | Hi {{First Name}}, your order is ready. |
| +1 646 555 0123 | Alex | Your appointment is at 3 pm. |

**Same message for everyone:** you only need the phone column, plus any columns you want to use as variables.

| Phone | First Name | Appointment |
|---|---|---|
| 212-555-0147 | Sam | Tue 3 pm |
| 646.555.0123 | | Wed 10 am |

Message: `Hi {{First Name|there}}, see you {{Appointment}}. Reply STOP to opt out.`
Row 3 has no name, so it gets "Hi there, see you Wed 10 am. …".

Notes:
- **Header row.** Keep the header row in your file (or include it when copying); that's how variables are found. A header row is optional when you don't use variables.
- **Getting a CSV.** Google Sheets: **File › Download › Comma-separated values (.csv)**. Excel: **File › Save As › CSV UTF-8**. `.xlsx` files can't be read directly; the extension tells you to export to CSV if you pick one.
- **Phone column.** Recognised headers include Phone, Phone Number, Mobile, Cell, Number and To. Any other name works too, as long as the column contains phone numbers.
- **Message column.** Recognised headers include Message, Text, SMS and Body. With only two columns, the non-phone column is the message.
- **Numbers.** Numbers without a country code are treated as US/Canada. Other countries need a leading `+` and the country code.
- **Excel.** If Excel shows numbers as `2.13E+09`, format the phone column as **Text** and copy again.

Example CSV (quotes are needed only around values that contain commas or quotes):

```text
Phone,Message
+12125550147,"Hi Sam, your order is ready."
(646) 555-0123,Your appointment is at 3 pm.
415.555.0188,"Reply ""STOP"" to opt out."
```

### 2. Import and review

1. **Add your contacts.**
   - **Google Sheet:** paste the link from the sheet's address bar and click **Load**. The card shows the sheet's name and row count. **Reload** fetches the latest rows; **×** disconnects it. The link is remembered and the sheet reloads by itself each time the panel opens.
   - **CSV file:** drop your CSV onto the drop zone or click **browse**. A file card shows the name, number of rows and the columns found; use **Replace** or **×** to change it.
   - **Paste:** paste rows copied from Sheets or Excel.
2. **Choose the message.** Pick **From a sheet column** or **Same for everyone**. For *Same for everyone*, write the message; click a variable chip to insert it.
3. **Review.** The preview shows the first new message and how many rows are ready, were texted before, or need fixing.
4. Click **Validate & preview**. The file or sheet is read in the panel and never stored or uploaded anywhere; only the imported contacts are saved for the queue. The Contacts list shows every row (use the search box to find a number, row or message):
   - **Pending** rows will be sent. Click a message to see the exact final text.
   - **Needs fixing** rows explain what's wrong and are never sent. Fix them in the sheet and import again.
   - **Duplicate** rows repeat an earlier number. Use **Skip / Keep** to choose; you can change this until sending starts.
   - **Texted before** rows are numbers you already texted in an earlier queue. They are skipped. To text them again in this one queue, choose **Send again**; the next import goes back to skipping them.
   - **Opted out** rows are on your do-not-text list and are never sent.
   - **Don't send** on any pending row skips just that contact (shown as *Skipped by you*). The **Skipped** filter lists every row that won't be sent and why.

### Daily sheets and the sent history

If new contacts are added to your sheet every day, you don't need to delete the old rows:

1. Link the sheet once (**Google Sheet** › paste the link › **Load**).
2. Each day, open the panel. The sheet reloads by itself and the preview shows, for example, *8 ready · 112 texted before*.
3. Click **Validate & preview**, then **Start queue**. Only the 8 new numbers are texted. (Importing always downloads the sheet's latest rows first.)
4. If yesterday's queue is still running or paused (for example, waiting on the daily limit), importing asks **Add to queue** or **Replace queue**. *Add* keeps the queue going and adds only the new numbers.

How it works:
- A number is added to the history when Google Voice accepts the message, and also when Send was pressed but the result couldn't be confirmed (it may have gone out). If Google Voice later reports that an unconfirmed message failed, the number is taken off again.
- The history keeps up to 50,000 numbers; beyond that the oldest are dropped. It lives only in this Chrome profile. Each number is stored as a salted SHA-256 fingerprint, so the history can say "texted before" but can't be read back as a list of numbers.
- **Settings › Sent history** shows how many numbers are remembered. **Add numbers you texted before** lets you paste numbers sent before you started using this (one per line, or a copied column). **Clear history** forgets them all.
- Duplicate rows *within* one import are handled separately, by **Skip / Keep**.

### 3. Send

1. Optionally, open **Settings** and set the delay (45–3,600 s), the random extra delay (0–3,600 s), the daily limit (0–1,000 messages; 0 = no limit), the sending hours (default 8:00 AM–9:00 PM), the failure limit (1–10) and desktop notifications. Changes save by themselves. With the defaults, each gap is between 60 and 90 seconds.
2. Click **Start queue** and confirm. The extension brings the Google Voice tab to the front. **Keep that tab open and visible**: Chrome slows down background tabs.
3. **Pause** holds the queue. A message that is already being sent finishes first (if it was the last one, the queue simply finishes). **Resume** continues, still honouring the delay, the daily limit and the sending hours.
4. **Stop** ends the run; unsent contacts stay pending. **Start queue** continues where it left off.
5. **Clear queue** removes the list, the template and all contact data. It asks first.
6. **Download results** (the arrow on the Contacts card) saves a CSV of every row and its outcome.

### What the statuses mean

| Status | Meaning |
|---|---|
| Pending | Waiting its turn. |
| Preparing / Prepared | The extension is filling in the composer. Nothing has been sent. |
| Sending | Send was pressed; waiting for Google Voice to show the result. |
| **Sent** | The message appeared in the conversation without a "Sending" or "Not sent" marker, so Google Voice **accepted** it. Carrier delivery can't be seen and is never claimed. |
| **Failed** | Not sent, with the reason shown. |
| **Unconfirmed** | Send was pressed but the outcome couldn't be seen, for example because the tab closed or the message stayed on "Sending". **Check the conversation in Google Voice before retrying.** |
| Duplicate | Same number as an earlier row; skipped unless you choose Keep. |
| Texted before | Texted in an earlier queue; skipped unless you choose Send again. |
| Opted out | On your do-not-text list; never sent. |
| Skipped by you | You chose **Don't send**; **Include again** puts it back. |
| Needs fixing | Invalid row; never sent. |

**Retrying.**
- **Retry failed** re-queues only contacts where Send was never pressed.
- Contacts that may already have gone out (Unconfirmed, or Failed after Send was pressed) have their own **Retry after checking…** button, which asks you to confirm first, and **It was sent**, for when you found the message in Google Voice.

## How it avoids double-sending

1. The content script fills in the recipient and message, then checks both: exactly one recipient with the right number, and the exact message text.
2. Before pressing Send, it asks the background service worker for permission.
3. The worker saves the contact as **Sending** before it says yes. Only then is Send pressed, once.
4. If anything interrupts after that point (a tab closing, a page reload, a Chrome or extension restart, a timeout), the contact becomes **Unconfirmed**, never "retry". A paused, stopped or cleared queue refuses permission, so nothing is pressed.
5. A watchdog checks the in-flight message every 30 s. The delay between messages uses `chrome.alarms`, so it survives the service worker being suspended.

## Privacy and permissions

| Permission | Why |
|---|---|
| `sidePanel` | The interface. |
| `storage` | Saves the queue, settings, activity log and sent history locally (`chrome.storage.local`). |
| `alarms` | The delay between messages and the watchdog, which must survive the service worker stopping. |
| `notifications` | The desktop notification when a queue finishes or stops on a problem (can be turned off in Settings). |
| `scripting` | Injects the content script into a Google Voice tab that was open before the extension was installed or reloaded. |
| Host: `https://voice.google.com/*` | The only site the extension interacts with. |
| Host: `https://docs.google.com/*`, `https://*.googleusercontent.com/*` | Downloads a linked Google Sheet as CSV. Google's export link redirects to a signed `googleusercontent.com` download. Nothing is sent to these hosts and no page there is read or changed. |

- **No other network traffic.** The only requests the extension makes are downloading a sheet you linked (from `lib/sheets.js`, the one file allowed to make requests; `npm run check` enforces it) and Google Voice itself, in your own browser. There are no analytics or tracking, no remote code and no third-party scripts.
- **Data is removed as soon as possible.** Message text is deleted from storage as soon as each message is sent. **Clear queue** removes all numbers, messages and the template (including the draft being written). The sent history and the do-not-text list keep only one-way fingerprints; **Settings › Sent history › Clear history** removes the texted numbers, and **Remove from list** takes numbers off the do-not-text list.
- **The results file is made in the panel** and saved by your browser; nothing is uploaded.
- **Your sheet stays private.** The sheet is downloaded with the Google sign-in already in this Chrome profile, so it doesn't need to be shared or published. Its rows are kept in the panel's memory only until you import them. Only the link is remembered.
- **Logs are minimal.** The activity log identifies contacts by row and the last four digits only, for example `Row 4 (…0147)`. The developer console never shows numbers or message text.
- **No credentials.** The extension never reads your Google credentials.

## Troubleshooting

| Message | What to do |
|---|---|
| *Google Sheets wouldn't open that sheet* | Check the link. The Google account signed in to this Chrome profile must be able to open the sheet. With several Google accounts signed in, the first one is used unless the link contains `/u/1/` (or `authuser=1`). |
| *Google asked for a sign-in* | Sign in to Google in this Chrome profile, then click **Reload** on the sheet card. |
| *Google Voice isn't open* | Click the header status (or open voice.google.com), then Start/Resume. |
| *You're not signed in to Google Voice* | Sign in in the Google Voice tab, then Resume. |
| *Google Voice is still loading* / *didn't finish loading* | Wait, or reload the tab, then Resume. |
| *Couldn't reach the Google Voice tab* | Reload the Google Voice tab. After updating or reloading the extension, also reopen the side panel. |
| *Couldn't find the "Send new message" button* / *recipient field* | Google Voice's layout may have changed. Run **Settings → Check page** and see [Updating selectors](#updating-selectors). |
| *A Google Voice dialog is blocking the page* | Read it in the tab (it may be a verification or sending-limit notice), deal with it yourself, then Resume. The extension never clicks through dialogs or CAPTCHAs. |
| *Google Voice didn't accept this phone number* | The number can't be texted from Google Voice (invalid, a landline or a short code). |
| *Couldn't confirm the recipient* | Usually a layout change, or a saved contact whose chip shows a name. Nothing was sent; retry, or run Check page. |
| *Google Voice reported that the message wasn't sent* | Check the conversation; Google Voice may be rate-limiting the account. Consider a longer delay. |
| *Send was pressed but Google Voice didn't confirm* | Look at the conversation. If the message is there, it was sent; don't retry. |
| *The tab was closed* / *navigated to a different site* | Reopen Google Voice and Resume/Start. |
| *Today's limit is used up* / *Paused for the day* | The daily limit was reached. Leave Chrome and the Google Voice tab open and the queue continues when tomorrow's sending hours start (midnight if they're off), or raise the limit in Settings to continue now. If Chrome is restarted overnight, the queue is paused; press Resume. |
| *Outside your sending hours* / *Waiting for sending hours* | The queue waits until the hours in **Settings** start. Change or turn off the hours there to send now. |
| *The Google Voice tab wasn't responding, so it was reloaded* | Chrome had frozen or discarded the tab during a long wait. The queue tries again 20 seconds later; if the tab still doesn't respond, it stops so you can look. |
| *Stopped after too many failures in a row* | Look at the activity log and the Google Voice tab before starting again. |
| *Processing was interrupted (Chrome or the extension restarted)* | The queue was paused for review. Check any **Unconfirmed** contact, then Resume. |
| *{{X}} isn't a column in your sheet* | Fix the spelling, or include the header row when copying. The error lists the variables you can use. |
| *{{X}} is empty for this row* | Fill in the cell, or add a fallback: `{{X|something}}`. |
| Messages go out slowly | Keep the Google Voice tab in front; Chrome throttles background tabs. |

## Updating selectors

Google Voice's page structure isn't a public API and changes without notice. All selectors live in **`gv-selectors.js`**, each with a note and several fallbacks (ARIA labels, roles, placeholders, Google Voice element names, then visible text).

1. Open Google Voice, then **Settings → Check page** in the side panel. Missing elements are listed. Elements marked *Not shown now* only appear while composing.
2. Right-click the missing element in Google Voice → **Inspect**, and add a selector to the matching `css` list in `gv-selectors.js`. Prefer `aria-label`, `role`, `placeholder` and element names over generated class names.
3. Reload the extension at `chrome://extensions/`, then reload the Google Voice tab.

These need checking against the current live interface:

- **Composer:** the new-message button, recipient input, suggestion row (e.g. "Send to (212) 555-0147"), recipient chip, message box and Send button.
- **Conversation:** the message list and bubble elements, plus the "Sending" and "Not sent" texts used to judge the outcome.
- **Sign-in and dialogs:** the signed-out page markers and the dialog detection.

## Testing

```bash
npm test          # 103 unit tests: parsing, variables, queue engine, recovery, validation, sending hours, opt-outs
npm run check     # manifest/MV3 rules, referenced files, syntax, no remote code, every button wired
npm run e2e       # end-to-end run in Chromium against a mock Google Voice page (~6 min)
```

`npm test` and `npm run check` use only Node.js 20+ with no dependencies. The queue tests drive the real `background.js` through mocked Chrome APIs. They cover:
- start, the delay between messages, double start, pause and resume, stop and clear;
- the consecutive-failure limit and the retry rules;
- the daily limit and sending hours, in any time zone;
- adding rows to a running queue, skipping a contact, marking a message as sent and the do-not-text list;
- tab closed, tab navigated away, page reload, timeouts, and worker or Chrome restarts at every stage;
- late confirmations, and rejection of invalid or foreign messages.

`npm run e2e` needs `playwright-core` (`npm i --no-save playwright-core`) and a Chromium binary in `CHROMIUM_PATH`. Branded Chrome no longer accepts `--load-extension`; Playwright's Chromium works. It loads the real unpacked extension and serves `tests/e2e/mock-voice.html` at `https://voice.google.com/`. It then drives the side panel through a full run and checks:
- exact message text, including variables, fallbacks and a line break;
- Send clicked once per message, and Enter never pressed in the message box;
- at least 45 s between sends;
- no automatic retry of a failed or unconfirmed message;
- state, the message being written and settings preserved when the panel is reopened;
- adding new sheet rows to a started and a running queue;
- a 1,500-character message sent in full, once.

**The mock reproduces this extension's assumptions about Google Voice, not Google Voice itself.** It proves the logic, not the selectors.

### Manual checklist for live Google Voice

Use two or three numbers you own, or contacts who have agreed to take part:

1. [ ] The header shows **Connected** with Google Voice open and signed in, and **Signed out** after signing out.
2. [ ] **Check page** on the Messages view finds the app navigation, Messages link and New message button.
3. [ ] Import two contacts with a 45 s delay and start. Watch the first send: new message opens, number entered, suggestion clicked, one recipient chip, message typed, Send pressed once.
4. [ ] The contact shows **Sent** only after the message appears in the conversation, and the second send waits about 45 s.
5. [ ] A multi-line message arrives as one message with line breaks (not split, not sent early).
6. [ ] A number saved in your contacts (its chip shows a name) is still sent to the right person.
7. [ ] Pause during the delay: nothing is sent; Resume continues.
8. [ ] Close the Google Voice tab mid-queue: the queue stops with *The Google Voice tab was closed*.
9. [ ] Reload the extension mid-queue: the queue pauses, and nothing is sent twice.
10. [ ] An invalid or landline number fails without sending anything.
11. [ ] If anything above fails, run **Check page** and update `gv-selectors.js`.

## Human-Like Behavior Simulation (Python & n8n Toolkits)

To safeguard automated workflows against automated bot flags and CAPTCHAs, the extension uses 5 human simulation techniques directly in Google Voice (`content.js`), and includes standalone toolkits for Python and n8n in `tools/`:

1. **Natural Mouse Movement:**
   - **Extension:** `simulateCurvedMouseMove()` and `naturalClick()` compute cubic Bezier trajectories with ease-in-out velocity curves, random perpendicular control point variations, micro-jitter, and pre-click hesitation pauses.
   - **Python:** `HumanMouse` in `tools/human_automation.py` generates Bezier trajectories and coordinates with Playwright / Selenium.
2. **Human-Like Typing:**
   - **Extension:** `simulateHumanTyping()` inputs text in 1–3 character chunks, applies realistic inter-keystroke pauses, longer pauses after punctuation (`.`, `!`, `?`, `,`), and simulates occasional realistic editing behavior (minor typo, pause, backspace, correct key) with strict integrity verification.
   - **Python & n8n:** `HumanKeyboard` in Python and `createHumanTypingPlan()` in `tools/n8n_human_simulation.js`.
3. **Reading and Thinking Pauses:**
   - **Extension:** `readingPause()` dynamically computes pauses based on context: waiting after page ready, inspecting recipient options, and dynamically scaling proofreading pauses based on message length.
   - **Python & n8n:** `HumanPacer` in Python and `getHumanDelay(taskType, text)` in n8n.
4. **Natural Scrolling:**
   - **Extension:** `simulateNaturalScroll()` scrolls conversation threads in smooth multi-increment steps with easing, pauses to inspect messages, and micro-scrolls back up to re-verify history.
   - **Python:** `HumanScroller` in `tools/human_automation.py`.
5. **Context-Aware Interaction:**
   - **Extension:** `isInteractable()` checks viewport bounds, display/visibility, blocking dialogs, and disabled states before interacting. Verifies thread bubbles ('sending' -> 'settled') and inspects error toasts.
   - **Python & n8n:** `ContextAwareSession` in Python and `evaluateResponseContext()` in n8n.

### Using the Python Toolkit (`tools/human_automation.py`)

```python
from tools.human_automation import HumanMouse, HumanKeyboard, HumanPacer, HumanScroller

# With Playwright:
mouse = HumanMouse()
keyboard = HumanKeyboard()

# 1. Natural curved mouse movement and click
await mouse.move_and_click_playwright(page, "button#send")

# 2. Human typing with chunks and punctuation pauses
await keyboard.type_playwright(element, "Hello Sam, see you at 3 pm!", allow_typos=True)

# 3. Dynamic proofreading pause scaled to message length
await HumanPacer.pause("proofread_review", content="Hello Sam, see you at 3 pm!")

# 4. Smooth incremental scrolling with inspection
await HumanScroller.scroll_playwright(page, target_delta_y=400, inspect=True)
```

### Using in n8n Code Nodes (`tools/n8n_human_simulation.js`)

Copy functions from `tools/n8n_human_simulation.js` into an n8n Code Node to add humanized pacing, message proofreading delays, and rate-limit backoff to Google Sheets / SMS automations.

## Project structure

```text
gv-sheet-automation/
├── manifest.json          Manifest V3 configuration
├── background.js          Service worker: queue engine, persistence, tab coordination
├── content.js             Google Voice page automation (one message per job)
├── gv-selectors.js        All Google Voice selectors, in one place
├── sidepanel.html/.css/.js  Side panel interface
├── lib/
│   ├── history.js         Sent history: salted fingerprints of numbers already texted
│   ├── parser.js          CSV/TSV parsing, phone validation, templates and variables
│   ├── protocol.js        Message types, validation schemas, error catalogue
│   ├── queue-model.js     Queue state model, counters, settings validation
│   └── sheets.js          Google Sheet links and the CSV download (the only network code)
├── icons/                 16/32/48/128 px icons (generated by tools/make-icons.mjs)
├── tests/                 Unit tests, Chrome API mock, e2e harness and mock page
└── tools/                 check.mjs (static checks), make-icons.mjs
```

## Known limitations

- **Not yet tested against the live Google Voice site.** Selectors and outcome detection have only been exercised against the mock page. Run the manual checklist before relying on it.
- **"Sent" means "accepted".** It means Google Voice accepted the message, not that the carrier delivered it.
- **Contact names in chips.** A recipient chip that shows a contact name (rather than the number) is accepted only when the suggestion the extension clicked showed exactly that number.
- **Background tabs.** Chrome throttles background tabs, so keep the Google Voice tab visible during a run.
- **Limits.** Up to 1,000 contacts to send per import (a sheet may have up to 5,000 rows when the rest were texted before), 2 MB per file or sheet, and 5,000 characters per message.
- **Sheet links are untested against a live private sheet.** The download path (export link, redirect, CSV) is checked against a public Google sample sheet and a mock, but not yet with a private sheet and a real sign-in. If a private sheet won't load, export a CSV instead and report the message shown.
- **Delays.** The delay is a floor between messages. It can't guarantee that Google won't limit or restrict an account.
