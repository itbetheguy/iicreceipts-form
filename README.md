<!-- t537 - an UPDATE can be submitted again. upload.js sends `update=1` whenever the form is in update mode (a
     receipt is already on file), and api/submit.js skips its require_store / require_description / require_category
     backstop for one - checking the claim against cc-submission-status and recording the verdict in the email as
     `update_confirmed`. RULE: this form's rules live in TWO places. A rule relaxed in upload.js must be relaxed in
     api/submit.js in the same build, or the server refuses what the form just offered (his "?? cant submit updates?"). -->

# The receipts form — the public half of the credit-card tracker

**This is a SEPARATE repo and a SEPARATE Vercel project** (`iicreceipts-form` →
`iicreceipts-form.vercel.app`). It deploys on its own, independently of the main app.

It is deliberately separate for one reason: **it is public and unauthenticated, and it must never
go down.** Cardholders open it from a link in an email and upload a receipt — no login, no company
code, no PIN. Merging it into the main app would tie its uptime to that app's deploys.

The main app lives in `../live/`. Its side of this story is documented in
`../live/docs/credit-card-tracker.md`.

---

## The files

| File | What it does |
|---|---|
| `index.html` | The whole page. Two `?v=` cache tags near the bottom — **bump BOTH** on any change to `upload.js` or `upload.css`, or nobody receives it. |
| `upload.js` | All the client logic: reads the charge out of the URL, renders the store picker and the category search box, validates, submits. |
| `upload.css` | Styling. |
| `api/submit.js` | The one endpoint. Emails the submission (fields as JSON + the files) **from** the tracker's Gmail **to** `TO_ADDRESS`. |

---

## How a receipt actually gets home — the part that surprises everyone

There is **no shared database**. This form does not write to Supabase. It sends an **email**, and
the main app's mailbox scan reads it back:

```
cardholder opens the link
   → picks store(s), picks a category, types a description (optional), attaches a photo/PDF
   → api/submit.js emails it FROM the tracker gmail TO cc@iicorp.org
   → that gmail keeps a copy in [Gmail]/Sent Mail
   → the main app's scan reads Sent Mail and attaches the receipt to its charge
```

**The charge is identified by vendor + amount + date, NOT by the token.** The token
(`?token=<charge id>`) is what pre-fills the form and lets the app serve back "already submitted"
history, but `cc_transactions` in the cloud has no token column and the imported historical
charges lost theirs — so the match is on the three facts every submission carries.

**Consequence: never remove `vendor`, `amount` or `date` from the submitted JSON.** They are the
join key. Adding fields is safe; removing or renaming these is not.

---

## Big uploads (t471) - the 4.5 MB ceiling

Vercel refuses a request body over **4.5 MB** before `api/submit.js` ever runs, so the old form - one request
carrying every file - failed outright on a couple of phone photos, with a blank "Submission failed:" (the server's
24 MB limit in `submit.js` was never reachable). Since t471 `upload.js`:
- **shrinks photos** in the browser first (`shrinkPhoto`: long side 2000 px, JPEG 0.85, the right way up; a file it
  can't read, a PDF, or a photo already under 900 KB goes as it is);
- **sends in parts** (`packSends`, `SEND_LIMIT` = 3.9 MB of files per request, in the order picked); every part is
  a normal submission on the same link - same fields, its own email - and the app files them all on the charge;
- **refuses by name** a single file still over the limit, before anything is sent (`tooBigMessage`);
- when a part fails, **says what went** ("Part 1 of 2 WAS sent (1 file). The next part didn't go - …") and a second
  press sends **only what didn't** (`SENT_FILES`);
- **never shows a blank reason** (`failMessage`: the server's words, else "error <status>") and **scrolls the
  message into view** - on a phone it sits under three buttons.
Tests: `live/tests/cc_waiting_test.js` §4. The done screen after several parts says how many went.

---

## A rejection is a tile (t472) - and the email route, with a receipt code

His words: "I don't like the notification of rejection being on the bottom of the field. Make it a an overlay tile
saying why it failed and they can x it out to dismiss. And also put 'reply to email with the submission' with text.
Make the close or x or dismissible button copy the text pastable automatically. Also say it copied automatically." +
"The text pastable can be some sort of legible code the program can pick up on scan."
- EVERY rejection is `showProblem` - a tile over the form with a title, why it failed, and an ✕ (the old line under
  the buttons is hidden; progress - "Submitting…", "Sending part 2 of 3…" - still uses that line). `setStatus(msg,
  "error", field)` routes there; closing a field-to-fix tile puts the cursor in that field.
- When the FILE can't go through the form (too big, or the send failed / couldn't reach the server), the tile adds
  "Send it by email instead": reply to the email that sent you this link, attach the file, paste this text - and shows
  the text (`emailTextFor`): the charge's line, `Receipt code: IIC-XXXX-XXXX-XXXX` (`receiptCode(token)` - the first 12
  hex digits of the charge id; an old desktop link's base64url token gives the same code), and the store / category /
  description already filled in. With no code (an odd link) the link itself rides along.
- The ✕, the "Copy the text & close" button and Escape all COPY that text (`copyText`: the clipboard, else the older
  copy command), close the tile and say so ("✓ Copied automatically - paste it into your reply email"). A browser that
  refuses to copy keeps the tile open, selects the text and says how; the next close closes.
- The tracker's mailbox check reads the reply (the app's `api/_cc-parse.js` `parseReceiptReply`; docs §8d): the code
  names the charge, so the file lands on it even when someone changes the subject or starts a new email.
