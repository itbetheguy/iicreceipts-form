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

## The URL contract

The app builds these links (`_ccSubmissionLink` in `app.js`). `upload.js` reads:

| Param | Meaning |
|---|---|
| `token` | the charge id — pre-fill + submission history + the localStorage key |
| `cardholder`, `vendor`, `amount`, `date` | shown on the page, and echoed back as the join key |
| `u=1` | force "update" mode (for the cross-device case, where localStorage is empty) |

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
focused, it shows the whole list, so it is a plain dropdown too. Required whenever the endpoint
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
