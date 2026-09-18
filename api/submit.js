// api/submit.js — Vercel serverless function
//
// Accepts a multipart/form-data POST from the receipt form (or a
// JSON POST for fraud reports), packages the submission as an email
// with attachments, and sends it via Gmail SMTP to TO_ADDRESS.
//
// Env vars (set in Vercel dashboard → Project → Settings → Environment Variables):
//   GMAIL_USER   — your gmail (e.g. raheemiicorpcreditcard@gmail.com)
//   GMAIL_PASS   — a Google App Password (NOT your regular Gmail
//                  password). See SETUP-VERCEL.md for how to generate one.
//   TO_ADDRESS   — where to send submissions (e.g. cc@iicorp.org)

const Busboy = require("busboy");
const nodemailer = require("nodemailer");

module.exports.config = {
  api: { bodyParser: false },
};

const SUBJECT_PREFIX = "[CC-RECEIPT]";
const MAX_FILES = 20;
const MAX_FILE_BYTES = 25 * 1024 * 1024;   // 25MB per file
const MAX_TOTAL_BYTES = 24 * 1024 * 1024;  // ~24MB total (Gmail SMTP cap)

module.exports = async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ error: "method not allowed" });
    }

    const env = {
      user: process.env.GMAIL_USER || "",
      pass: process.env.GMAIL_PASS || "",
      to:   process.env.TO_ADDRESS || "",
    };
    if (!env.user || !env.pass || !env.to) {
      return res.status(500).json({ error: "server not configured (missing env vars)" });
    }

    const ctype = (req.headers["content-type"] || "").toLowerCase();

    let payload;
    if (ctype.startsWith("multipart/form-data")) {
      payload = await parseMultipart(req);
    } else if (ctype.startsWith("application/json")) {
      payload = { fields: await readJson(req), files: [] };
    } else {
      return res.status(415).json({ error: "unsupported content type" });
    }

    const f = payload.fields || {};
    const files = payload.files || [];

    const token = (f.token || "").trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(token)) {
      return res.status(400).json({ error: "invalid token" });
    }

    if (files.length > MAX_FILES) {
      return res.status(413).json({ error: `too many files (max ${MAX_FILES})` });
    }
    let total = 0;
    for (const file of files) {
      if (file.content.length > MAX_FILE_BYTES) {
        return res.status(413).json({ error: `"${file.filename}" too large (max 25MB)` });
      }
      total += file.content.length;
    }
    if (total > MAX_TOTAL_BYTES) {
      return res.status(413).json({ error: "total upload too large — please send fewer or smaller files" });
    }

    const fraud = !!f.fraud;
    const meta = {
      token,
      cardholder:  f.cardholder  || "",
      vendor:      f.vendor      || "",
      amount:      f.amount      || "",
      date:        f.date        || "",
      store:       f.store       || "",
      store_code:  f.store_code  || "",
      store_kind:  f.store_kind  || "",
      /* t424 - his "field called category": the label the cardholder picked from the admin's
         list (the app turns it into a GL code; the codes never come through here). An empty
         string when none - an app build that doesn't read `category` books the submission
         exactly as before. */
      category:    f.category    || "",
      description: f.description || "",
      submitted_at: new Date().toISOString(),
      file_count:  files.length,
    };
    /* cloud402 - SEVERAL stores on one charge. `meta` is built key by key, so a field that
       isn't named here never reaches the email. Parsed defensively: a malformed value is
       dropped and `store` (which already carries the joined label) still books the charge. */
    if (f.stores) {
      try {
        const list = JSON.parse(String(f.stores));
        if (Array.isArray(list) && list.length) {
          meta.stores = list.slice(0, 12).map((s) => ({
            store: String((s && s.store) || "").slice(0, 120),
            code:  String((s && s.code)  || "").slice(0, 40),
            kind:  (s && s.kind) === "company" ? "company" : "store",
          })).filter((s) => s.store);
          if (!meta.stores.length) delete meta.stores;
        }
      } catch (_) { /* the joined `store` string above still carries the answer */ }
    }
    if (fraud) {
      meta.fraud = true;
      meta.note = f.note || "";
    }
    if (f.temp_charge) meta.temp_charge = true;   // cloud246 - hotel/rental hold, no receipt

    /* cloud274 #8 - enforce the admin's require_store / require_description toggles on the
       SERVER too. The client gate is bypassable by design (the never-go-down rule keeps the
       plain box working when the options endpoint fails), so it can't be the only guard.
       Skipped for fraud / temporary-hold submissions (those legitimately have no store).
       cloud342 (audit) - FAIL OPEN when settings can't be read: the old code failed CLOSED on the
       store, but during a settings-endpoint blip the CLIENT (which reads the same endpoint) also
       can't flag store required, so a cardholder who left it blank because nothing said otherwise
       got hard-rejected with no email sent - the exact "form goes down" outcome the never-go-down
       rule forbids. When reqs is null we skip enforcement (the submission still emails and the sweep
       reconciles; the store can be corrected later); we only enforce a requirement we could confirm. */
    if (!fraud && !f.temp_charge) {
      const reqs = await fetchRequirements();
      if (reqs) {
        if (reqs.require_store && !String(f.store || "").trim())
          return res.status(400).json({ error: "Please choose which store (or company) this charge is for." });
        if (reqs.require_description && !String(f.description || "").trim())
          return res.status(400).json({ error: "Please add a short description — accounting needs it to book the charge." });
        /* t424 - "this should be a mandatory field": the same server-side backstop the store and
           description have. Only the PRESENCE is checked here - whether the label is on the list is
           the client's job (a plain-box submission during an endpoint blip must still land; the app's
           reader tolerates a label it doesn't know). */
        if (reqs.require_category && !String(f.category || "").trim())
          return res.status(400).json({ error: "Category is required." });
      }
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: { user: env.user, pass: env.pass },
    });

    await transporter.sendMail({
      from: env.user,
      to: env.to,
      subject: `${SUBJECT_PREFIX} ${token}`,
      text: JSON.stringify(meta, null, 2),
      attachments: files.map(file => ({
        filename: file.filename || "receipt.bin",
        content: file.content,
        contentType: file.contentType || "application/octet-stream",
      })),
    });

    /* cloud337 - INSTANT for EVERY submission. His ask: "u cant make all this instant? submissions
       instant too?... why wait 5 minutes." Tell the processor RIGHT NOW so the charge updates
       immediately - fraud flips to fraud + alerts, a temp charge flips to Temp, and a receipt
       advances No-receipt -> Submitted - instead of waiting up to ~5 min for the next mailbox
       sweep. The emailed submission above is still the record and the sweep still attaches the
       actual receipt FILE, so a hiccup here never fails the form. */
    let instant = null;
    try {
      const REPORT_URL = process.env.CC_REPORT_FRAUD_URL || "https://iicorp-ip.vercel.app/api/cc-report-fraud";
      /* cloud340 - the processor flips the status FIRST thing, then may fetch the original Citi
         email over IMAP before emailing the alert - which can be slow. Bound OUR wait to ~7s so a
         slow alert never hangs (or, on the platform's own timeout, ERRORS) this form: the flip has
         already happened server-side, and the mailbox sweep is the durable backstop for the alert.
         The submission email above is already sent, so the record is safe regardless. */
      const _ac = new AbortController();
      const _to = setTimeout(() => { try { _ac.abort(); } catch (_) {} }, 7000);
      try {
        const _r = await fetch(REPORT_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // cloud342 (audit) - file_count so the processor doesn't advance a FIELDS-ONLY update (0 files)
          // to "submitted" (marking a receipt received that isn't there).
          body: JSON.stringify({ token: token, note: f.note || "", cardholder: f.cardholder || "",
            fraud: fraud, temp_charge: !!f.temp_charge, file_count: files.length }),
          signal: _ac.signal,
        });
        try { instant = await _r.json(); } catch (_) { /* keep instant null */ }
      } finally { clearTimeout(_to); }
    } catch (_) { /* the emailed submission + the mailbox sweep still catch it */ }

    // cloud342 (audit) - forward whether the instant status flip actually happened so the form can be
    // HONEST (e.g. a "temporary charge" on an already-submitted charge changes nothing; don't claim it did).
    return res.status(200).json({ ok: true, file_count: files.length,
      instant_changed: instant ? !!instant.changed : null, instant_status: instant ? instant.status : null });
  } catch (err) {
    console.error("submit error:", err);
    return res.status(500).json({ error: err.message || "internal error" });
  }
};

