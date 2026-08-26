// upload.js — client-side logic for the receipt upload form.
// Reads txn details from the URL query string, validates and submits
// the multipart form to /api/submit.
//
// v2_120-fix8c: smart first-visit-vs-update mode.
//   • First visit per device: photo upload REQUIRED (preserves the
//     original purpose — actual receipt must arrive at least once).
//   • Second+ visit on the same device (detected via localStorage with
//     the token as the key): photo upload becomes OPTIONAL and a small
//     gold banner says "Receipt already submitted — anything you change
//     here will update your previous submission."
//   • An optional ?u=1 URL param forces update mode regardless of
//     localStorage state, so the backend can flip it via the reminder
//     email URL if needed for the cross-device case.

(async function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const params = new URLSearchParams(window.location.search);
  const token = (params.get("token") || "").trim();
  const cardholder = params.get("cardholder") || "";
  const vendor = params.get("vendor") || "";
  const amount = params.get("amount") || "";
  const date = params.get("date") || "";

  const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

  // Where the store-dropdown options come from (managed in the Invoice App under
  // Settings -> Credit Cards -> Submissions). Overridable so a test page can point
  // it at a stub. THE RULE THIS CODE LIVES BY: this form must never go down - so
  // every failure path here leaves the plain text input exactly as it was.
  const OPTIONS_URL = window.CC_OPTIONS_URL
    || "https://iicorp-ip.vercel.app/api/cc-form-options";
  const STATUS_URL = window.CC_STATUS_URL
    || "https://iicorp-ip.vercel.app/api/cc-submission-status";
  const FILE_URL = window.CC_FILE_URL
    || "https://iicorp-ip.vercel.app/api/cc-submission-file";
  const REQUIRED = { store: false, description: false, photo: true };   // cloud274 #20 - photo default on

  function markRequired(fieldId) {
    const label = document.querySelector('label[for="' + fieldId + '"]');
    if (!label) return;
    const opt = label.querySelector(".opt");
    if (opt) opt.textContent = "(required)";
  }

  // cloud273 - the options endpoint is a serverless function; a COLD start (its first
  // hit after idle) can take several seconds, and the old single 4.5s attempt aborted
  // and left the plain box with NO dropdown and NO required marker (his "i cant see the
  // dropdown"). Retry a few times with a longer budget so the dropdown reliably appears;
  // the first failed attempt warms the function, so a retry lands fast. The plain text box
  // stays fully usable the whole time (the never-go-down rule).
  async function _fetchJsonRetry(url, tries, ms) {
    for (let i = 0; i < tries; i++) {
      try {
        const ctl = new AbortController();
        const tm = setTimeout(() => ctl.abort(), ms);
        const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        clearTimeout(tm);
        const j = await res.json();
        if (j) return j;
      } catch (_) { /* cold start / slow / transient: try again */ }
    }
    return null;
  }
  async function upgradeStoreField() {
    const cfg = await _fetchJsonRetry(OPTIONS_URL, 3, 7000);
    if (!cfg || cfg.ok !== true) return;
    if (cfg.require_description) { REQUIRED.description = true; markRequired("description"); }
    if (cfg.require_store) { REQUIRED.store = true; markRequired("store"); }
    if (cfg.require_photo === false) REQUIRED.photo = false;   // cloud274 #20 - honor the admin's toggle
    // cloud252 - if the admin set the Store field to free text, keep the plain box
    // even when options exist
    if (cfg.store_field_type === "free") return;
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    if (!options.length) return;               // nothing configured: stay plain
    const input = $("store");
    if (!input || input.tagName !== "INPUT") return;
    /* cloud271 - a TYPABLE dropdown: keep the text box and attach a datalist so the
       cardholder can PICK a configured store OR TYPE their own if they don't know it.
       Options are stashed so submit can look the store number (code) + kind back up
       by the chosen label. */
    window.__STORE_OPTS = options.slice();
    /* cloud272 - a TYPABLE dropdown that shows the store NUMBER in solid text with the
       company in gray ghost text ("3654 — Gulf Coast Jack"). A native <datalist> can't
       gray part of an option, so this is a small custom combobox. On pick it records the
       store number (code) so the submission carries the number, and it stays typable for
       a store that isn't listed ("the dropdown is just for options"). */
    if (!input.placeholder) input.placeholder = "Type or pick a store…";
    input.setAttribute("autocomplete", "off");
    const wrap = document.createElement("div");
    wrap.className = "cc-combo";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const panel = document.createElement("div");
    panel.className = "cc-combo-panel";
    wrap.appendChild(panel);
    const ghostOf = (o) => o.kind === "company" ? "all locations" : (o.company || "");
    function renderPanel() {
      panel.innerHTML = "";
      const qq = input.value.trim().toLowerCase();
      const list = options.filter((o) => o && o.label && (!qq
        || String(o.label).toLowerCase().indexOf(qq) >= 0
        || String(o.company || "").toLowerCase().indexOf(qq) >= 0
        || String(o.code || "").toLowerCase().indexOf(qq) >= 0)).slice(0, 80);
      if (!list.length) { panel.style.display = "none"; return; }
      list.forEach((o) => {
        const row = document.createElement("div");
        row.className = "cc-combo-opt";
        const main = document.createElement("span");
        main.className = "cc-combo-main"; main.textContent = o.label;
        row.appendChild(main);
        const g = ghostOf(o);
        if (g) { const gs = document.createElement("span");
          gs.className = "cc-combo-ghost"; gs.textContent = " — " + g; row.appendChild(gs); }
        row.addEventListener("mousedown", (e) => { e.preventDefault();
          input.value = o.label; input.dataset.code = o.code || ""; input.dataset.kind = o.kind || "";
          panel.style.display = "none"; });
        panel.appendChild(row);
      });
      panel.style.display = "block";
    }
    input.addEventListener("focus", renderPanel);
    input.addEventListener("input", () => { input.dataset.code = ""; input.dataset.kind = ""; renderPanel(); });
    input.addEventListener("blur", () => setTimeout(() => { panel.style.display = "none"; }, 150));
    if (cfg.store_hint) {
      const hint = document.createElement("div");
      hint.className = "opt";
      hint.style.marginTop = "4px";
      hint.textContent = cfg.store_hint;
      input.insertAdjacentElement("afterend", hint);
    }
  }
  // Sequenced on purpose: the dropdown must exist (or have declined to) BEFORE
  // the remembered store is prefolded, or the prefill silently no-ops against a
  // SELECT that has no matching option.
  upgradeStoreField().then(showPreviousSubmissions);

  // THE LINK REMEMBERS. Each link shows what has already been submitted for its
  // charge - so "did my first one go through?" is answered on the page instead of
  // guessed at, on any device. Same never-break rule: any failure shows nothing.
  async function showPreviousSubmissions() {
    // cloud273 - same cold-start resilience as the options fetch, so the "already
    // submitted" note survives a slow first hit instead of silently never showing.
    const st = await _fetchJsonRetry(STATUS_URL + "?token=" + encodeURIComponent(token), 2, 7000);
    if (!st || st.ok !== true || !Array.isArray(st.files) || !st.files.length) return;

    /* cloud274 - the "already submitted" state was easy to miss (a faint gold note buried
       in the form). Now it reads as a clear STATUS line item in the charge summary AND a
       prominent green banner at the top of the form, with the file(s) as clean rows. */
    const n = st.files.length;
    const statusRow = document.getElementById("m-status-row");
    const statusVal = document.getElementById("m-status");
    if (statusRow && statusVal) {
      statusVal.textContent = "\u2713 Submitted" + (n > 1 ? " (" + n + " files)" : "");
      statusRow.hidden = false;
    }

    const box = document.createElement("div");
    box.className = "submitted-banner";
    const head = document.createElement("div");
    head.className = "submitted-head";
    head.innerHTML = '<span class="submitted-check">\u2713</span><span>Already submitted for this charge</span>';
    box.appendChild(head);

    const fileWrap = document.createElement("div");
    fileWrap.className = "submitted-files";
    st.files.forEach((f, i) => {
      // each one opens the actual file, served back by the link's own token
      const a = document.createElement("a");
      a.className = "submitted-file";
      a.href = FILE_URL + "?token=" + encodeURIComponent(token) + "&n=" + i;
      a.target = "_blank"; a.rel = "noopener";
      const nm = document.createElement("span");
      nm.className = "submitted-file-name";
      nm.textContent = f.name || "receipt";
      const meta = document.createElement("span");
      meta.className = "submitted-file-meta";
      meta.textContent = (f.at ? f.at + " \u00b7 " : "") + "Open \u2197";
      a.appendChild(nm); a.appendChild(meta);
      // cloud274 - the file is fetched live from the mailbox, so the FIRST open can take a
      // few seconds; give immediate feedback so a click never looks like it did nothing.
      a.addEventListener("click", () => {
        meta.textContent = "Opening\u2026 (first open can take a few seconds)";
        setTimeout(() => { meta.textContent = (f.at ? f.at + " \u00b7 " : "") + "Open \u2197"; }, 18000);
      });
      fileWrap.appendChild(a);
    });
    box.appendChild(fileWrap);

    const tail = document.createElement("div");
    tail.className = "submitted-tail";
    tail.textContent = "Anything you send now is added to these \u2014 nothing gets replaced.";
    box.appendChild(tail);

    const bodyEl = document.getElementById("body") || document.body;
    bodyEl.insertBefore(box, bodyEl.firstChild);
    // a receipt exists, so a new photo is optional - same as the localStorage
    // update mode, but now it works from ANY device
    isUpdateMode = true;
    if (st.store) {
      const sEl = $("store");
      if (sEl && !sEl.value) {
        if (sEl.tagName === "SELECT"
            && !Array.prototype.some.call(sEl.options, (op) => op.value === st.store)) {
          const op = document.createElement("option");
          op.value = st.store; op.textContent = st.store + " (as submitted before)";
          sEl.appendChild(op);
        }
        sEl.value = st.store;
      }
    }
    if (st.description) {
      const dEl = $("description");
      if (dEl && !dEl.value) dEl.value = st.description;
    }
  }


  if (!TOKEN_RE.test(token)) {
    showError("Link expired or not found",
      "This receipt link is missing required information. Please use the link from your reminder email.");
    return;
  }

  // ─── Update-mode detection ─────────────────────────────────────────
  // localStorage flags are per-device.
  //  cc_submitted_<token>   → previous successful receipt submission
  //  cc_fraud_<token>       → previous fraud report; form locks down
  //  ?u=1                   → backend-controlled update-mode override
  const SUBMITTED_KEY = `cc_submitted_${token}`;
  const FRAUD_KEY     = `cc_fraud_${token}`;
  let isUpdateMode  = false;
  let isFraudLocked = false;
  try {
    if (localStorage.getItem(FRAUD_KEY)) isFraudLocked = true;
    if (params.get("u") === "1") isUpdateMode = true;
    else if (localStorage.getItem(SUBMITTED_KEY)) isUpdateMode = true;
  } catch (_) { /* localStorage blocked — stay in first-time mode */ }

  // Fraud lock short-circuits everything: show a locked-out screen and
  // never render the form. The cardholder has to contact accounting to
  // get the link unlocked (admin clicks Unmark Fraud in the dashboard).
  /* cloud331 - HIS BUG: "i unmarked it to review and opened the link and the link was still
     saying marked as fraud." The lock is per-device localStorage and NEVER checked the server,
     so an admin un-flagging the charge in the app couldn't unlock the link on the device that
     reported it. Now: if we hold a local fraud lock, ask the server for the CURRENT status - if
     it's no longer fraud, drop the stale lock and show the form; if it's still fraud (or the
     server can't be reached), stay locked. */
  if (isFraudLocked) {
    let serverSaysCleared = false;
    try {
      const st = await _fetchJsonRetry(STATUS_URL + "?token=" + encodeURIComponent(token), 2, 7000);
      if (st && st.ok && st.is_fraud === false) serverSaysCleared = true;
    } catch (_) { /* can't reach the server -> keep the lock (fail safe) */ }
    if (serverSaysCleared) {
      try { localStorage.removeItem(FRAUD_KEY); } catch (_) {}
      isFraudLocked = false;   // admin cleared it -> fall through to the normal form
    } else {
      showError("Reported as fraud",
        "This charge was reported as fraudulent. If that was a mistake, "
        + "contact your accounting admin to unlock the link.");
      return;
    }
  }

  $("m-cardholder").textContent = cardholder || "—";
  $("m-vendor").textContent     = vendor || "—";
  $("m-amount").textContent     = amount ? formatAmount(amount) : "—";
  $("m-date").textContent       = date || "—";

  const filesInput = $("files");
  const fileList   = $("file-list");

  // ─── Update-mode UI tweaks ────────────────────────────────────────
  if (isUpdateMode) {
    // Inject banner-only styles so users only have to redeploy upload.js
    // (no upload.css change required).
    const style = document.createElement("style");
    style.textContent = `
      .update-banner{
        background:#fff8e8;border:1px solid #d4a445;border-radius:8px;
        padding:10px 12px;margin-bottom:14px;
      }
      .update-banner-title{
        font-size:12px;color:#7a5500;font-weight:600;
      }
      .update-banner-sub{
        font-size:11px;color:#7a5500;margin-top:3px;line-height:1.4;
      }
      @media (prefers-color-scheme: dark){
        .update-banner{
          background:rgba(212,164,69,0.10);
          border-color:rgba(212,164,69,0.55);
        }
        .update-banner-title,.update-banner-sub{ color:#d4a445; }
      }`;
    document.head.appendChild(style);
    // Inject the banner above the first field.
    const banner = document.createElement("div");
    banner.className = "update-banner";
    banner.innerHTML =
      '<div class="update-banner-title">✓ Receipt already submitted</div>' +
      '<div class="update-banner-sub">Anything you change here will update your previous submission. Photo is now optional.</div>';
    const body = $("body");
    if (body && body.firstChild) body.insertBefore(banner, body.firstChild);
    // Soften the file field label.
    const fileLabel = document.querySelector('label[for="files"]');
    if (fileLabel) {
      fileLabel.innerHTML = 'Receipt photo(s) or PDF <span class="opt">(optional — adds to your submission)</span>';
    }
    // Change submit button label to make intent clear.
    const submitBtn = $("submit-btn");
    if (submitBtn) submitBtn.textContent = "Submit update";
  }

  filesInput.addEventListener("change", renderFileList);

  function renderFileList() {
    fileList.innerHTML = "";
    const files = Array.from(filesInput.files || []);
    if (files.length === 0) return;
    files.forEach((f) => {
      const row = document.createElement("div");
      row.className = "file-item";
      const size = (f.size / 1024 / 1024).toFixed(2);
      row.textContent = `${f.name} — ${size} MB`;
      fileList.appendChild(row);
    });
  }

  $("submit-btn").addEventListener("click", () => submitReceipt(false));
  $("fraud-btn").addEventListener("click", () => {
    const note = prompt("Optional: anything we should know? (You can leave this blank.)") || "";
    if (!confirm("Report this charge as not yours? The accounting team will be alerted.")) return;
    submitFraud(note);
  });
  // cloud246 - a hotel/rental authorization hold that will never have a receipt.
  // The cardholder says so here (they know); the tracker stops asking and never
  // escalates it. No file needed - this is the whole point.
  const tempBtn = $("temp-btn");
  if (tempBtn) tempBtn.addEventListener("click", () => {
    if (!confirm("Mark this as a temporary authorization hold (like a hotel or rental deposit) that won't have a receipt?")) return;
    submitTemp();
  });

  async function submitReceipt(_unused) {
    const files = Array.from(filesInput.files || []);
    // First-time submission: at least one file is required. Update
    // mode skips the check — store/description edits without a new
    // photo are valid and useful (correcting the wrong store, etc.).
    if (REQUIRED.photo && !isUpdateMode && files.length === 0) {   // cloud274 #20 - honor require_photo
      setStatus("Please attach at least one receipt photo or PDF.", "error");
      return;
    }
    const store       = $("store").value.trim();
    const description = $("description").value.trim();
    if (REQUIRED.store && !store) {
      setStatus("Please choose which store (or company) this charge is for.", "error");
      return;
    }
    if (REQUIRED.description && !description) {
      setStatus("Please add a short description - accounting needs it to book the charge.", "error");
      return;
    }
    // what the chosen option is LINKED TO: a specific store, or a whole company
    // (split across its open locations). Rides in the email for the QB export work.
    let storeCode = "", storeKind = "";
    /* cloud272 - the store number comes from the option the cardholder picked (stashed
       on the input as data-code/data-kind by the combobox). If they typed a value that
       still matches a configured label, use that option's code; a freely-typed store
       that matches nothing has no code (the admin can set it later). */
    const sEl = $("store");
    if (sEl && sEl.dataset && sEl.dataset.code) { storeCode = sEl.dataset.code; storeKind = sEl.dataset.kind || ""; }
    if (!storeCode) {
      const _opts = window.__STORE_OPTS || [];
      const _match = _opts.find((o) => o && o.label === store);
      if (_match) { storeCode = _match.code || ""; storeKind = _match.kind || ""; }
    }

    const fd = new FormData();
    fd.append("token", token);
    fd.append("cardholder", cardholder);
    fd.append("vendor", vendor);
    fd.append("amount", amount);
    fd.append("date", date);
    fd.append("store", store);
    fd.append("store_code", storeCode);
    fd.append("store_kind", storeKind);
    fd.append("description", description);
    files.forEach((f) => fd.append("files", f, f.name));

    setStatus(isUpdateMode ? "Sending update…" : "Submitting…", "info");
    disableForm(true);

    try {
      const res = await fetch("/api/submit", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`Submission failed: ${data.error || res.statusText}`, "error");
        disableForm(false);
        return;
      }
      // Mark this token as submitted on this device so the next visit
      // shows the update banner. Wrapped in try since some browsers
      // block localStorage in incognito.
      try { localStorage.setItem(SUBMITTED_KEY, new Date().toISOString()); } catch (_) {}
      if (isUpdateMode) {
        showDone("Update received", "Thanks. Your changes have been recorded.");
      } else {
        showDone();
      }
    } catch (err) {
      setStatus(`Network error: ${err.message || err}`, "error");
      disableForm(false);
    }
  }

  async function submitTemp() {
    setStatus("Marking…", "info");
    disableForm(true);
    try {
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, cardholder, vendor, amount, date, temp_charge: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`Couldn't mark it: ${data.error || res.statusText}`, "error");
        disableForm(false);
        return;
      }
      try { localStorage.setItem(SUBMITTED_KEY, new Date().toISOString()); } catch (_) {}
      showDone("Marked as a temporary hold", "Thanks. No receipt is needed for this charge.");
    } catch (err) {
      setStatus(`Network error: ${err.message || err}`, "error");
      disableForm(false);
    }
  }

  async function submitFraud(note) {
    setStatus("Reporting…", "info");
    disableForm(true);
    try {
      const body = {
        token, cardholder, vendor, amount, date,
        fraud: true, note: note || ""
      };
      const res = await fetch("/api/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`Report failed: ${data.error || res.statusText}`, "error");
        disableForm(false);
        return;
      }
      // v2_120-fix10: set the fraud-lock flag so subsequent visits to
      // the same link on this device hit the locked-out screen
      // immediately. Per-device only; admin's Unmark Fraud doesn't
      // unset this flag (different machine anyway).
      try { localStorage.setItem(FRAUD_KEY, new Date().toISOString()); } catch (_) {}
      showDone("Report received", "Thanks. The accounting team has been notified.");
    } catch (err) {
      setStatus(`Network error: ${err.message || err}`, "error");
      disableForm(false);
    }
  }

  function setStatus(msg, kind) {
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + (kind || "");
    el.hidden = false;
  }

  function disableForm(disabled) {
    $("submit-btn").disabled = disabled;
    $("fraud-btn").disabled = disabled;
    if ($("temp-btn")) $("temp-btn").disabled = disabled;
    filesInput.disabled = disabled;
    $("store").disabled = disabled;
    $("description").disabled = disabled;
  }

  function showDone(title, sub) {
    $("body").hidden = true;
    $("meta").hidden = true;
    // v2_120-fix8c: original code used `$(".done-title")` which calls
    // getElementById on ".done-title" and finds nothing. Switched to
    // querySelector so the title/sub override actually works.
    if (title) {
      const t = document.querySelector(".done-title");
      if (t) t.textContent = title;
    }
    if (sub) {
      const s = document.querySelector(".done-sub");
      if (s) s.textContent = sub;
    }
    $("done").hidden = false;
  }

  function showError(title, sub) {
    $("body").hidden = true;
    $("meta").hidden = true;
    $("err-title").textContent = title;
    $("err-sub").textContent = sub;
    $("error-page").hidden = false;
  }

  function formatAmount(s) {
    const n = parseFloat(String(s).replace(/[^0-9.\-]/g, ""));
    if (isNaN(n)) return s;
    return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }
})();

// t273 redeploy trigger (t272 push did not deploy)
