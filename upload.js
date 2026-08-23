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

(function () {
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
  const REQUIRED = { store: false, description: false };

  function markRequired(fieldId) {
    const label = document.querySelector('label[for="' + fieldId + '"]');
    if (!label) return;
    const opt = label.querySelector(".opt");
    if (opt) opt.textContent = "(required)";
  }

  async function upgradeStoreField() {
    let cfg = null;
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 4500);
      const res = await fetch(OPTIONS_URL, { signal: ctl.signal });
      clearTimeout(tm);
      cfg = await res.json();
    } catch (_) { return; }                    // unreachable/slow: stay plain
    if (!cfg || cfg.ok !== true) return;
    if (cfg.require_description) { REQUIRED.description = true; markRequired("description"); }
    if (cfg.require_store) { REQUIRED.store = true; markRequired("store"); }
    const options = Array.isArray(cfg.options) ? cfg.options : [];
    if (!options.length) return;               // nothing configured: stay plain
    const input = $("store");
    if (!input || input.tagName === "SELECT") return;
    const sel = document.createElement("select");
    sel.id = "store"; sel.name = "store";
    sel.className = input.className || "";
    const first = document.createElement("option");
    first.value = ""; first.textContent = "Choose…";
    sel.appendChild(first);
    options.forEach((o) => {
      if (!o || !o.label) return;
      const op = document.createElement("option");
      op.value = o.label;                      // the human-readable store field
      op.dataset.code = o.code || "";
      op.dataset.kind = o.kind || "store";
      op.textContent = o.label;
      sel.appendChild(op);
    });
    // an update visit may carry a previously typed free-text store - keep it pickable
    const prev = (input.value || "").trim();
    if (prev && !Array.prototype.some.call(sel.options, (op) => op.value === prev)) {
      const op = document.createElement("option");
      op.value = prev; op.textContent = prev + " (as typed before)";
      sel.appendChild(op);
      sel.value = prev;
    }
    input.replaceWith(sel);
    if (cfg.store_hint) {
      const hint = document.createElement("div");
      hint.className = "opt";
      hint.style.marginTop = "4px";
      hint.textContent = cfg.store_hint;
      sel.insertAdjacentElement("afterend", hint);
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
    let st = null;
    try {
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), 4500);
      const res = await fetch(STATUS_URL + "?token=" + encodeURIComponent(token), { signal: ctl.signal });
      clearTimeout(tm);
      st = await res.json();
    } catch (_) { return; }
    if (!st || st.ok !== true || !Array.isArray(st.files) || !st.files.length) return;
    const box = document.createElement("div");
    box.className = "note";
    box.style.cssText = "margin:10px 0;padding:10px 12px;border:1px solid #6b5b1e;border-radius:8px;background:rgba(201,162,39,.08);font-size:13px";
    const head = document.createElement("div");
    head.style.fontWeight = "600";
    head.textContent = "Already submitted for this charge:";
    box.appendChild(head);
    st.files.forEach((f) => {
      const line = document.createElement("div");
      line.textContent = "\u2713 " + (f.name || "receipt") + (f.at ? " \u2014 " + f.at : "");
      box.appendChild(line);
    });
    const tail = document.createElement("div");
    tail.style.opacity = "0.8";
    tail.textContent = "Anything you send now is added to these - nothing gets replaced.";
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
  if (isFraudLocked) {
    showError("Reported as fraud",
      "This charge was reported as fraudulent. If that was a mistake, "
      + "contact your accounting admin to unlock the link.");
    return;
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

  async function submitReceipt(_unused) {
    const files = Array.from(filesInput.files || []);
    // First-time submission: at least one file is required. Update
    // mode skips the check — store/description edits without a new
    // photo are valid and useful (correcting the wrong store, etc.).
    if (!isUpdateMode && files.length === 0) {
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
    const sEl = $("store");
    if (sEl && sEl.tagName === "SELECT" && sEl.selectedIndex > -1) {
      const op = sEl.options[sEl.selectedIndex];
      if (op && op.dataset) { storeCode = op.dataset.code || ""; storeKind = op.dataset.kind || ""; }
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
