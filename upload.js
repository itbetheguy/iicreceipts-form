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

  if (!TOKEN_RE.test(token)) {
    showError("Link expired or not found",
      "This receipt link is missing required information. Please use the link from your reminder email.");
    return;
  }

  // ─── Update-mode detection ─────────────────────────────────────────
  // localStorage flag is per-device. Falls back to ?u=1 if the backend
  // ever embeds an update flag in reminder URLs (cross-device support).
  const SUBMITTED_KEY = `cc_submitted_${token}`;
  let isUpdateMode = false;
  try {
    if (params.get("u") === "1") isUpdateMode = true;
    else if (localStorage.getItem(SUBMITTED_KEY)) isUpdateMode = true;
  } catch (_) { /* localStorage blocked — stay in first-time mode */ }

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

    const fd = new FormData();
    fd.append("token", token);
    fd.append("cardholder", cardholder);
    fd.append("vendor", vendor);
    fd.append("amount", amount);
    fd.append("date", date);
    fd.append("store", store);
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