function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({
      headers: req.headers,
      limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES + 1 },
    });
    const fields = {};
    const files = [];

    bb.on("field", (name, value) => { fields[name] = value; });
    bb.on("file", (_name, stream, info) => {
      const chunks = [];
      stream.on("data", c => chunks.push(c));
      stream.on("end", () => {
        files.push({
          filename: info.filename || "",
          contentType: info.mimeType || "",
          content: Buffer.concat(chunks),
        });
      });
      stream.on("limit", () => reject(new Error("file too large during stream")));
    });
    bb.on("error", reject);
    bb.on("finish", () => resolve({ fields, files }));

    req.pipe(bb);
  });
}

// cloud274 #8 - read the admin's require_* toggles (authoritative) for server-side
// enforcement. Returns null if it can't be read, so the caller can fail closed.
async function fetchRequirements() {
  try {
    const url = process.env.CC_OPTIONS_URL || "https://iicorp-ip.vercel.app/api/cc-form-options";
    const ctl = new AbortController();
    const tm = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(url, { signal: ctl.signal });
    clearTimeout(tm);
    const j = await r.json();
    if (j && j.ok === true) {
      // t424 - require_category is only honored when the endpoint actually has a category list;
      // an older app build sends neither, so nothing new is ever demanded of an older form.
      const hasCats = Array.isArray(j.category_options) && j.category_options.length > 0;
      return { require_store: !!j.require_store, require_description: !!j.require_description,
        require_category: hasCats && j.require_category !== false };
    }
  } catch (_) {}
  return null;
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => {
      try {
        const text = Buffer.concat(chunks).toString("utf-8") || "{}";
        resolve(JSON.parse(text));
      } catch (e) {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}
