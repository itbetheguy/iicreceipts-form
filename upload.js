// upload.js — client-side logic for the receipt upload form.
// Reads txn details from the URL query string, validates and submits
// the multipart form to /api/submit.

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

  $("m-cardholder").textContent = cardholder || "—";
  $("m-vendor").textContent     = vendor || "—";
  $("m-amount").textContent     = amount ? formatAmount(amount) : "—";
  $("m-date").textContent       = date || "—";

  const filesInput = $("files");
  const fileList   = $("file-list");

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
    if (files.length === 0) {
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

    setStatus("Submitting…", "info");
    disableForm(true);

    try {
      const res = await fetch("/api/submit", { method: "POST", body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus(`Submission failed: ${data.error || res.statusText}`, "error");
        disableForm(false);
        return;
      }
      showDone();
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
    if (title) $(".done-title")?.replaceChildren(document.createTextNode(title));
    if (sub)   $(".done-sub")?.replaceChildren(document.createTextNode(sub));
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