Tests: `live/tests/cc_waiting_test.js` §5 (and the round trip: the copied text read back by the app's reader),
`live/tests/cc_reply_test.js` §1 (the code on both sides). Clicked through at phone size: too big, a field to fix, a
failed send, a refused copy, Escape.

---

## The URL contract

The app builds these links (`_ccSubmissionLink` in `app.js`). `upload.js` reads:

| Param | Meaning |
|---|---|
| `token` | the charge id — pre-fill + submission history + the localStorage key |
| `cardholder`, `vendor`, `amount`, `date` | shown on the page, and echoed back as the join key |
| ~~`u=1`~~ | **ignored since t474** - it forced update mode on a charge with no submission yet; no link ever carried it, and the tracker's own "already has the file" answer covers the other-device case |

## The store field has three modes

Configured in the main app under **Settings → Credit Cards → Submissions**, served to this form by
the public `/api/cc-form-options` endpoint over there:

- **free** — a plain text box (the original behaviour).
- **dropdown** — pick from the list, but a typed value is still accepted.
- **locked** — a typed value that is not on the list is refused.

Multiple stores can be picked; each becomes a removable chip, and the charge is then **split evenly
across them** by the app. The submission carries both shapes at once — `stores` (the new list)
*and* `store` / `store_code` / `store_kind` (the single-pick fields, where `store` is the joined
`"JIB 0640 + JIB 0765"` label). That is deliberate: see back-compatibility below.

**If the options endpoint fails for any reason, the field falls back to the plain text box and the
form still submits.** Never let a decoration break the submission — that is the uptime rule.

## The store suggestions open right under the field (t512)

His words, with a screenshot of "sma" typed in Store / location: *"why is the suggestion so far below the fiedl?"* The
store hint ("If the charge isn't for anything restaurant related, choose ...") was inserted right after the INPUT - inside
the combobox box (`.cc-combo`) - and the suggestion list opens under the bottom of that box (`top: calc(100% + 4px)`), so
it opened under two lines of small print: 56px below the field on a computer, 80px on a phone, covering the top of the
Category box. The hint now goes under the whole box (`hintUnder(wrap, ...)`, the way the Category box's hint always has):
the list opens 4px under the field and lies over the hint while it is open; with the list closed nothing on the page
moved. Proven on the real form served from disk with the live options list (`scratchpad/form512.py`, before = t501).

## Every pick ADDS a file; every file has an ✕ (t501)

His words: *"i uploaded one file then i tried to upload another two and it removed my first?? why?? i should also be
able to see an x next to my uploads to remove them."* A file box replaces its whole selection every time it is used -
a second pick dropped the first, and on a phone each new photo taken wiped the one before. `upload.js` keeps the form's
OWN list (`PICKED`): every pick adds to it (the same file picked twice is listed once), every file on the list has an
✕ that takes it off, the file box is set back to the whole list after each pick or ✕ (so it reads "3 files"), and
Submit sends `PICKED`. Up to 20 files (the server's `MAX_FILES` per send); a pick past that is refused in a tile that
says how many weren't added. An older browser without `DataTransfer` gets an emptied box - the list below is what goes.
Pinned by the app repo's `tests/cc_waiting_test.js` section 7.

## The category field (t424)

His words: *"I need the form to have a field called category. i will give you a list of items that
will translate over to gl codes. this should be a mandatory field. then description can be
optional."* The list lives in the app; the form only ever sees **labels** — the GL codes never
leave the app.

It is a **locked search box**: typing ranks the admin's list closest-first (whole label, then
"starts with", then a word starts with it, then "appears anywhere", then typo-tolerant — the
ranking is the app's `api/_cc-category.js` copied verbatim into `upload.js`, so both sides agree),
arrows move the highlight, Enter or a click picks, and only a label from the list is ever
submitted (a typed non-label is refused with *"Pick a category from the list."*). Empty and
focused, it shows the whole list **A to Z** (t500 - his "want categories by alphabetical order"; equally close matches
are A to Z too - the app's `catAlpha`, copied verbatim), so it is a plain dropdown too. Required whenever the endpoint
hands over a list, unless the admin unticks it.

**Never-go-down rule, again:** with no list (endpoint down, or nothing configured yet) it is a
plain, **optional** text box that says so, and the submission goes through. Description is
optional unless the admin ticks it.

### What `/api/cc-form-options` sends this form

| Field | Meaning |
|---|---|
| `options`, `store_field_type`, `store_hint`, `require_store` | the store field (above) |
| `category_options` | `[{ label }]`, labels only, in the admin's order |
| `require_category` | default `true` when the list is non-empty |
| `category_hint` | small print under the category field (may be `""`) |
| `require_description`, `description_hint` | description is optional unless ticked; its small print |
| `require_photo` | photo required on a first visit unless `false` |

The submission carries `category` (the picked label, or `""`) alongside everything else — never
instead of anything.

---

## 🔴 Back-compatibility, in BOTH directions

The two repos deploy separately, so at any moment either side can be older than the other.
**Every change must work old-app/new-form AND new-app/old-form.**

The safe sequence is always: **ship the tolerant reader first, the new writer second.**

- Adding a field to the submission: add the app-side parser (defensively, tolerating its absence)
  and deploy that. *Then* start sending it.
- Never remove or rename a field the app still reads.
- Never make the app require a field the deployed form does not yet send.

## Environment (set in this project's Vercel, not the app's)

| Var | What it is |
|---|---|
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | the mailbox the submission is sent **from**. Must be a Gmail **app password** — the account password fails with a confusing error. |
| `TO_ADDRESS` | where submissions are sent. The app reads the **Sent** copy, so this is a free choice. |

## Gotcha worth knowing

**A push here can silently fail to trigger a Vercel deploy.** After pushing, check that the
deployed page actually serves your change (the `?v=` tag is the quickest tell). If it did not
fire, push a fresh commit.

## Nothing is required once a receipt is on file (t473)

His (9/29): *"when a submission is already there, i dont need any of the fields required pls."* The admin's settings
(Settings → Credit Cards → Submissions: store / category / description required) decide a FIRST submission only. Once a
receipt is on file — this device sent one, or the tracker says it has the file(s) (t474: nothing else) — every field
reads **(optional)**, the button says **Submit update**, and nothing is asked for. `paintRequired()` is the one painter
for the three labels (run after the settings load AND when update mode switches on, so neither order can leave
"(required)" up); `updateModeFields()` is what both ways into update mode call. Still refused: a store typed that isn't
on a locked list (a wrong value, not a missing one), and an update with no file and every box empty (it would send an
email that changes nothing - "Nothing to update yet"). Safe because the tracker never blanks a field an update leaves
empty (cc-admin.js: a photo-less update patches only the fields that came filled in).

## Optional ONLY after a real submission (t474)

His (9/29): *"the form fields should only become optional when a submission has already happened. so on first submission,
everything required stays required. if reloaded for an update, nothing should be REQUIRED, just optional so that i can
change what i need accordingly."* Update mode (every field optional) now switches on for exactly two reasons:

- **this device sent a receipt submission** — `localStorage cc_sent_<token>`, written only after a submission part went
  through (`submitReceipt`); or
- **the tracker already holds the charge's file(s)** — `cc-submission-status` answers `files`, from any device.

Two holes closed: a **temporary-hold mark** used to write the "already submitted" key too (`cc_submitted_<token>`), so a
device that had marked a hold opened the charge's FIRST receipt with every field optional — it writes nothing now, and the
old key is no longer read (a receipt sent before this build is already in the tracker, which switches update mode on by
itself). And **`?u=1`** no longer forces update mode (it could make a first submission optional; no link ever carried it).

