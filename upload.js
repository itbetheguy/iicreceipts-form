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
  // t424 - category joins the map; it only turns required when the endpoint hands over a list
  const REQUIRED = { store: false, category: false, description: false, photo: true };   // cloud274 #20 - photo default on

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
      const ctl = new AbortController();
      const tm = setTimeout(() => ctl.abort(), ms);
      try {
        const res = await fetch(url, { signal: ctl.signal, cache: "no-store" });
        // cloud341 - the abort budget now also covers the BODY read (res.json). Previously the
        // timer was cleared the instant headers arrived, so a response that sent 200 + headers
        // then STALLED its body would hang res.json() forever - and the fraud gate awaits this,
        // so its "buttons disabled until we know" would never lift. Now a stalled body aborts at ms.
        const j = await res.json();
        if (j) return j;
      } catch (_) { /* cold start / slow / transient / stalled body: try again */ }
      finally { clearTimeout(tm); }
    }
    return null;
  }
  /* t424 - ONE config pass. The options endpoint answers for the store list, the category list,
     the require flags and the hints together, so every field reads the same answer. Each field's
     upgrade is its own function: the store's early returns ("free" mode, no stores configured)
     used to be the whole pass, and they must never skip the category. The never-go-down rule
     holds throughout: no answer = every box stays a plain text box, nothing required beyond the
     photo default, and the category box says the list is unavailable. */
  async function loadFormConfig() {
    const cfg = await _fetchJsonRetry(OPTIONS_URL, 3, 7000);
    if (!cfg || cfg.ok !== true) { upgradeCategoryField(null, true); return; }
    if (cfg.require_description) { REQUIRED.description = true; markRequired("description"); }
    if (cfg.require_store) { REQUIRED.store = true; markRequired("store"); }
    if (cfg.require_photo === false) REQUIRED.photo = false;   // cloud274 #20 - honor the admin's toggle
    /* t424 - "then description can be optional": it is, unless the admin ticks it (the flag above);
       the label already reads "(optional)". Its small print rides in like the store's. */
    if (cfg.description_hint) hintUnder($("description"), String(cfg.description_hint));
    upgradeCategoryField(cfg);
    upgradeStoreField(cfg);
  }
  // small print under a field, the way store_hint has always been shown
  function hintUnder(el, text) {
    if (!el || !text) return;
    const hint = document.createElement("div");
    hint.className = "opt";
    hint.style.marginTop = "4px";
    hint.textContent = text;
    el.insertAdjacentElement("afterend", hint);
  }
  function upgradeStoreField(cfg) {
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
    /* cloud402 - HIS ASK: "he wants the form to have the store field locked to only my answer
       choices. the other thing i want is to be able to choose multiple stores. so if i am
       typing JIB 640, 640 should pop up in the drop down of the form and i click it and i can
       continue to type JIB 765 and i can choose 765."
       So the box is a SEARCH box and every pick becomes a chip. LOCKED mode (the admin's
       choice) refuses anything that isn't a pick; the existing "dropdown" mode still lets a
       cardholder type a store that isn't listed, exactly as it does today. */
    const LOCKED = cfg.store_field_type === "locked";
    window.__STORE_LOCKED = LOCKED;
    const chosen = [];
    window.__STORE_CHOSEN = chosen;
    input.placeholder = LOCKED ? "Search your stores…" : "Type or pick a store…";
    input.setAttribute("autocomplete", "off");
    const wrap = document.createElement("div");
    wrap.className = "cc-combo";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const panel = document.createElement("div");
    panel.className = "cc-combo-panel";
    wrap.appendChild(panel);
    // the chips sit above the box, so a second and third pick read as a list
    const chipBox = document.createElement("div");
    chipBox.className = "cc-chips";
    wrap.parentNode.insertBefore(chipBox, wrap);
    const keyOf = (o) => String((o && (o.code || o.label)) || "").toLowerCase();
    function drawChips() {
      chipBox.innerHTML = "";
      chosen.forEach((c, i) => {
        const chip = document.createElement("span");
        chip.className = "cc-chip";
        const t = document.createElement("span");
        t.textContent = c.label + (c.kind === "company" ? " (all locations)" : "");
        chip.appendChild(t);
        const x = document.createElement("button");
        x.type = "button"; x.className = "cc-chip-x"; x.setAttribute("aria-label", "Remove " + c.label);
        x.textContent = "×";
        x.addEventListener("click", () => { chosen.splice(i, 1); drawChips(); });
        chip.appendChild(x);
        chipBox.appendChild(chip);
      });
      if (chosen.length > 1) {
        const note = document.createElement("div");
        note.className = "opt";
        note.style.marginTop = "2px";
        note.textContent = "This charge will be split evenly across these " + chosen.length + " stores.";
        chipBox.appendChild(note);
      }
    }
    function addChoice(o) {
      if (!o || !o.label) return;
      if (chosen.some((c) => keyOf(c) === keyOf(o))) return;   // never the same store twice
      if (chosen.length >= 12) return;
      chosen.push({ label: o.label, code: o.code || "", kind: o.kind || "" });
      input.value = ""; input.dataset.code = ""; input.dataset.kind = "";
      drawChips();
    }
    window.__STORE_ADD = addChoice;   // used by the "already submitted" prefill
    const ghostOf = (o) => o.kind === "company" ? "all locations" : (o.company || "");
    function renderPanel() {
      panel.innerHTML = "";
      const qq = input.value.trim().toLowerCase();
      const list = options.filter((o) => o && o.label
        && !chosen.some((c) => keyOf(c) === keyOf(o))          // already picked: out of the list
        && (!qq
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
          addChoice(o);
          /* t424 - the list closes after a pick: it used to stay open and, with the Category box right under
             it, the next tap (meant for Category) added a second store and split the charge. Type again or tap
             the box to pick another ("i can continue to type JIB 765 and i can choose 765"). */
          panel.style.display = "none";
        });
        panel.appendChild(row);
      });
      panel.style.display = "block";
    }
    input.addEventListener("focus", renderPanel);
    input.addEventListener("input", () => { input.dataset.code = ""; input.dataset.kind = ""; renderPanel(); });
    // backspace on an empty box takes the last chip back off
    input.addEventListener("keydown", (e) => {
      if (e.key === "Backspace" && !input.value && chosen.length) { chosen.pop(); drawChips(); renderPanel(); }
    });
    input.addEventListener("blur", () => setTimeout(() => { panel.style.display = "none"; }, 150));
    if (cfg.store_hint) {
      const hint = document.createElement("div");
      hint.className = "opt";
      hint.style.marginTop = "4px";
      hint.textContent = cfg.store_hint;
      input.insertAdjacentElement("afterend", hint);
    }
  }
  /* t424 - THE RANKING. This is the app's api/_cc-category.js, copied VERBATIM: the app and the
     form must rank a query identically, so nothing here is ever "improved" on its own. Scores,
     best first: whole label (100) > label starts with it (90) > a word starts with it (80) >
     appears anywhere (70) > every typed word appears (60) > the letters appear in order (50) >
     one typo off a word (40) > two typos (30). Ties: shorter label, then the admin's order. */
  function normCat(s){return String(s==null?"":s).toLowerCase().replace(/&/g," and ").replace(/[^a-z0-9 ]+/g," ").replace(/\s+/g," ").trim();}
  function isSubsequence(q,s){let i=0;for(let j=0;j<s.length&&i<q.length;j++)if(s[j]===q[i])i++;return i===q.length;}
  function levDist(a,b,cap){const la=a.length,lb=b.length,max=(cap==null?2:cap)+1;if(Math.abs(la-lb)>cap)return max;let prev=new Array(lb+1),cur=new Array(lb+1);for(let j=0;j<=lb;j++)prev[j]=j;for(let i=1;i<=la;i++){cur[0]=i;let rowMin=cur[0];for(let j=1;j<=lb;j++){cur[j]=Math.min(prev[j]+1,cur[j-1]+1,prev[j-1]+(a[i-1]===b[j-1]?0:1));if(cur[j]<rowMin)rowMin=cur[j];}if(rowMin>cap)return max;const t=prev;prev=cur;cur=t;}return Math.min(prev[lb],max);}
  function wordDist(q,w,cap){const whole=levDist(q,w,cap);const head=w.length>q.length?levDist(q,w.slice(0,q.length),cap):whole;return Math.min(whole,head);}
  function scoreOne(qn,label){const ln=normCat(label);if(!qn||!ln)return 0;if(ln===qn)return 100;if(ln.indexOf(qn)===0)return 90;const words=ln.split(" ");if(words.some(w=>w.indexOf(qn)===0))return 80;if(ln.indexOf(qn)>=0)return 70;const qws=qn.split(" ").filter(Boolean);if(qws.length>1&&qws.every(w=>ln.indexOf(w)>=0))return 60;const q1=qn.replace(/ /g,"");if(q1.length>=5&&words.some(w=>w[0]===q1[0])&&isSubsequence(q1,ln.replace(/ /g,"")))return 50;if(q1.length>=4&&words.some(w=>w.length>=4&&wordDist(q1,w,1)<=1))return 40;if(q1.length>=5&&words.some(w=>w.length>=5&&wordDist(q1,w,2)<=2))return 30;return 0;}
  function rankCategories(query,options){const qn=normCat(query);const list=(Array.isArray(options)?options:[]).filter(o=>o&&String(o.label||"").trim());if(!qn)return list.map((o,i)=>({option:o,score:0,i}));return list.map((o,i)=>({option:o,score:scoreOne(qn,o.label),i})).filter(x=>x.score>0).sort((a,b)=>(b.score-a.score)||(String(a.option.label).length-String(b.option.label).length)||(a.i-b.i));}
  function findCategory(label,options){const n=normCat(label);if(!n)return null;return(Array.isArray(options)?options:[]).find(o=>o&&normCat(o.label)===n)||null;}
  window.__CAT_RANK = rankCategories;   // a test page can drive the ranking directly
  window.__CAT_OPTS = [];               // the list the endpoint handed over (empty = plain box)

  /* t424 - HIS ASK: "I need the form to have a field called category. i will give you a list of
     items that will translate over to gl codes. this should be a mandatory field. then description
     can be optional." … "the category field should be a little smarter. i will need to type
     something and see stuff that relates as close as it is. ranked from closest relating to least.
     its gotta be smart since therell be more than ten i assume. Needs to be locked and not free
     characters." … "again, all fields with a drop down should be auto fillable."
     So: a LOCKED search box. Typing ranks the admin's list closest-first (the ranking above); the
     highlighted row (first by default, arrows move it) picks on Enter, or click any row; a pick
     fills the box with the label and stamps it as picked; typing again un-picks. Empty and focused
     shows the whole list, so it is a plain dropdown too. Nothing but a label from the list is ever
     submitted. The GL codes never leave the app - the form only sees labels.
     THE NEVER-GO-DOWN RULE: no list (endpoint down, or nothing configured yet) = a plain OPTIONAL
     text box that says so. The form never blocks a receipt because the app is away. */
  function upgradeCategoryField(cfg, unreachable) {
    const input = $("category");
    if (!input || input.tagName !== "INPUT") return;
    const options = (cfg && Array.isArray(cfg.category_options) ? cfg.category_options : [])
      .filter((o) => o && String(o.label || "").trim())
      .map((o) => ({ label: String(o.label).trim() }));
    window.__CAT_OPTS = options;
    if (!options.length) {
      /* plain box, optional - the never-go-down rule. Two different truths: the list could not be reached
         (say so, and ask for it typed - the app may still require one when it checks the submission), or
         the admin simply has no categories yet (nothing to say; an optional box). */
      if (unreachable) hintUnder(input, "The category list couldn\u2019t be loaded right now \u2014 type the category in.");
      return;
    }
    // the endpoint's default is "required whenever there is a list"; only an explicit false relaxes it
    if (cfg.require_category !== false) { REQUIRED.category = true; markRequired("category"); }
    input.placeholder = "Type to search categories…";
    input.setAttribute("autocomplete", "off");
    const wrap = document.createElement("div");
    wrap.className = "cc-combo";
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    const panel = document.createElement("div");
    panel.className = "cc-combo-panel";
    wrap.appendChild(panel);
    if (cfg.category_hint) hintUnder(wrap, String(cfg.category_hint));
    let rows = [];     // the ranked options on screen, top to bottom
    let hl = 0;        // the highlighted row (keyboard), first by default
    function closePanel() { panel.style.display = "none"; rows = []; }
    function pick(o) {
      if (!o) return;
      input.value = o.label;
      input.dataset.picked = o.label;
      closePanel();
    }
    // the "already submitted" prefill goes through the same pick, so it stays locked to the list
    window.__CAT_PICK = function (label) { const o = findCategory(label, options); if (o) pick(o); return !!o; };
    function paintHl() {
      Array.from(panel.children).forEach((r, i) => r.classList.toggle("cc-combo-hl", i === hl));
    }
    function renderPanel() {
      panel.innerHTML = "";
      rows = rankCategories(input.value, options).map((x) => x.option);   // t470 - EVERY category, closest first (the panel scrolls): a 12-row cap hid 35 of his 47
      if (!rows.length) { closePanel(); return; }
      hl = 0;
      rows.forEach((o, i) => {
        const row = document.createElement("div");
        row.className = "cc-combo-opt";
        const main = document.createElement("span");
        main.className = "cc-combo-main"; main.textContent = o.label;
        row.appendChild(main);
        row.addEventListener("mouseenter", () => { hl = i; paintHl(); });
        row.addEventListener("mousedown", (e) => { e.preventDefault(); pick(o); });
        panel.appendChild(row);
      });
      paintHl();
      panel.style.display = "block";
    }
    input.addEventListener("focus", renderPanel);
    input.addEventListener("input", () => { delete input.dataset.picked; renderPanel(); });
    input.addEventListener("keydown", (e) => {
      const open = panel.style.display === "block" && rows.length > 0;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!open) { renderPanel(); return; }
        hl = (hl + (e.key === "ArrowDown" ? 1 : rows.length - 1)) % rows.length;
        paintHl();
        const r = panel.children[hl];
        if (r && r.scrollIntoView) r.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (open) pick(rows[hl]);
        else { const o = findCategory(input.value, options); if (o) pick(o); }
      } else if (e.key === "Escape") {
        closePanel();
      }
    });
    input.addEventListener("blur", () => {
      // typed the whole label by hand (case / punctuation don't matter)? that counts as a pick
      if (!input.dataset.picked) { const o = findCategory(input.value, options); if (o) pick(o); }
      setTimeout(closePanel, 150);
    });
  }

  // Sequenced on purpose: the dropdowns must exist (or have declined to) BEFORE
  // the remembered store / category are prefilled, or the prefill silently no-ops
  // against a list that isn't there yet.
  loadFormConfig().then(showPreviousSubmissions);

  // THE LINK REMEMBERS. Each link shows what has already been submitted for its
  // charge - so "did my first one go through?" is answered on the page instead of
  // guessed at, on any device. Same never-break rule: any failure shows nothing.
  async function showPreviousSubmissions() {
    // cloud273 - same cold-start resilience as the options fetch, so the "already
    // submitted" note survives a slow first hit instead of silently never showing.
    const st = await _fetchJsonRetry(STATUS_URL + "?token=" + encodeURIComponent(token), 2, 7000);
    // cloud341 - a fraud charge is owned by the fraud gate (it locks the whole form); never paint
    // the green "already submitted - add more" banner or switch to update-mode on one, even if it
    // has receipts on file (is_fraud and files are independent in the response).
    if (st && st.is_fraud === true) return;
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
      /* cloud402 - rebuild the CHIPS from what was submitted before ("JIB 3640 + JIB 0765"),
         so an update keeps every store instead of collapsing to one typed string. Anything
         that doesn't match a configured option falls back to the plain box, which is the only
         thing that worked before. (The dead SELECT branch went with it — no <select> has
         existed since the combobox landed.) */
      const add = window.__STORE_ADD;
      const opts = window.__STORE_OPTS || [];
      const parts = String(st.store).split(" + ").map((p) => p.trim()).filter(Boolean);
      const matched = parts.map((p) => opts.find((o) => o && o.label === p)).filter(Boolean);
      if (add && matched.length && matched.length === parts.length) {
        matched.forEach(add);
      } else if (sEl && !sEl.value && !window.__STORE_LOCKED) {
        sEl.value = st.store;
      }
    }
    /* t424 - the remembered category comes back as a PICK (the dropdown's own pick function), so
       an update keeps it locked to the list; a label no longer on the list is left alone rather
       than typed in where it would be refused. With no list (plain box) the text is simply set.
       A previous submission that carries no category does nothing. */
    if (st.category) {
      const cEl = $("category");
      if (window.__CAT_PICK) window.__CAT_PICK(String(st.category));
      else if (cEl && !cEl.value) cEl.value = String(st.category);
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

  /* cloud341 - HIS BUG (ss2 vs ss4): a charge already marked fraud - in the app, or reported from
     ANOTHER device - opened the FULL form, because the fraud lock above only fires from THIS
     device's localStorage flag. A charge freshly marked on THIS device gated only because its flag
     had just been set. The SERVER is the authority on fraud, not the device. So when this device
     holds no local lock, ask the server for the charge's CURRENT status and gate if it is fraud,
     from any device. The form is already on screen for speed, so only the ACTION buttons are held
     until we know (store / description / photo stay usable meanwhile); the fast path shows no note,
     a cold endpoint shows a brief "Checking...". Unreachable with no local flag -> allow (fail open,
     same as today) - this check only ever adds a lock, never removes the reporting-device one. */
  if (!isFraudLocked) {
    disableActions(true);
    const _checkNote = setTimeout(() => setStatus("Checking this charge…", ""), 400);
    (async () => {
      let serverFraud = null;   // true / false / null (couldn't reach the server)
      try {
        const st = await _fetchJsonRetry(STATUS_URL + "?token=" + encodeURIComponent(token), 2, 7000);
        if (st && st.ok === true) serverFraud = (st.is_fraud === true);
      } catch (_) { /* unreachable -> unknown, allow the form */ }
      clearTimeout(_checkNote);
      if (serverFraud === true) {
        try { localStorage.setItem(FRAUD_KEY, new Date().toISOString()); } catch (_) {}   // gate instantly on reload
        showError("Reported as fraud",
          "This charge was reported as fraudulent. If that was a mistake, "
          + "contact your accounting admin to unlock the link.");
        return;
      }
      const s = $("status");
      if (s && /Checking this charge/.test(s.textContent || "")) s.hidden = true;
      disableActions(false);   // not fraud, or unreachable with no local lock -> allow submission
    })();
  }

  function disableActions(d) {
    $("submit-btn").disabled = d;
    if ($("temp-btn")) $("temp-btn").disabled = d;
    $("fraud-btn").disabled = d;
  }

  /* t471 - WHAT ONE SEND CAN CARRY. The form runs on Vercel, which refuses a request body over 4.5 MB
     BEFORE the form's own code ever sees it - the cardholder got a bare "Submission failed:" and could walk
     away believing it went (his words after Chris's "I already submitted these": "make sure its robust and
     ACTUALLY lands ... theres no way for it to magically get lost"). A phone photo alone is 3-12 MB. So:
     photos are shrunk here first (a receipt reads fine at 2000 px), the files go in as many parts as they
     need - each part is its own submission on this link and the tracker puts every one on the charge - a
     single file still too big is refused BY NAME before anything is sent, and a failure says exactly what
     did and didn't go. Pressing Submit again sends only what didn't. */
  const SEND_LIMIT = Math.floor(3.9 * 1024 * 1024);   // file bytes per request: the fields + the multipart wrapping stay under 4.5 MB
  const SENT_FILES = new Set();                       // files an earlier part of this submission already delivered
  function fileKey(f) { return [f && f.name, f && f.size, f && f.lastModified].join("|"); }
  // greedy, in the order picked: [[0,1],[2],...]. A file over the limit sits alone (the caller refuses it).
  function packSends(sizes, limit) {
    const out = []; let cur = [], tot = 0;
    sizes.forEach((sz, i) => {
      if (cur.length && tot + sz > limit) { out.push(cur); cur = []; tot = 0; }
      cur.push(i); tot += sz;
    });
    if (cur.length) out.push(cur);
    return out;
  }
  function tooBigMessage(name, bytes, limit) {
    const mb = (b) => (b / 1048576).toFixed(1);
    return "\u201C" + name + "\u201D is " + mb(bytes) + " MB - the form can send about " + mb(limit) + " MB at a time, so nothing was sent. "
      + "Email it instead (below) - or take a photo of the receipt, or save the PDF smaller, and press Submit again.";
  }

  /* t472 - HIS ASK: "I don't like the notification of rejection being on the bottom of the field. Make it an overlay
     tile saying why it failed and they can x it out to dismiss. And also put 'reply to email with the submission'
     with text. Make the close or x or dismissible button copy the text pastable automatically. Also say it copied
     automatically." + "The text pastable can be some sort of legible code the program can pick up on scan."
     So every rejection is a tile over the form (why it failed, an \u2715). When the FILE can't go through the form (too
     big, or the send failed), the tile also says: reply to the email that sent you this link, attach the file, paste
     this text - and the \u2715 copies that text by itself and says so. The text carries a RECEIPT CODE the tracker's
     mailbox check reads (IIC-XXXX-XXXX-XXXX = the first 12 hex digits of the charge's id - the app's
     api/_cc-parse.js makes the same code from the charge, tests/cc_reply_test.js proves they agree), so the reply
     lands on this charge even when someone changes the subject or starts a new email. */
  function receiptCode(tok) {
    const t = String(tok || "").trim();
    let hex = "";
    if (/^[0-9a-f]{12,}$/i.test(t)) hex = t.toLowerCase();   // the cloud link: the charge id's hex digits
    else {
      try {                                                  // the old desktop app's link: the charge id's 16 bytes, base64url
        let b = t.replace(/-/g, "+").replace(/_/g, "/");
        while (b.length % 4) b += "=";
        const bin = atob(b);
        if (bin.length === 16) for (let i = 0; i < 16; i++) hex += ("0" + bin.charCodeAt(i).toString(16)).slice(-2);
      } catch (_) { hex = ""; }
    }
    if (!/^[0-9a-f]{12}/.test(hex)) return "";
    const h = hex.slice(0, 12).toUpperCase();
    return "IIC-" + h.slice(0, 4) + "-" + h.slice(4, 8) + "-" + h.slice(8, 12);
  }
  // what the \u2715 copies: one line a person can read, the code the tracker reads, and whatever was already filled in
  function emailTextFor(f) {
    const code = receiptCode(token);
    const lines = [["Receipt for " + (vendor || "this charge"), amount ? formatAmount(amount) : "", date || ""].filter(Boolean).join(" \u00B7 ")];
    lines.push(code ? "Receipt code: " + code : "Receipt link: " + window.location.href);
    if (f && f.store) lines.push("Store: " + f.store);
    if (f && f.category) lines.push("Category: " + f.category);
    if (f && f.description) lines.push("Description: " + String(f.description).replace(/\s+/g, " ").trim());
    return lines.join("\n");
  }
  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    } catch (_) { /* blocked - try the older way */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text; ta.setAttribute("readonly", "");
      ta.style.position = "fixed"; ta.style.top = "-1000px"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, text.length);
      const done = document.execCommand("copy");
      ta.remove();
      return !!done;
    } catch (_) { return false; }
  }
  function toast(msg) {
    const old = document.getElementById("toast");
    if (old) old.remove();
    const t = document.createElement("div");
    t.id = "toast"; t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => { t.classList.add("out"); setTimeout(() => t.remove(), 400); }, 4500);
  }
  function closeProblem() {
    const ov = document.getElementById("problem");
    if (!ov) return;
    if (ov._onKey) document.removeEventListener("keydown", ov._onKey);
    ov.remove();
    document.body.classList.remove("ov-open");
  }
  // o: { title, lines: [why it failed], email: the text to paste (only when the file itself couldn't go),
  //      then: the field to put the cursor in once the tile is closed (a field to fix) }
  function showProblem(o) {
    closeProblem();
    const st = $("status");
    if (st) st.hidden = true;   // the rejection is the tile now - never a line at the bottom as well
    const ov = document.createElement("div");
    ov.className = "ov"; ov.id = "problem";
    ov.setAttribute("role", "alertdialog"); ov.setAttribute("aria-modal", "true"); ov.setAttribute("aria-labelledby", "ov-title");
    const card = document.createElement("div");
    card.className = "ov-card";
    const x = document.createElement("button");
    x.type = "button"; x.className = "ov-x"; x.textContent = "\u2715";
    x.setAttribute("aria-label", o.email ? "Close - copies the text" : "Close");
    card.appendChild(x);
    const t = document.createElement("div");
    t.className = "ov-title"; t.id = "ov-title"; t.textContent = o.title || "That didn\u2019t go through";
    card.appendChild(t);
    (o.lines || []).filter(Boolean).forEach((line) => {
      const p = document.createElement("p");
      p.className = "ov-line"; p.textContent = line;
      card.appendChild(p);
    });
    let codeEl = null, hint = null;
    if (o.email) {
      const box = document.createElement("div");
      box.className = "ov-email";
      const h = document.createElement("div");
      h.className = "ov-email-head"; h.textContent = "Send it by email instead";
      box.appendChild(h);
      const ol = document.createElement("ol");
      ol.className = "ov-steps";
      ["Reply to the email that sent you this link",
       "Attach the receipt file",
       "Paste the text below into your reply - its receipt code tells the tracker which charge it\u2019s for"].forEach((s) => {
        const li = document.createElement("li"); li.textContent = s; ol.appendChild(li);
      });
      box.appendChild(ol);
      codeEl = document.createElement("pre");
      codeEl.className = "ov-code"; codeEl.textContent = o.email;
      box.appendChild(codeEl);
      hint = document.createElement("div");
      hint.className = "ov-hint";
      hint.textContent = "Closing this box copies the text for you automatically - then just paste it into your reply.";
      box.appendChild(hint);
      card.appendChild(box);
    }
    const btn = document.createElement("button");
    btn.type = "button"; btn.className = "primary ov-btn";
    btn.textContent = o.email ? "Copy the text & close" : "OK";
    card.appendChild(btn);
    ov.appendChild(card);
    document.body.appendChild(ov);
    document.body.classList.add("ov-open");
    let refused = 0;
    const dismiss = async () => {
      if (!o.email) { closeProblem(); if (o.then && o.then.focus) { try { o.then.focus(); } catch (_) {} } return; }
      const done = await copyText(o.email);
      if (!done && refused++ === 0) {
        // the browser wouldn't let the page copy: keep the tile, select the text, say how - the next close closes
        try { const rg = document.createRange(); rg.selectNodeContents(codeEl); const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(rg); } catch (_) {}
        hint.textContent = "Your browser didn\u2019t let the page copy it - press and hold the text above, choose Copy, then close this.";
        hint.classList.add("warn");
        return;
      }
      closeProblem();
      toast(done ? "\u2713 Copied automatically - paste it into your reply email" : "Not copied - open this again with Submit to copy the text");
    };
    x.addEventListener("click", dismiss);
    btn.addEventListener("click", dismiss);
    ov._onKey = (e) => { if (e.key === "Escape") { e.preventDefault(); dismiss(); } };
    document.addEventListener("keydown", ov._onKey);
    setTimeout(() => { try { btn.focus(); } catch (_) {} }, 30);
    window.__PROBLEM = { title: t.textContent, email: o.email || "" };   // a test page reads what the tile says
  }
  function failMessage(status, data, statusText, somethingWent) {
    const tail = somethingWent ? " Press Submit again - only what didn't go is sent." : " Nothing was sent - press Submit again.";
    const dot = (t) => (/[.!?]$/.test(t) ? t : t + ".");
    if (data && data.error) return "Submission failed: " + dot(String(data.error)) + tail;
    if (status === 413) return "Submission failed: the files were too big to send in one go." + tail;
    return "Submission failed (error " + (status || "?") + (statusText ? " " + statusText : "") + ")." + tail;
  }
  function partSaid(sentParts, total, sentFiles) {
    if (!sentParts) return "";
    return (sentParts === 1 ? "Part 1 of " + total + " WAS sent" : "Parts 1-" + sentParts + " of " + total + " WERE sent")
      + " (" + sentFiles + " file" + (sentFiles === 1 ? "" : "s") + "). The next part didn't go - ";
  }
  // a photo shrunk to what a receipt needs; anything that can't be read here goes as it was taken
  async function shrinkPhoto(file) {
    try {
      if (!file || !/^image\//i.test(file.type || "") || /gif|svg/i.test(file.type || "")) return file;
      if (file.size <= 900 * 1024) return file;   // already small - send it as taken
      let src = null, w = 0, h = 0, url = "";
      try { src = await createImageBitmap(file, { imageOrientation: "from-image" }); w = src.width; h = src.height; }
      catch (_) {
        url = URL.createObjectURL(file);
        src = await new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = url; });
        w = src.naturalWidth; h = src.naturalHeight;
      }
      if (!w || !h) return file;
      const k = Math.min(1, 2000 / Math.max(w, h));
      const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H;
      const ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(src, 0, 0, W, H);
      if (url) setTimeout(() => { try { URL.revokeObjectURL(url); } catch (_) {} }, 1000);
      const blob = await new Promise((res) => cv.toBlob(res, "image/jpeg", 0.85));
      if (!blob || blob.size >= file.size) return file;
      const base = String(file.name || "receipt").replace(/\.[^.]+$/, "") || "receipt";
      return new File([blob], base + ".jpg", { type: "image/jpeg", lastModified: file.lastModified || Date.now() });
    } catch (_) { return file; }   // any trouble: the original goes, and the size check decides
  }

  async function submitReceipt(_unused) {
    const files = Array.from(filesInput.files || []);
    // First-time submission: at least one file is required. Update
    // mode skips the check — store/description edits without a new
    // photo are valid and useful (correcting the wrong store, etc.).
    if (REQUIRED.photo && !isUpdateMode && files.length === 0) {   // cloud274 #20 - honor require_photo
      setStatus("Please attach at least one receipt photo or PDF.", "error");
      return;
    }
    /* cloud402 - one or SEVERAL stores. Chips are the answer; the box is a search box.
       With exactly one pick the payload below is byte-identical to what it has always been,
       so an older parser on the app side keeps working unchanged. */
    const chosenStores = (window.__STORE_CHOSEN || []).slice();
    const lockedStores = !!window.__STORE_LOCKED;
    const typedStore  = $("store") ? $("store").value.trim() : "";
    const store       = chosenStores.length
      ? chosenStores.map((c) => c.label).join(" + ").slice(0, 118)
      : (lockedStores ? "" : typedStore);
    const description = $("description").value.trim();
    if (lockedStores && !chosenStores.length && typedStore) {
      setStatus("Pick your store from the list — a typed name can't be used here.", "error", $("store"));
      return;
    }
    if (REQUIRED.store && !store) {
      setStatus(lockedStores
        ? "Please pick your store from the list."
        : "Please choose which store (or company) this charge is for.", "error", $("store"));
      return;
    }
    /* t424 - the category is LOCKED to the admin's list: only a label from it is ever sent
       ("Needs to be locked and not free characters"). A pick, or a hand-typed label that equals
       one (case / punctuation-blind), counts; anything else is refused and the box gets focus.
       With no list on this device (endpoint down / nothing configured) the box is plain and
       optional and whatever was typed rides along - the never-go-down rule. */
    const catEl = $("category");
    const typedCat = catEl ? catEl.value.trim() : "";
    let category = typedCat;
    const catOpts = window.__CAT_OPTS || [];
    if (catOpts.length) {
      const picked = (catEl && catEl.dataset && catEl.dataset.picked) || "";
      const match = findCategory(typedCat, catOpts);
      category = (picked && normCat(picked) === normCat(typedCat)) ? picked : (match ? match.label : "");
      if (typedCat && !category) {
        setStatus("Pick a category from the list.", "error", catEl);
        return;
      }
    }
    if (REQUIRED.category && !category) {
      setStatus("Category is required.", "error", catEl);
      return;
    }
    if (REQUIRED.description && !description) {
      setStatus("Please add a short description - accounting needs it to book the charge.", "error", $("description"));
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
    // cloud402 - with chips, the FIRST pick carries the code/kind (unchanged for one pick)
    if (chosenStores.length) { storeCode = chosenStores[0].code || ""; storeKind = chosenStores[0].kind || ""; }
    if (!storeCode && sEl && sEl.dataset && sEl.dataset.code) { storeCode = sEl.dataset.code; storeKind = sEl.dataset.kind || ""; }
    if (!storeCode) {
      const _opts = window.__STORE_OPTS || [];
      const _match = _opts.find((o) => o && o.label === store);
      if (_match) { storeCode = _match.code || ""; storeKind = _match.kind || ""; }
    }

    /* t471 - the fields ride on EVERY part of a submission, exactly as they always have */
    const makeFd = () => {
      const fd = new FormData();
      fd.append("token", token);
      fd.append("cardholder", cardholder);
      fd.append("vendor", vendor);
      fd.append("amount", amount);
      fd.append("date", date);
      fd.append("store", store);
      fd.append("store_code", storeCode);
      fd.append("store_kind", storeKind);
      /* cloud402 - the full list rides ALONGSIDE the fields above, never instead of them, so an
         app that doesn't know about `stores` yet still books the submission correctly. */
      if (chosenStores.length) fd.append("stores", JSON.stringify(chosenStores.map((c) => ({
        store: c.label, code: c.code || "", kind: c.kind || "" }))));
      /* t424 - the picked category label (empty when none). Rides ALONGSIDE every field above, so an
         app build that doesn't know `category` yet still books the submission unchanged. */
      fd.append("category", category);
      fd.append("description", description);
      return fd;
    };

    disableForm(true);
    // t471 - shrink, pack into parts that fit, refuse by name what can't fit (see SEND_LIMIT)
    setStatus(files.length ? "Getting your files ready…" : (isUpdateMode ? "Sending update…" : "Submitting…"), "info");
    const ready = [];
    for (const f of files) ready.push({ orig: f, file: await shrinkPhoto(f) });
    const todo = ready.filter((x) => !SENT_FILES.has(fileKey(x.orig)));   // a retry sends only what didn't go
    const big = todo.find((x) => x.file.size > SEND_LIMIT);
    // t472 - the file can't go through the form, so the tile hands over the email route with the receipt code
    const byEmail = () => emailTextFor({ store, category, description });
    if (big) {
      showProblem({ title: "This file is too big for the form",
                    lines: [tooBigMessage(big.orig.name || big.file.name || "That file", big.file.size, SEND_LIMIT)], email: byEmail() });
      disableForm(false);
      return;
    }
    const parts = todo.length ? packSends(todo.map((x) => x.file.size), SEND_LIMIT) : [[]];
    let sentParts = 0, sentFiles = 0;
    for (let pi = 0; pi < parts.length; pi++) {
      const fd = makeFd();
      parts[pi].forEach((ix) => fd.append("files", todo[ix].file, todo[ix].file.name));
      setStatus(parts.length > 1 ? "Sending part " + (pi + 1) + " of " + parts.length + "…" : (isUpdateMode ? "Sending update…" : "Submitting…"), "info");
      let res = null, data = {};
      try {
        res = await fetch("/api/submit", { method: "POST", body: fd });
        data = await res.json().catch(() => ({}));
      } catch (err) {
        showProblem({ title: sentParts ? "Part of your receipt didn\u2019t go through" : "Your receipt didn\u2019t go through",
          lines: [partSaid(sentParts, parts.length, sentFiles) + "Couldn't reach the form's server (" + ((err && err.message) || err) + ")."
            + (sentParts ? " Press Submit again - only what didn't go is sent." : " Nothing was sent - check the connection and press Submit again.")],
          email: byEmail() });
        disableForm(false);
        return;
      }
      if (!res.ok) {
        showProblem({ title: sentParts ? "Part of your receipt didn\u2019t go through" : "Your receipt didn\u2019t go through",
          lines: [partSaid(sentParts, parts.length, sentFiles) + failMessage(res.status, data, res.statusText, sentParts > 0)],
          email: byEmail() });
        disableForm(false);
        return;
      }
      sentParts++;
      sentFiles += parts[pi].length;
      parts[pi].forEach((ix) => SENT_FILES.add(fileKey(todo[ix].orig)));
      // Mark this token as submitted on this device so the next visit
      // shows the update banner. Wrapped in try since some browsers
      // block localStorage in incognito.
      try { localStorage.setItem(SUBMITTED_KEY, new Date().toISOString()); } catch (_) {}
    }
    if (isUpdateMode) {
      showDone("Update received", "Thanks. Your changes have been recorded.");
    } else if (parts.length > 1) {
      showDone(null, "Thanks. Your " + sentFiles + " files went in " + parts.length + " parts - every one reached the accounting team.");
    } else {
      showDone();
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
        showProblem({ title: "Couldn\u2019t mark it", lines: [(data.error || ("error " + res.status + (res.statusText ? " " + res.statusText : ""))) + " - nothing was changed. Try again."] });   // t471 - never a blank reason; t472 - a tile
        disableForm(false);
        return;
      }
      try { localStorage.setItem(SUBMITTED_KEY, new Date().toISOString()); } catch (_) {}
      // cloud342 (audit) - only a still-pending charge becomes a temp hold. If the processor reports
      // it did NOT change (the charge already has a receipt or a decision on file), don't claim it
      // was marked - say so honestly instead of a false success.
      if (data && data.instant_changed === false) {
        showDone("Nothing to change", "This charge already has a receipt or a decision on file, so it wasn't marked as a temporary hold. If that's unexpected, contact your accounting team.");
      } else {
        showDone("Marked as a temporary hold", "Thanks. No receipt is needed for this charge.");
      }
    } catch (err) {
      showProblem({ title: "Couldn\u2019t mark it", lines: ["Couldn't reach the form's server (" + (err.message || err) + ") - nothing was changed. Try again."] });   // t472 - a tile
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
        showProblem({ title: "The report didn\u2019t go through", lines: [(data.error || ("error " + res.status + (res.statusText ? " " + res.statusText : ""))) + " - nothing was sent. Try again."] });   // t471 - never a blank reason; t472 - a tile
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
      showProblem({ title: "The report didn\u2019t go through", lines: ["Couldn't reach the form's server (" + (err.message || err) + ") - nothing was sent. Try again."] });   // t472 - a tile
      disableForm(false);
    }
  }

  function setStatus(msg, kind, field) {
    /* t472 - a REJECTION is never a line at the bottom any more (his "I don't like the notification of rejection being
       on the bottom of the field"): every error is the tile over the form, with its ✕. Progress ("Submitting…",
       "Sending part 2 of 3…") stays the quiet line under the buttons. */
    if (kind === "error") { showProblem({ title: "Can\u2019t submit yet", lines: [msg], then: field }); return; }
    const el = $("status");
    el.textContent = msg;
    el.className = "status " + (kind || "");
    el.hidden = false;
    /* t471 - on a phone this line sits under three buttons, off the screen: bring it into view, so a failure is
       never something that happened out of sight (the "I thought it went" the whole t471 build is about) */
    try { el.scrollIntoView({ block: "center", behavior: "smooth" }); } catch (_) {}
  }

  function disableForm(disabled) {
    $("submit-btn").disabled = disabled;
    $("fraud-btn").disabled = disabled;
    if ($("temp-btn")) $("temp-btn").disabled = disabled;
    filesInput.disabled = disabled;
    $("store").disabled = disabled;
    // cloud402 - the chip × buttons are part of the form, so they lock with it
    document.querySelectorAll(".cc-chip-x").forEach((b) => { b.disabled = disabled; });
    if ($("category")) $("category").disabled = disabled;   // t424
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
