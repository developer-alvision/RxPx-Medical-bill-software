"use strict";


  /*
   * Set public connection values in app-config.js or the setup screen.
   * Account boundaries are enforced by supabase-setup.sql, not browser filters.
   * Secret keys belong only in server environment variables.
   */
  const CONNECTION_KEY = "rxpx.connection.v1";
  let savedConnection = {};
  try { savedConnection = JSON.parse(localStorage.getItem(CONNECTION_KEY) || "{}"); } catch (_) {}
  const APP_CONFIG = Object.freeze(Object.assign({supabaseUrl:"", supabaseAnonKey:"", aiExtraction:false, extractionFunction:"extract-bill"}, window.RXPX_CONFIG || {}, savedConnection));
  const BILL_CATEGORIES = Object.freeze({pharmacy:"Pharmacy", medical_stock:"Medical stock / supplies", patient:"Patient bill", discharge:"Discharge bill", outpatient:"OP / outpatient", inpatient:"IP / inpatient", laboratory:"Laboratory", diagnostics:"Diagnostics / scans", procedure:"Procedure / surgery", emergency:"Emergency", other:"Other hospital bill"});
  const categoryLabel = function (key) { return BILL_CATEGORIES[key] || BILL_CATEGORIES.other; };

  function isPublicBrowserKey(key) {
    if (typeof key !== "string" || key.length < 20) return false;
    if (key.startsWith("sb_publishable_")) return true;
    try { return JSON.parse(atob(key.split(".")[1].replace(/-/g,"+").replace(/_/g,"/"))).role === "anon"; }
    catch (_) { return false; }
  }
  const configured = typeof APP_CONFIG.supabaseUrl === "string" && /^https:\/\//.test(APP_CONFIG.supabaseUrl) && isPublicBrowserKey(APP_CONFIG.supabaseAnonKey);
  let db = null;
  let connectionError = "";
  try {
    if (configured && window.supabase) db = window.supabase.createClient(APP_CONFIG.supabaseUrl, APP_CONFIG.supabaseAnonKey, {
      auth: { persistSession:true, autoRefreshToken:true, detectSessionInUrl:true }
    });
  } catch (error) { connectionError = error.message; }

  if (window.pdfjsLib) window.pdfjsLib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

  function freshDraft() {
    return {
      billType:"expense", billCategory:"other", vendor:"", billNumber:"", billDate:"",
      total:"", items:[], tables:[], fields:[], currency:"INR", currencyConflict:false, warnings:[], confidence:0, extractionMethod:"manual"
    };
  }

  const state = {
    user:null, view:"boot", authMode:"signin", ledgers:[], bills:[], activeLedger:null,
    file:null, rawText:"", parsed:freshDraft(), duplicateBills:[], forceDuplicate:false,
    busy:false, scanStatus:"", scanProgress:0, detailId:null, charts:[], message:"",
    currency:"INR", tablePages:{}, useAI:!!APP_CONFIG.aiExtraction, updatedAt:null, reviewed:false, syncWarning:""
  };
  let authVersion = 0;
  let refreshVersion = 0;
  const sourcePreviews = new Set();
  const currentAccount = function (context) { return !!state.user && context.version === authVersion && context.userId === state.user.id; };
  const accountContext = function () { return {version:authVersion, userId:state.user && state.user.id}; };
  const shownBills = function () { return state.bills.filter(function (bill) { return String(bill.currency || '').toUpperCase() === 'INR'; }); };

  const $ = function (selector, root) { return (root || document).querySelector(selector); };
  const $$ = function (selector, root) { return Array.from((root || document).querySelectorAll(selector)); };
  const escapeHtml = function (value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[char];
    });
  };
  const escapeAttr = escapeHtml;
  const money = function (value) {
    return new Intl.NumberFormat("en-IN", { style:"currency", currency:"INR", maximumFractionDigits:2 }).format(Number(value || 0));
  };
  const count = function (value, word) { return String(value) + " " + word + (Number(value) === 1 ? "" : "s"); };
  const dateText = function (value, includeTime) {
    if (!value) return "—";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat("en-IN", {
      day:"2-digit", month:"short", year:"numeric",
      hour:includeTime ? "2-digit" : undefined,
      minute:includeTime ? "2-digit" : undefined,
      timeZone:/^\d{4}-\d{2}-\d{2}$/.test(String(value)) ? "UTC" : undefined
    }).format(date);
  };
  const localDate = function (date) { return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0'); };
  const fileSize = function (bytes) {
    if (!bytes) return "0 B";
    const units = ["B","KB","MB","GB"];
    const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    return (bytes / Math.pow(1024,index)).toFixed(index ? 1 : 0) + " " + units[index];
  };
  const ledgerFor = function (id) { return state.ledgers.find(function (ledger) { return ledger.id === id; }); };
  const billFor = function (id) { return state.bills.find(function (bill) { return bill.id === id; }); };
  const activeLedger = function () { return ledgerFor(state.activeLedger); };

  function toast(message) {
    const node = $("#toast");
    node.textContent = message;
    node.classList.add("show");
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { node.classList.remove("show"); }, 4200);
  }

  function setMessage(kind, title, detail) {
    state.message = { kind:kind, title:title, detail:detail || "" };
  }

  function messageHtml() {
    if (!state.message) return "";
    return '<div class="notice ' + escapeAttr(state.message.kind) + '"><div><b>' + escapeHtml(state.message.title) + '</b>' + escapeHtml(state.message.detail) + '</div></div>';
  }

  function button(label, action, extra) {
    return '<button type="button" class="btn ' + (extra || "") + '" data-act="' + action + '">' + label + "</button>";
  }

  function renderBrand() {
    return '<a class="brand" href="#" data-act="home"><span class="brand-mark">Rx</span><span>RxPx<small>HOSPITALS</small></span></a>';
  }

  function render() {
    state.charts.forEach(function (chart) { chart.destroy(); });
    state.charts = [];
    const app = $("#app");
    if (state.view === "setup") app.innerHTML = setupView();
    else if (state.view === "auth" || state.view === "boot") app.innerHTML = authView();
    else app.innerHTML = appView();
    if (state.view === "dashboard") requestAnimationFrame(drawCharts);
  }

  function setupView() {
    return '<main class="setup">' + renderBrand() + '<div class="card card-pad" style="margin-top:34px"><div class="eyebrow">Connect once</div><h1>Your bill workspace</h1><p class="sub">Connect Supabase to sign in and keep each account’s bills private. Run <a href="supabase-setup.sql" download>supabase-setup.sql</a> in your project’s SQL Editor first.</p><form data-form="connection"><label class="field"><span>Supabase Project URL</span><input name="supabaseUrl" type="url" required placeholder="https://your-project.supabase.co" value="' + escapeAttr(APP_CONFIG.supabaseUrl || '') + '"></label><label class="field"><span>Public publishable / anon key</span><input name="supabaseAnonKey" required autocomplete="off" placeholder="sb_publishable_... or public anon key" value="' + escapeAttr(APP_CONFIG.supabaseAnonKey || '') + '"></label><label class="checkline"><input name="aiExtraction" type="checkbox"' + (APP_CONFIG.aiExtraction ? ' checked' : '') + '><span><b>Enable the AI reader</b>Optional: deploy the extract-bill function first. Selected images and PDFs are sent to that reader when enabled.</span></label>' + messageHtml() + '<button class="btn primary wide" type="submit">Connect and open sign in</button></form><p class="fine">Connection settings stay in this browser. Passwords, bills, and extracted data are stored by Supabase. Setup instructions: <a href="README.md">README.md</a>.</p></div></main>';
  }

  function saveConnection(form) {
    const values = new FormData(form);
    const url = String(values.get('supabaseUrl') || '').trim().replace(/\/+$/, '');
    const key = String(values.get('supabaseAnonKey') || '').trim();
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('Use the HTTPS Project URL without a path.');
      if (key.length < 20 || key.startsWith('sb_secret_')) throw new Error('Enter the public publishable or anon key.');
      if (key.split('.').length === 3) {
        const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
        if (payload.role !== 'anon') throw new Error('Use the public anon key from your project settings.');
      } else if (!key.startsWith('sb_publishable_')) throw new Error('Enter a Supabase public publishable or anon key.');
      localStorage.setItem(CONNECTION_KEY, JSON.stringify({supabaseUrl:url,supabaseAnonKey:key,aiExtraction:values.get('aiExtraction') === 'on',extractionFunction:'extract-bill'}));
      window.location.reload();
    } catch (error) { setMessage('error','Connection details need attention.',error.message); render(); }
  }

  function authView() {
    const signup = state.authMode === "signup";
    return '<main class="auth-wrap">' +
      '<section class="auth-hero">' +
        renderBrand() +
        '<div class="hero-copy"><div class="eyebrow" style="color:#ffb561">BILL INTELLIGENCE</div><h1>Every bill, clear enough to act on.</h1><p>Read pharmacy, medical stock, patient, discharge, and OP bills. Review the extracted data and track hospital revenue and expenses in rupees.</p><div class="hero-points"><div class="hero-point"><span class="tick">✓</span> OCR results always go through a review screen</div><div class="hero-point"><span class="tick">✓</span> Dashboard totals and charts update after every save</div><div class="hero-point"><span class="tick">✓</span> Duplicate bills are blocked unless you explicitly override</div></div></div>' +
        '<p style="color:#d9cabe;font-size:12px">Only extracted bill data is saved to your account. Source images, PDFs, and spreadsheets are not stored.</p>' +
      '</section>' +
      '<section class="auth-panel"><div class="auth-card">' +
        '<div class="eyebrow">' + (signup ? "Create your workspace" : "Welcome back") + '</div>' +
        '<h1>' + (signup ? "Start securely" : "Sign in to your bills") + '</h1>' +
        '<p class="sub">' + (signup ? "Use an email that can receive a confirmation link." : "Use the account that owns these bill records.") + '</p>' +
        '<div class="tabs"><button class="' + (!signup ? "on" : "") + '" data-act="signinTab">Sign in</button><button class="' + (signup ? "on" : "") + '" data-act="signupTab">Sign up</button></div>' +
        '<form data-form="auth">' +
          (signup ? '<label class="field"><span>Full name</span><input name="name" autocomplete="name" required maxlength="100" placeholder="Your name"></label>' : "") +
          '<label class="field"><span>Email address</span><input name="email" autocomplete="email" type="email" required placeholder="you@example.com"></label>' +
          '<label class="field"><span>Password</span><input name="password" autocomplete="' + (signup ? "new-password" : "current-password") + '" type="password" ' + (signup ? 'minlength="8" ' : '') + 'required placeholder="' + (signup ? 'At least 8 characters' : 'Your password') + '"></label>' +
          (signup ? '<label class="field"><span>Confirm password</span><input name="confirmPassword" autocomplete="new-password" type="password" minlength="8" required placeholder="Repeat password"></label>' : "") +
          messageHtml() +
          '<button class="btn primary wide" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Please wait...' : signup ? "Create secure account" : "Sign in") + "</button>" +
        '</form>' +
        '<p class="fine">Your password is sent to Supabase Auth and is never stored by this app.</p>' + button('Connection settings','configure','link small') +
      "</div></section></main>";
  }

  function appView() {
    return '<div class="shell"><header class="topbar">' + renderBrand() +
      '<div class="top-actions"><span class="user-chip">' + escapeHtml(state.user && state.user.email || "") + '</span><button type="button" class="btn small" data-act="logout">Sign out</button></div>' +
      '</header><main class="app-layout"><aside class="side"><div class="side-label">Workspace</div><nav class="nav">' +
      navButton("dashboard","▦","Dashboard") + navButton("choose","＋","Add bill") + navButton("reports","◔","Reports & Excel") + navButton("profile","○","Profile") +
      '</nav></aside><section class="content">' + messageHtml() + (state.syncWarning ? '<div class="notice warn">' + escapeHtml(state.syncWarning) + '</div>' : '') + pageContent() + "</section></main></div>";
  }

  function navButton(view, icon, label) {
    const selected = (view === "choose" ? ["choose","new-ledger","existing-ledger","upload","review"].includes(state.view) : state.view === view);
    return '<button class="' + (selected ? "on" : "") + '" data-act="route" data-view="' + view + '"><span class="nav-ico">' + icon + "</span>" + label + "</button>";
  }

  function pageContent() {
    if (state.view === "loading") return pageHeader("Loading your workspace...", "Fetching this account’s bill names and totals.");
    if (state.view === "load-error") return pageHeader("Your workspace could not load", "Check the connection and database setup.",button("Try again","reloadAccount","primary"));
    if (state.view === "profile") return profileView();
    if (state.view === "dashboard") return dashboardView();
    if (state.view === "choose") return chooseView();
    if (state.view === "new-ledger") return newLedgerView();
    if (state.view === "existing-ledger") return existingLedgerView();
    if (state.view === "ledger") return ledgerView();
    if (state.view === "upload") return uploadView();
    if (state.view === "review") return reviewView();
    if (state.view === "detail") return detailView();
    if (state.view === "reports") return reportsView();
    return dashboardView();
  }

  function pageHeader(title, text, action) {
    return '<div class="page-head"><div><h1>' + title + '</h1><p>' + text + "</p></div>" + (action || "") + "</div>";
  }

  function totals() {
    return shownBills().reduce(function (acc, bill) {
      const total = Number(bill.total || 0);
      if (bill.bill_type === "income") acc.income += total;
      else acc.expense += total;
      return acc;
    }, { income:0, expense:0 });
  }

  function ledgerStats(id) {
    return shownBills().filter(function (bill) { return bill.ledger_id === id; }).reduce(function (acc, bill) {
      acc.count += 1;
      if (bill.bill_type === "income") acc.income += Number(bill.total || 0);
      else acc.expense += Number(bill.total || 0);
      if (!acc.latest || new Date(bill.created_at) > new Date(acc.latest.created_at)) acc.latest = bill;
      return acc;
    }, { count:0, income:0, expense:0, latest:null });
  }

  function dashboardView() {
    const sum = totals(), bills = shownBills(), balance = sum.income - sum.expense;
    return pageHeader('Dashboard','Confirmed bill totals, updated after every save.',currencyPicker() + ' ' + button('Add a bill','chooseBill','primary')) +
      '<div class="summary-grid">' + summaryCard('Total revenue',money(sum.income),count(bills.filter(b => b.bill_type === 'income').length,'income bill'),'income') + summaryCard('Total expenses',money(sum.expense),count(bills.filter(b => b.bill_type !== 'income').length,'expense bill'),'expense') + summaryCard('Net balance',money(balance),'Revenue minus expenses','') + '</div>' +
      '<div class="dashboard-grid"><section class="card"><div class="card-head"><div><h2>Revenue & expenses</h2><p>Confirmed totals in ' + escapeHtml(state.currency) + '</p></div></div><div class="chart-wrap"><canvas id="moneyChart" role="img" aria-label="Revenue, expense, and net totals"></canvas></div></section><section class="card"><div class="card-head"><div><h2>Spending by bill name</h2><p>Expense share in ' + escapeHtml(state.currency) + '</p></div></div><div class="chart-wrap"><canvas id="groupChart" role="img" aria-label="Expense distribution by bill name"></canvas></div></section></div>' +
      '<section class="card activity"><div class="card-head"><div><h2>Monthly trend</h2><p>Revenue and expenses by the date printed on each bill</p></div></div><div class="chart-wrap"><canvas id="trendChart" role="img" aria-label="Monthly revenue and expense trend"></canvas></div></section>' +
      '<div class="dashboard-grid"><section class="card"><div class="card-head"><div><h2>Recent bills</h2><p>Open a bill to see its saved details and extracted columns.</p></div></div><div class="bill-list">' + (bills.length ? bills.slice(0,8).map(billRow).join('') : '<div class="empty"><b>No saved bills in ' + escapeHtml(state.currency) + '</b><p>Upload and confirm your first bill to see totals and charts.</p></div>') + '</div></section><section class="card"><div class="card-head"><div><h2>Bill names</h2><p>All your saved groups</p></div></div><div class="ledger-list">' + (state.ledgers.length ? state.ledgers.map(ledgerRow).join('') : '<div class="empty">Create your first bill name to begin.</div>') + '</div></section></div>';
  }

  function currencyPicker() {
    return '<span class="pill">₹ Indian rupees</span>';
  }

  function profileView() {
    const sum = totals(), user = state.user;
    return pageHeader('Your profile','Your account and saved bill activity.',currencyPicker()) + '<section class="card card-pad"><h2>' + escapeHtml(user.user_metadata && user.user_metadata.full_name || 'Your account') + '</h2><p class="sub">' + escapeHtml(user.email) + '</p><dl class="details"><div><dt>Bill names</dt><dd>' + state.ledgers.length + '</dd></div><div><dt>Saved hospital bills</dt><dd>' + shownBills().length + '</dd></div><div><dt>Revenue (' + escapeHtml(state.currency) + ')</dt><dd>' + money(sum.income) + '</dd></div><div><dt>Expenses (' + escapeHtml(state.currency) + ')</dt><dd>' + money(sum.expense) + '</dd></div><div><dt>Joined</dt><dd>' + dateText(user.created_at,false) + '</dd></div><div><dt>Latest update</dt><dd>' + dateText(state.updatedAt,true) + '</dd></div></dl><div class="form-actions">' + button('Refresh totals','refreshAccount','') + button('Download Excel','downloadExcel','primary') + '</div></section>';
  }

  function summaryCard(label, amount, hint, className) {
    return '<section class="summary ' + className + '"><div class="label">' + label + '</div><div class="amount">' + amount + '</div><div class="hint">' + hint + "</div></section>";
  }

  function ledgerRow(ledger) {
    const stats = ledgerStats(ledger.id);
    const net = stats.income - stats.expense;
    return '<button class="ledger-row" data-act="openLedger" data-id="' + ledger.id + '"><div><div class="ledger-name">' + escapeHtml(ledger.name) + '</div><div class="ledger-meta">' + count(stats.count,"upload") + (stats.latest ? " · Last " + dateText(stats.latest.created_at,false) : "") + '</div></div><div class="ledger-total ' + (net < 0 ? "expense" : "income") + '">' + money(net) + "</div></button>";
  }

  function billRow(bill) {
    const ledger = ledgerFor(bill.ledger_id);
    const income = bill.bill_type === "income";
    return '<button class="bill-row" data-act="openBill" data-id="' + bill.id + '"><span class="bill-badge ' + (income ? "income" : "") + '">' + (income ? "↗" : "↙") + '</span><span><span class="bill-name">' + escapeHtml(ledger ? ledger.name : "Untitled bill") + '</span><span class="bill-meta">' + escapeHtml(categoryLabel(bill.bill_category)) + ' · ' + escapeHtml(bill.vendor || "No hospital / supplier") + " · " + dateText(bill.created_at,true) + '</span></span><span class="bill-value ' + (income ? "income" : "expense") + '">' + (income ? "+" : "−") + money(bill.total,bill.currency || "INR") + "</span></button>";
  }

  function chooseView() {
    return pageHeader("Add a bill", "Choose whether this is a new bill name or another upload for a name you already created.") +
      '<div class="choice-grid"><button class="choice" data-act="newLedger"><span class="choice-icon">＋</span><h2>New bill</h2><p>Create a new bill name, then capture or upload its first bill.</p><small>CREATE A NEW NAME →</small></button>' +
      '<button class="choice" data-act="existingLedger" ' + (!state.ledgers.length ? "disabled" : "") + '><span class="choice-icon">▣</span><h2>Existing bill</h2><p>' + (state.ledgers.length ? "Select a previously entered bill name and add another bill." : "Available after you create your first bill name.") + '</p><small>' + (state.ledgers.length ? "SELECT A SAVED NAME →" : "NO SAVED NAMES YET") + "</small></button></div>";
  }

  function newLedgerView() {
    return pageHeader("Create a bill name", "This name groups related uploads. You can select it again whenever you add another bill.") +
      '<form class="card form-card" style="max-width:610px" data-form="newLedger"><label class="field" style="margin-top:0"><span>Bill name</span><input name="ledgerName" required maxlength="120" autofocus placeholder="Example: OP bills — October 2026"></label><p class="fine">Use a recognizable name. The same account cannot create the same name twice.</p><div class="form-actions"><button type="button" class="btn" data-act="route" data-view="choose">Cancel</button><button type="submit" class="btn primary">Continue to upload</button></div></form>';
  }

  function existingLedgerView() {
    return pageHeader("Choose an existing bill", "Each selection opens a new upload flow but keeps this bill under the selected name.") +
      (state.ledgers.length ? '<div class="ledger-grid">' + state.ledgers.map(function (ledger) {
        const stats = ledgerStats(ledger.id);
        const net = stats.income - stats.expense;
        return '<button class="ledger-card" data-act="useLedger" data-id="' + ledger.id + '"><span class="choice-icon">▣</span><h3>' + escapeHtml(ledger.name) + '</h3><p>' + count(stats.count,"saved bill") + (stats.latest ? " · Last upload " + dateText(stats.latest.created_at,false) : "") + '</p><span class="net ' + (net < 0 ? "negative" : "") + '">' + money(net) + "</span></button>";
      }).join("") + '</div>' : '<div class="empty">There are no saved bill names yet.</div>');
  }

  function ledgerView() {
    const ledger = activeLedger();
    if (!ledger) return existingLedgerView();
    const bills = shownBills().filter(function (bill) { return bill.ledger_id === ledger.id; });
    const stats = ledgerStats(ledger.id);
    return pageHeader(escapeHtml(ledger.name), count(stats.count,"saved bill") + " · Net " + money(stats.income - stats.expense), '<button class="btn primary" data-act="uploadToActive">Add another bill</button>') +
      '<section class="card activity"><div class="card-head"><div><h2>Uploads in this bill name</h2><p>Each row includes the bill amount, bill date, and exact upload date/time.</p></div><button class="btn small" data-act="existingLedger">All names</button></div><div class="bill-list">' +
      (bills.length ? bills.map(billRow).join("") : '<div class="empty"><div class="empty-icon">◫</div><b>No uploads under this name</b><p>Use “Add another bill” to capture or upload the first bill.</p></div>') +
      "</div></section>";
  }

  function uploadView() {
    const ledger = activeLedger();
    if (!ledger) return chooseView();
    return pageHeader('Capture or upload a bill','Selected bill name: ' + escapeHtml(ledger.name),button('Change bill name','existingLedger','small')) +
      '<div class="upload-layout"><section class="drop-zone" id="dropZone"><div><div class="upload-icon">⇧</div><h2>Read a hospital bill</h2><p>Take a photo, choose from the gallery, or select a PDF, Excel workbook, or CSV. We extract the bill data without saving the file.</p><div class="upload-buttons"><label class="btn primary" for="cameraInput">Open camera</label><label class="btn" for="galleryInput">Gallery</label><label class="btn" for="fileInput">Choose file</label></div><input id="cameraInput" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif" capture="environment"><input id="galleryInput" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif"><input id="fileInput" type="file" accept="image/jpeg,image/png,image/webp,image/bmp,image/gif,application/pdf,.pdf,.xlsx,.xls,.csv"><p class="fine">Pharmacy · Medical stock · Patient · Discharge · OP · IP · Lab & more<br>JPG, PNG, WebP, BMP or static GIF &middot; Convert HEIC / TIFF first<br>Up to 20 MB &middot; PDFs up to 30 pages &middot; ₹ only</p><label class="checkline" style="text-align:left"><input type="checkbox" data-use-ai' + (state.useAI ? ' checked' : '') + '><span><b>Use the AI reader for photos and PDFs</b>Requires the optional server reader. Documents are sent to its AI provider. Spreadsheets are read directly in your browser.</span></label></div></section><aside class="card file-card">' + (state.file ? fileCard(state.file) : '<div class="empty"><b>No file selected</b><p>Select a file, then choose Read bill.</p></div>') + '</aside></div>';
  }

  function fileCard(file) {
    const kind = window.BillExtraction.fileKind(file.source);
    return '<div class="file-preview">' + (file.preview ? '<img src="' + escapeAttr(file.preview) + '" alt="Selected bill">' : '<span class="pdf-mark">' + (kind === 'sheet' ? 'XLS' : 'PDF') + '</span>') + '</div><div class="file-info"><b>' + escapeHtml(file.name) + '</b><span>' + fileSize(file.size) + '</span><div class="scan-box"><div class="scan-top"><span id="scanStatus">' + escapeHtml(state.scanStatus || 'Ready to read') + '</span><span id="scanPercent">' + Math.round(state.scanProgress) + '%</span></div><div class="progress"><i id="scanBar" style="width:' + Math.round(state.scanProgress) + '%"></i></div></div><div class="form-actions"><button class="btn small" data-act="removeFile">Remove</button><button class="btn primary small" data-act="scanAgain"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Reading...' : 'Read bill') + '</button></div>' + button('Enter details manually','manualEntry','link small') + '</div>';
  }

  function reviewView() {
    const ledger = activeLedger(), d = state.parsed;
    if (!ledger || !state.file) return uploadView();
    const warnings = (d.warnings || []).map(w => '<li>' + escapeHtml(w) + '</li>').join('');
    return '<div class="review-wrap"><div class="review-top"><div><div class="eyebrow">Review before saving</div><h1>Confirm the bill details</h1><p class="source">' + escapeHtml(ledger.name) + ' &middot; ' + escapeHtml(state.file.name) + '</p></div>' + button('Open selected original','viewSelectedFile','small') + '</div>' +
      '<div class="notice info"><div><b>Review the extracted bill data.</b>Check the total in rupees, date, hospital bill category, and every extracted column. Only these values are saved; the source file is discarded.</div></div>' +
      (d.currency !== 'INR' || d.currencyConflict ? '<div class="notice error"><div><b>This bill cannot be saved in rupees.</b>A foreign or mixed currency was detected. Choose a hospital bill with amounts in Indian rupees (₹).</div></div>' : '') +
      (warnings ? '<div class="notice warn"><ul>' + warnings + '</ul></div>' : '') +
      '<form id="reviewForm" class="card form-card" data-form="saveBill"><section class="form-section"><div class="section-title"><div><h2>Bill information</h2><p>Unknown values are left blank for you to confirm.</p></div></div><div class="grid2">' +
      '<label class="field"><span>Bill category</span><select name="billCategory">' + Object.keys(BILL_CATEGORIES).map(key => '<option value="' + key + '"' + (d.billCategory === key ? ' selected' : '') + '>' + BILL_CATEGORIES[key] + '</option>').join('') + '</select></label>' +
      '<label class="field"><span>Bill type</span><select name="billType"><option value="expense"' + (d.billType === 'expense' ? ' selected' : '') + '>Expense / purchase</option><option value="income"' + (d.billType === 'income' ? ' selected' : '') + '>Revenue / patient payment</option></select></label>' +
      '<label class="field"><span>Total amount (₹)</span><input name="total" inputmode="decimal" required value="' + escapeAttr(d.total) + '" placeholder="Grand total in rupees"></label>' +
      '<label class="field"><span>Bill date</span><input name="billDate" type="date" required value="' + escapeAttr(d.billDate) + '"></label>' +
      '<label class="field"><span>Hospital / pharmacy / supplier</span><input name="vendor" maxlength="180" value="' + escapeAttr(d.vendor) + '"></label><label class="field"><span>Bill / invoice number</span><input name="billNumber" maxlength="100" value="' + escapeAttr(d.billNumber) + '"></label></div><p class="fine">All amounts are in Indian rupees (₹).</p></section>' +
      '<section class="form-section"><div class="section-title"><div><h2>Original bill columns</h2><p>Each table keeps its own layout. Review all pages of rows before saving.</p></div>' + button('Add table','addTable','small') + '</div>' + tablesHtml(d.tables,true) + '</section>' +
      '<section class="form-section"><div class="section-title"><div><h2>Patient & hospital details</h2><p>Printed patient name, UHID / OP / IP number, doctor, admission / discharge dates, batch, expiry, GST, and other bill fields.</p></div>' + button('Add field','addField','small') + '</div>' + fieldsHtml(d.fields,true) + '</section>' +
      '<section class="form-section"><div class="section-title"><div><h2>Standard line items</h2><p>A common view when description, quantity, rate, and amount can be identified. Original columns above are preserved separately.</p></div><div>' + button('Use item total','useItemTotal','small') + ' ' + button('Add row','addItem','small') + '</div></div><div class="item-table-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Rate (₹)</th><th>Amount (₹)</th><th></th></tr></thead><tbody>' + itemRows(d.items) + '</tbody></table></div></section>' +
      '<section class="form-section"><details><summary>Extracted text</summary><label class="field"><span>Text from this document</span><textarea readonly>' + escapeHtml(state.rawText) + '</textarea></label></details>' +
      (state.duplicateBills.length ? '<label class="checkline"><input name="forceDuplicate" type="checkbox"' + (state.forceDuplicate ? ' checked' : '') + '><span><b>This exact document is already saved.</b>Save an intentional duplicate with an audit flag.</span></label>' : '') +
      '<label class="checkline"><input name="reviewed" type="checkbox" required' + (state.reviewed ? ' checked' : '') + '><span><b>I checked these values against the original.</b>The category, bill type, total in rupees, date, and extracted data are correct.</span></label><div class="form-actions">' + button('Back to file','backToUpload','') + '<button class="btn primary" type="submit"' + (state.busy ? ' disabled' : '') + '>' + (state.busy ? 'Saving...' : 'Save bill data & update dashboard') + '</button></div></section></form></div>';
  }

  function tablesHtml(tables,editable) {
    if (!tables || !tables.length) return '<p class="sub">No reliable table was detected. You can add columns and rows or use the AI reader for a complex photo.</p>';
    return tables.map(function (table,t) {
      const columns = table.columns || [], rows = table.rows || [], size = 50;
      const page = Math.max(0,Math.min(state.tablePages[t] || 0,Math.max(0,Math.ceil(rows.length / size)-1)));
      state.tablePages[t] = page;
      const start = page * size;
      return '<div class="source-table"><div class="section-title"><div>' + (editable ? '<label class="field"><span>Table name</span><input data-table-name="' + t + '" value="' + escapeAttr(table.name || 'Table ' + (t+1)) + '"></label>' : '<h3>' + escapeHtml(table.name || 'Table ' + (t+1)) + '</h3>') + '<p class="fine">' + count(columns.length,'column') + ' &middot; ' + count(rows.length,'row') + '</p></div>' + (editable ? '<div><button type="button" class="btn small" data-act="addTableColumn" data-table="' + t + '">Add column</button> <button type="button" class="btn small" data-act="addTableRow" data-table="' + t + '">Add row</button></div>' : '') + '</div><div class="item-table-wrap"><table><thead><tr>' + columns.map((col,c) => '<th>' + (editable ? '<input class="column-input" aria-label="Column ' + (c+1) + ' name" data-table-column="' + t + ':' + c + '" value="' + escapeAttr(col) + '">' : escapeHtml(col)) + '</th>').join('') + '</tr></thead><tbody>' + rows.slice(start,start+size).map((row,index) => '<tr>' + columns.map((col,c) => '<td>' + (editable ? '<input aria-label="Row ' + (start+index+1) + ', ' + escapeAttr(col) + '" data-table-cell="' + t + ':' + (start+index) + ':' + c + '" value="' + escapeAttr(row[c]) + '">' : escapeHtml(row[c])) + '</td>').join('') + '</tr>').join('') + '</tbody></table></div>' + (rows.length > size ? '<div class="table-pager"><button type="button" class="btn small" data-act="tablePage" data-table="' + t + '" data-page="' + (page-1) + '"' + (page === 0 ? ' disabled' : '') + '>Previous</button><span>Rows ' + (start+1) + '-' + Math.min(start+size,rows.length) + ' of ' + rows.length + '</span><button type="button" class="btn small" data-act="tablePage" data-table="' + t + '" data-page="' + (page+1) + '"' + (start+size >= rows.length ? ' disabled' : '') + '>Next</button></div>' : '') + '</div>';
    }).join('');
  }

  function fieldsHtml(fields,editable) {
    if (!fields || !fields.length) return '<p class="sub">No additional fields found.</p>';
    return '<div class="extra-fields">' + fields.map((field,i) => editable ? '<div class="grid2"><label class="field"><span>Label</span><input data-field-label="' + i + '" value="' + escapeAttr(field.label) + '"></label><label class="field"><span>Value</span><input data-field-value="' + i + '" value="' + escapeAttr(field.value) + '"></label></div>' : '<div class="report-stat"><span>' + escapeHtml(field.label) + '</span><b>' + escapeHtml(field.value) + '</b></div>').join('') + '</div>';
  }

  function itemRows(items) {
    if (!items.length) return '<tr><td colspan="5" class="muted">No reliable line items were read. Add important rows manually if needed.</td></tr>';
    return items.map(function (item, index) {
      return '<tr data-item-row="' + index + '"><td><input class="item-description" name="itemDescription" value="' + escapeAttr(item.description || "") + '" placeholder="Description"></td><td><input name="itemQuantity" inputmode="decimal" value="' + escapeAttr(item.quantity ?? "") + '" placeholder="—"></td><td><input name="itemRate" inputmode="decimal" value="' + escapeAttr(item.rate ?? "") + '" placeholder="—"></td><td><input name="itemAmount" inputmode="decimal" value="' + escapeAttr(item.amount ?? "") + '" placeholder="0.00"></td><td><button class="icon-button" type="button" data-act="removeItem" data-index="' + index + '" aria-label="Remove line">×</button></td></tr>';
    }).join("");
  }

  function detailView() {
    const bill = billFor(state.detailId);
    if (!bill || String(bill.currency || '').toUpperCase() !== 'INR') return dashboardView();
    const ledger = ledgerFor(bill.ledger_id);
    const income = bill.bill_type === "income";
    const items = Array.isArray(bill.items) ? bill.items : [];
    return '<div class="page-head"><div><button class="btn link" data-act="dashboard">← Dashboard</button><h1 style="margin-top:10px">' + escapeHtml(ledger ? ledger.name : "Bill details") + '</h1><p>Saved ' + dateText(bill.created_at,true) + (bill.force_uploaded ? " · Duplicate override was used" : "") + '</p></div></div>' +
      '<div class="detail-layout"><section class="card detail-hero"><div class="detail-kicker">' + (income ? "Income / sale" : "Expense / purchase") + '</div><div class="detail-amount ' + (income ? "income" : "expense") + '">' + (income ? "+" : "−") + money(bill.total,bill.currency || "INR") + '</div><dl class="details"><div><dt>Hospital / pharmacy / supplier</dt><dd>' + escapeHtml(bill.vendor || "—") + '</dd></div><div><dt>Bill number</dt><dd>' + escapeHtml(bill.bill_number || "—") + '</dd></div><div><dt>Bill date</dt><dd>' + dateText(bill.bill_date,false) + '</dd></div><div><dt>Uploaded</dt><dd>' + dateText(bill.created_at,true) + '</dd></div><div><dt>OCR confidence</dt><dd>' + escapeHtml(String(bill.extraction_confidence == null ? "—" : bill.extraction_confidence + "%")) + '</dd></div><div><dt>Bill category</dt><dd>' + escapeHtml(categoryLabel(bill.bill_category)) + "</dd></div></dl>" +
      '<section class="form-section"><div class="section-title"><div><h2>Saved line items</h2><p>' + count(items.length,"line item") + " confirmed with this upload.</p></div></div>" + (items.length ? '<div class="item-table-wrap"><table><thead><tr><th>Description</th><th>Qty</th><th>Rate (₹)</th><th>Amount (₹)</th></tr></thead><tbody>' + items.map(function (item) { return "<tr><td>" + escapeHtml(item.description || "—") + "</td><td>" + escapeHtml(item.quantity ?? "—") + "</td><td>" + escapeHtml(item.rate ?? "—") + "</td><td>" + (item.amount == null ? "—" : money(item.amount,bill.currency || "INR")) + "</td></tr>"; }).join("") + "</tbody></table></div>" : '<p class="muted" style="margin-top:14px">No line items were saved for this bill.</p>') + "</section><section class=\"form-section\"><h2>Extracted bill columns</h2>" + tablesHtml(bill.tables || [],false) + "</section><section class=\"form-section\"><h2>Patient & hospital details</h2>" + fieldsHtml(bill.fields || [],false) + "</section></section>" +
      '<aside class="card detail-side"><h3>Saved bill data</h3><p class="muted">Extracted values are saved to your account. Images, PDFs, and spreadsheet files are not retained for new bills.</p>'  + (bill.force_uploaded ? '<span class="pill">Duplicate override</span>' : '<span class="pill green">Unique source file</span>') + '<button class="btn danger wide" style="margin-top:0" data-act="deleteBill" data-id="' + bill.id + '">Delete this bill</button></aside></div>';
  }

  function reportsView() {
    const sum = totals();
    return pageHeader('Reports & Excel','The database is your live record. Export the latest saved data whenever you need a spreadsheet.',currencyPicker() + ' ' + button('Download Excel','downloadExcel','primary')) +
      '<div class="report-grid"><section class="card"><div class="card-head"><div><h2>Bill groups</h2><p>Revenue minus expenses in ' + escapeHtml(state.currency) + '</p></div></div><div class="report-stats">' + (state.ledgers.map(ledger => { const stats = ledgerStats(ledger.id); return '<div class="report-stat"><span><b>' + escapeHtml(ledger.name) + '</b><br><small>' + count(stats.count,'upload') + '</small></span><b>' + money(stats.income - stats.expense) + '</b></div>'; }).join('') || '<div class="empty">No bills saved yet.</div>') + '</div></section><aside class="card card-pad"><h2>Every column travels with your bill</h2><p class="sub">The Excel download includes hospital bill categories, summaries in rupees (₹), line items, patient and hospital details, and a separate worksheet for every extracted table. Extracted spreadsheet cells are also included.</p><p class="fine">Google Sheets is not connected. Your Supabase database updates after each save; the Excel download is a snapshot of those saved records.</p><div class="report-stats"><div class="report-stat"><span>Revenue</span><b>' + money(sum.income) + '</b></div><div class="report-stat"><span>Expenses</span><b>' + money(sum.expense) + '</b></div><div class="report-stat"><span>Net balance</span><b>' + money(sum.income-sum.expense) + '</b></div></div></aside></div>';
  }

  async function init() {
    if (!configured || !db) {
      state.view = 'setup';
      if (connectionError) setMessage('error','Check the connection settings.',connectionError);
      else if (configured && !window.supabase) setMessage('error','Sign-in library did not load.','Check your internet connection and reload.');
      render(); return;
    }
    render();
    let receivedEvent = false;
    db.auth.onAuthStateChange(function (event, session) {
      receivedEvent = true;
      applySession(session);
    });
    try {
      const response = await db.auth.getSession();
      if (response.error) throw response.error;
      if (!receivedEvent) applySession(response.data.session);
    } catch (error) {
      if (!receivedEvent) { state.view = 'auth'; setMessage('error','Could not connect.',error.message); render(); }
    }
    setInterval(backgroundRefresh,30000);
    window.addEventListener('focus',backgroundRefresh);
    window.addEventListener('online',backgroundRefresh);
    document.addEventListener('visibilitychange',function () { if (!document.hidden) backgroundRefresh(); });
  }

  function applySession(session) {
    const nextUser = session && session.user || null;
    if (state.user && nextUser && state.user.id === nextUser.id) { state.user = nextUser; return; }
    if (!state.user && !nextUser && state.view !== 'boot') return;
    authVersion += 1;
    refreshVersion += 1;
    resetPrivateState();
    state.user = nextUser;
    state.view = nextUser ? 'loading' : 'auth';
    render();
    if (nextUser) { const context = accountContext(); setTimeout(function () { loadAccount(context); },0); }
  }

  async function loadAccount(context) {
    try {
      if (!await refreshData(context) || !currentAccount(context)) return;
      state.view = state.ledgers.length ? 'choose' : 'new-ledger';
    } catch (error) {
      if (!currentAccount(context)) return;
      state.view = 'load-error';
      setMessage('error','Could not load your bills.',error.message || 'Run supabase-setup.sql and check the connection.');
    }
    if (currentAccount(context)) render();
  }

  async function signOut() {
    authVersion += 1;
    refreshVersion += 1;
    resetPrivateState();
    state.user = null;
    state.view = 'auth';
    state.busy = true;
    const version = authVersion;
    render();
    try {
      const result = await db.auth.signOut({scope:'local'});
      if (result.error) throw result.error;
    } catch (error) {
      if (version === authVersion && !state.user) setMessage('error','Sign out could not finish.',error.message || 'Check your connection and retry.');
    } finally {
      if (version === authVersion && !state.user) { state.busy = false; render(); }
    }
  }

  function resetPrivateState() {
    state.ledgers = [];
    state.bills = [];
    state.activeLedger = null;
    removeSelectedFile();
    state.rawText = '';
    state.parsed = freshDraft();
    state.duplicateBills = [];
    state.forceDuplicate = false;
    state.reviewed = false;
    state.tablePages = {};
    state.detailId = null;
    state.message = '';
    state.busy = false;
    state.updatedAt = null;
    state.currency = 'INR';
    state.syncWarning = '';
    clearTimeout(toast.timer);
    $('#toast').classList.remove('show');
  }

  async function refreshData(context) {
    context = context || accountContext();
    if (!db || !currentAccount(context)) return false;
    const request = ++refreshVersion;
    async function readAll(table) {
      const rows = [];
      for (let offset = 0; ; offset += 500) {
        if (!currentAccount(context) || request !== refreshVersion) return null;
        const response = await db.from(table).select('*').eq('user_id',context.userId).order('created_at',{ascending:table === 'bill_ledgers'}).order('id',{ascending:true}).range(offset,offset + 499);
        if (response.error) throw response.error;
        rows.push.apply(rows,response.data || []);
        if (!response.data || response.data.length < 500) return rows;
      }
    }
    const results = await Promise.all([readAll('bill_ledgers'),readAll('bills')]);
    if (!currentAccount(context) || request !== refreshVersion || results.some(r => r === null)) return false;
    // The database enforces RLS; these filters also fail closed if a legacy policy is misconfigured.
    state.ledgers = results[0].filter(row => row.user_id === context.userId);
    const ids = new Set(state.ledgers.map(row => row.id));
    state.bills = results[1].filter(row => row.user_id === context.userId && ids.has(row.ledger_id));
    state.currency = 'INR';
    state.updatedAt = new Date().toISOString();
    state.syncWarning = '';
    return true;
  }

  async function backgroundRefresh() {
    if (!state.user || state.busy || document.hidden || !['dashboard','reports','profile','ledger','choose','existing-ledger'].includes(state.view)) return;
    const context = accountContext();
    try { if (await refreshData(context) && currentAccount(context)) render(); }
    catch (_) { if (currentAccount(context)) { state.syncWarning = 'Live refresh is unavailable. Displaying the last loaded totals; try Refresh in your profile.'; render(); } }
  }

  async function handleAuth(form) {
    if (!db || state.busy) return;
    const values = new FormData(form);
    const email = String(values.get("email") || "").trim();
    const password = String(values.get("password") || "");
    const signup = state.authMode === "signup";
    const version = authVersion;
    state.message = "";
    if (signup && password !== String(values.get("confirmPassword") || "")) {
      setMessage("error","Passwords do not match.","Enter the same password twice.");
      render();
      return;
    }
    state.busy = true;
    const submitButton = form.querySelector("button[type=submit]");
    submitButton.disabled = true;
    try {
      if (signup) {
        const result = await db.auth.signUp({
          email:email, password:password,
          options:{ data:{ full_name:String(values.get("name") || "").trim() } }
        });
        if (version !== authVersion) return;
        if (result.error) throw result.error;
        if (!result.data.session) {
          setMessage("success","Check your email.","Supabase sent a confirmation link. After confirming, sign in here.");
          state.authMode = "signin";
        } else applySession(result.data.session);
      } else {
        const result = await db.auth.signInWithPassword({ email:email, password:password });
        if (version !== authVersion) return;
        if (result.error) throw result.error;
        if (result.data.session) applySession(result.data.session);
      }
    } catch (error) {
      if (version !== authVersion || state.user) return;
      setMessage("error",signup ? "Account could not be created." : "Sign-in failed.", error.message || "Please try again.");
    } finally {
      if (version === authVersion) { state.busy = false; render(); }
    }
  }

  async function createLedger(form) {
    if (state.busy || !state.user) return;
    const name = String(new FormData(form).get('ledgerName') || '').trim();
    if (!name) return;
    const context = accountContext();
    state.busy = true;
    state.message = '';
    render();
    try {
      const result = await db.from('bill_ledgers').insert({user_id:context.userId,name:name}).select('*').single();
      if (result.error) throw result.error;
      if (!currentAccount(context)) return;
      if (!state.ledgers.some(l => l.id === result.data.id)) state.ledgers.push(result.data);
      removeSelectedFile();
      state.activeLedger = result.data.id;
      state.view = 'upload';
    } catch (error) {
      if (currentAccount(context)) setMessage('error','Could not create that bill name.',error.code === '23505' ? 'Choose the existing name or enter a different name.' : error.message);
    } finally { if (currentAccount(context)) { state.busy = false; render(); } }
  }

  async function hashFile(file) {
    const bytes = await file.arrayBuffer();
    const hash = await crypto.subtle.digest("SHA-256",bytes);
    return Array.from(new Uint8Array(hash)).map(function (byte) { return byte.toString(16).padStart(2,"0"); }).join("");
  }

  async function selectFile(file) {
    if (!file || state.busy || !activeLedger() || !state.user) return;
    if (!window.BillExtraction) { setMessage('error','The bill reader did not load.','Check your connection and reload before selecting a bill.'); render(); return; }
    if (!window.BillExtraction.fileKind(file)) { setMessage('error','Choose a supported bill file.','Use JPG, PNG, WebP, BMP, static GIF, PDF, Excel, or CSV. Convert HEIC, HEIF, and TIFF to JPG, PNG, or PDF first.'); render(); return; }
    if (!file.size || file.size > 20 * 1024 * 1024) { setMessage('error','Choose a non-empty file up to 20 MB.',''); render(); return; }
    removeSelectedFile();
    const context = accountContext();
    const extension = file.name.split('.').pop().toLowerCase();
    const inferredMime = ({pdf:'application/pdf',csv:'text/csv',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel',jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',gif:'image/gif',bmp:'image/bmp'})[extension];
    const mime = (!file.type || file.type === 'application/octet-stream') && inferredMime ? inferredMime : file.type;
    if (file.type !== mime) file = new File([file],file.name,{type:mime,lastModified:file.lastModified});
    const selected = {source:file,name:file.name,type:mime,size:file.size,preview:window.BillExtraction.fileKind(file) === 'image' ? URL.createObjectURL(file) : '',hash:'',ingestionId:crypto.randomUUID()};
    state.file = selected;
    state.parsed = freshDraft(); state.rawText = ''; state.duplicateBills = []; state.forceDuplicate = false; state.reviewed = false; state.tablePages = {}; state.message = ''; state.scanStatus = 'Checking file...'; state.busy = true;
    render();
    try {
      selected.hash = await hashFile(file);
      if (!currentAccount(context) || state.file !== selected) return;
      await checkDuplicate(selected.hash,context);
      if (!currentAccount(context) || state.file !== selected) return;
      state.scanStatus = 'Ready - click Read bill';
    } catch (error) { if (currentAccount(context) && state.file === selected) setMessage('error','Could not prepare this file.',error.message); }
    finally { if (currentAccount(context) && state.file === selected) { state.busy = false; render(); } }
  }

  async function checkDuplicate(hash, context) {
    context = context || accountContext();
    const result = await db.from('bills').select('id,bill_number,created_at,ledger_id').eq('user_id',context.userId).eq('source_hash',hash).limit(10);
    if (result.error) throw result.error;
    if (currentAccount(context)) state.duplicateBills = result.data || [];
  }

  function setScanProgress(status, progress) {
    state.scanStatus = status;
    state.scanProgress = Math.max(0,Math.min(100,progress || 0));
    const statusNode = $("#scanStatus");
    const percentNode = $("#scanPercent");
    const bar = $("#scanBar");
    if (statusNode) statusNode.textContent = status;
    if (percentNode) percentNode.textContent = Math.round(state.scanProgress) + "%";
    if (bar) bar.style.width = Math.round(state.scanProgress) + "%";
  }

  async function scanSelectedFile() {
    if (!state.file || !state.file.hash || state.busy) return;
    const context = accountContext(), selected = state.file;
    state.busy = true; state.message = ''; state.reviewed = false;
    setScanProgress('Preparing the reader...',5); render();
    const progress = function (event) { if (currentAccount(context) && state.file === selected) setScanProgress(event.status,event.progress); };
    try {
      let result, fallbackWarning = '';
      if (state.useAI && window.BillExtraction.fileKind(selected.source) !== 'sheet') {
        try { result = await extractWithAI(selected.source,context); }
        catch (error) { if (!currentAccount(context)) return; fallbackWarning = 'AI reader unavailable: ' + error.message + '. Browser extraction was used; check every column.'; }
      }
      if (!result) result = await window.BillExtraction.extract(selected.source,{onProgress:progress});
      if (!currentAccount(context) || state.file !== selected) return;
      state.rawText = String(result.rawText || '');
      state.parsed = Object.assign(freshDraft(),{
        vendor:result.vendor || '', billNumber:result.bill_number || '', billDate:result.bill_date || '', total:result.total == null ? '' : String(result.total),
        items:Array.isArray(result.items) ? result.items : [], tables:Array.isArray(result.tables) ? result.tables : [], fields:Array.isArray(result.fields) ? result.fields : [],
        billCategory:result.billCategory || result.bill_category || 'other',
        currency:String(result.currency || 'INR').toUpperCase(), currencyConflict:!!result.currencyConflict || (result.warnings || []).some(warning => /multiple currencies|currency.*ambiguous|ambiguous.*currency/i.test(warning)),
        confidence:Number(result.confidence || 0), warnings:(result.warnings || []).concat(fallbackWarning ? [fallbackWarning] : []), extractionMethod:result.extraction_method || (window.BillExtraction.fileKind(selected.source) === 'sheet' ? 'spreadsheet' : 'browser')
      });
      state.tablePages = {}; state.view = 'review'; setScanProgress('Ready for review',100);
    } catch (error) {
      if (!currentAccount(context) || state.file !== selected) return;
      state.view = 'upload'; setMessage('error','Automatic reading could not finish.',error.message + ' You can enter the details manually or choose another file.'); setScanProgress('Review needed',0);
    } finally { if (currentAccount(context) && state.file === selected) { state.busy = false; render(); } }
  }

  async function extractWithAI(file,context) {
    setScanProgress('Reading the document with AI...',15);
    const response = await db.auth.getSession();
    if (response.error) throw response.error;
    if (!currentAccount(context) || !response.data.session || response.data.session.user.id !== context.userId) throw new Error('Your sign-in changed');
    const body = new FormData(); body.append('file',file);
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); },120000);
    try {
      const result = await fetch(APP_CONFIG.supabaseUrl + '/functions/v1/' + (APP_CONFIG.extractionFunction || 'extract-bill'),{
        method:'POST',headers:{Authorization:'Bearer ' + response.data.session.access_token,apikey:APP_CONFIG.supabaseAnonKey},body:body,signal:controller.signal
      });
      const data = await result.json().catch(function () { return {}; });
      if (!result.ok) throw new Error(data.error || 'Server reader returned HTTP ' + result.status);
      if (!data || !Array.isArray(data.tables) || !Array.isArray(data.items)) throw new Error('The server reader returned an incomplete result');
      return data;
    } finally { clearTimeout(timer); }
  }

  function parseMoney(value) { return window.BillExtraction.parseMoney(value); }

  function hasForeignMoney(value) {
    return /[$€£¥₩₽₺₴₦₱₫₪]|\b(?:USD|EUR|GBP|AUD|CAD|SGD|AED|JPY|CNY)\b/i.test(String(value == null ? '' : value));
  }

  function syncDraftFromReview() {
    const form = $('#reviewForm');
    if (!form) return;
    const values = new FormData(form);
    const descriptions = values.getAll('itemDescription'), quantities = values.getAll('itemQuantity'), rates = values.getAll('itemRate'), amounts = values.getAll('itemAmount');
    Object.assign(state.parsed,{
      billCategory:String(values.get('billCategory') || 'other'),billType:String(values.get('billType') || 'expense'),vendor:String(values.get('vendor') || ''),billNumber:String(values.get('billNumber') || ''),billDate:String(values.get('billDate') || ''),total:String(values.get('total') || ''),
      items:descriptions.map(function (description,index) { return {description:String(description),quantity:String(quantities[index] || ''),rate:String(rates[index] || ''),amount:String(amounts[index] || '')}; }).filter(item => item.description.trim() || item.amount !== '')
    });
    state.reviewed = values.get('reviewed') === 'on'; state.forceDuplicate = values.get('forceDuplicate') === 'on';
    $$('[data-table-cell]',form).forEach(function (input) { const [t,r,c] = input.dataset.tableCell.split(':').map(Number); state.parsed.tables[t].rows[r][c] = input.value; });
    $$('[data-table-column]',form).forEach(function (input) { const [t,c] = input.dataset.tableColumn.split(':').map(Number); state.parsed.tables[t].columns[c] = input.value; });
    $$('[data-table-name]',form).forEach(function (input) { state.parsed.tables[Number(input.dataset.tableName)].name = input.value; });
    $$('[data-field-label]',form).forEach(function (input) { state.parsed.fields[Number(input.dataset.fieldLabel)].label = input.value; });
    $$('[data-field-value]',form).forEach(function (input) { state.parsed.fields[Number(input.dataset.fieldValue)].value = input.value; });
  }

  async function saveBill(form) {
    if (state.busy || !state.user || !state.file || !activeLedger() || !form.reportValidity()) return;
    syncDraftFromReview();
    const context = accountContext(), d = structuredClone(state.parsed), selected = state.file, ledgerId = state.activeLedger;
    const total = parseMoney(d.total);
    if (d.currency !== 'INR' || d.currencyConflict || [d.total].concat(d.items.flatMap(item => [item.quantity,item.rate,item.amount])).some(hasForeignMoney)) { setMessage('error','Only bills in Indian rupees (₹) can be saved.','Choose a hospital bill with amounts in rupees. Foreign or mixed amounts cannot be recorded as INR.'); render(); return; }
    if (total == null || total <= 0 || !d.billDate || !Object.hasOwn(BILL_CATEGORIES,d.billCategory) || !state.reviewed) { setMessage('error','Check the total, bill date, category, and confirmation.','A positive confirmed total in rupees is required.'); render(); return; }
    if (d.items.some(item => [item.quantity,item.rate,item.amount].some(value => String(value).trim() && parseMoney(value) == null))) { setMessage('error','Check the line item numbers.','Each quantity, rate, and amount must contain a valid number or be left blank. Your entered values are kept for correction.'); render(); return; }
    const force = state.forceDuplicate;
    if (state.duplicateBills.length && !force) { setMessage('warn','This file is already saved.','Choose the duplicate override only for an intentional extra record.'); render(); return; }
    state.busy = true; state.message = ''; render();
    try {
      // Persist extracted values only. Source bytes and file metadata stay in memory.
      const result = await db.rpc('save_bill_with_duplicate_guard',{
        p_ledger_id:ledgerId,p_bill_type:d.billType,p_vendor:d.vendor.trim() || null,p_bill_number:d.billNumber.trim() || null,p_bill_date:d.billDate,p_total:total,
        p_items:d.items.map(item => ({description:item.description.trim(),quantity:parseMoney(item.quantity),rate:parseMoney(item.rate),amount:parseMoney(item.amount)})),
        p_source_hash:selected.hash,p_original_file_name:null,p_storage_path:null,p_file_size:null,p_ocr_text:state.rawText,
        p_extraction_confidence:Math.max(0,Math.min(100,Math.round(d.confidence || 0))),p_force_duplicate:force,
        p_tables:d.tables,p_fields:d.fields,p_currency:'INR',p_bill_category:d.billCategory,p_extraction_method:d.extractionMethod,p_ingestion_id:selected.ingestionId
      });
      if (result.error) throw result.error;
      if (!currentAccount(context) || state.file !== selected) return;
      const saved = Array.isArray(result.data) ? result.data[0] : result.data;
      if (!saved || !saved.id || saved.user_id !== context.userId) throw new Error('The database did not confirm this account’s saved record. Retry to check the same record.');
      state.bills = [saved].concat(state.bills.filter(bill => bill.id !== saved.id));
      state.currency = 'INR'; state.updatedAt = new Date().toISOString();
      removeSelectedFile(); state.parsed = freshDraft(); state.rawText = ''; state.duplicateBills = []; state.forceDuplicate = false; state.reviewed = false; state.activeLedger = null; state.detailId = saved.id; state.view = 'dashboard';
      // Saving has committed. Keep the confirmed record even if refreshing fails.
      try { await refreshData(context); }
      catch (_) { if (currentAccount(context)) state.syncWarning = 'Bill saved successfully. Full refresh is unavailable; the saved bill is included in these totals.'; }
      if (currentAccount(context)) toast('Bill saved. Dashboard, reports, and profile updated.');
    } catch (error) {
      if (!currentAccount(context)) return;
      const duplicate = error.code === '23505';
      if (duplicate) { try { await checkDuplicate(selected.hash,context); } catch (_) {} }
      if (!currentAccount(context)) return;
      setMessage(duplicate ? 'warn' : 'error',duplicate ? 'This document is already saved.' : 'Save could not be confirmed.',duplicate ? 'Review the duplicate override if this additional record is intentional.' : (error.message || 'Check your connection.') + ' Your reviewed values are kept. Retry uses the same record ID to prevent a second record.');
    } finally { if (currentAccount(context)) { state.busy = false; render(); } }
  }

  async function deleteBill(id) {
    const bill = billFor(id), context = accountContext();
    if (!bill || state.busy || !window.confirm('Delete this bill and update its totals?')) return;
    state.busy = true; state.message = ''; render();
    try {
      const result = await db.from('bills').delete().eq('id',id).eq('user_id',context.userId).select('id');
      if (result.error) throw result.error;
      if (!currentAccount(context)) return;
      if (!result.data || !result.data.length) throw new Error('The bill was already removed or is unavailable. Refresh the workspace.');
      state.bills = state.bills.filter(b => b.id !== id); state.view = 'dashboard'; state.detailId = null;
      if (bill.storage_path) {
        try { const removed = await db.storage.from('bill-files').remove([bill.storage_path]); if (removed.error) throw removed.error; }
        catch (_) { if (currentAccount(context)) state.syncWarning = 'Bill removed from totals. Its legacy attachment could not be deleted; retry file cleanup in Supabase Storage.'; }
      }
      if (currentAccount(context)) { state.updatedAt = new Date().toISOString(); toast('Bill deleted. Totals updated.'); }
    } catch (error) { if (currentAccount(context)) setMessage('error','Could not delete the bill.',error.message); }
    finally { if (currentAccount(context)) { state.busy = false; render(); } }
  }

  function removeSelectedFile() {
    if (state.file && state.file.preview) URL.revokeObjectURL(state.file.preview);
    sourcePreviews.forEach(function (preview) { URL.revokeObjectURL(preview.url); if (preview.tab && !preview.tab.closed) preview.tab.close(); });
    sourcePreviews.clear();
    $$('input[type="file"]').forEach(function (input) { input.value = ''; });
    state.file = null;
    state.scanStatus = "";
    state.scanProgress = 0;
  }

  function downloadExcel() {
    if (!state.user || !window.XLSX || !window.BillExport) { toast('The Excel library is unavailable. Check your connection and reload.'); return; }
    try {
      const book = window.BillExport.createWorkbook(shownBills(),state.ledgers,window.XLSX);
      window.XLSX.writeFile(book,'RxPx-bills-' + localDate(new Date()) + '.xlsx');
      toast('Excel downloaded with all saved columns and bill totals.');
    } catch (error) { toast('Excel export could not finish: ' + error.message); }
  }

  function drawCharts() {
    if (state.view !== 'dashboard' || !$('#moneyChart')) return;
    if (!window.Chart) { $$('.chart-wrap').forEach(node => node.innerHTML = '<p class="empty">Charts could not load. The confirmed totals and Excel report are available.</p>'); return; }
    state.charts.forEach(chart => chart.destroy()); state.charts = [];
    const sum = totals(), bills = shownBills(), colors = ['#ff7a00','#2463b5','#15754b','#8e52b9','#edb848','#d45b72','#20a1a4'];
    const base = {responsive:true,maintainAspectRatio:false,plugins:{legend:{position:'bottom'},tooltip:{callbacks:{label:ctx => (ctx.dataset.label ? ctx.dataset.label + ': ' : '') + money(ctx.raw)}}}};
    const axes = {y:{beginAtZero:true,ticks:{callback:value => new Intl.NumberFormat('en-IN',{notation:'compact'}).format(value)},grid:{color:'#f0eeeb'}},x:{grid:{display:false}}};
    state.charts.push(new window.Chart($('#moneyChart'),{type:'bar',data:{labels:['Revenue','Expenses','Net balance'],datasets:[{data:[sum.income,sum.expense,sum.income-sum.expense],backgroundColor:['#15754b','#b42318','#ff7a00'],borderRadius:8}]},options:Object.assign({},base,{plugins:Object.assign({},base.plugins,{legend:{display:false}}),scales:axes})}));
    const groups = state.ledgers.map(l => ({name:l.name,value:ledgerStats(l.id).expense})).filter(g => g.value > 0).sort((a,b) => b.value-a.value);
    if (groups.length) state.charts.push(new window.Chart($('#groupChart'),{type:'doughnut',data:{labels:groups.map(g => g.name),datasets:[{data:groups.map(g => g.value),backgroundColor:groups.map((g,i) => colors[i % colors.length]),borderWidth:3,borderColor:'#fff'}]},options:Object.assign({},base,{cutout:'65%'})}));
    else $('#groupChart').parentNode.innerHTML = '<div class="empty">No confirmed expenses yet in ' + escapeHtml(state.currency) + '.</div>';
    const months = {};
    bills.forEach(b => { const month = String(b.bill_date || '').slice(0,7); if (!/^\d{4}-\d{2}$/.test(month)) return; if (!months[month]) months[month] = {income:0,expense:0}; months[month][b.bill_type === 'income' ? 'income' : 'expense'] += Number(b.total); });
    const keys = Object.keys(months).sort();
    if (keys.length) state.charts.push(new window.Chart($('#trendChart'),{type:'line',data:{labels:keys.map(k => dateText(k+'-01',false).slice(3)),datasets:[{label:'Revenue',data:keys.map(k => months[k].income),borderColor:'#15754b',backgroundColor:'#15754b22',tension:.25,fill:true},{label:'Expenses',data:keys.map(k => months[k].expense),borderColor:'#ff7a00',backgroundColor:'#ff7a0022',tension:.25,fill:true}]},options:Object.assign({},base,{scales:axes})}));
    else $('#trendChart').parentNode.innerHTML = '<div class="empty">Your monthly trend appears after your first confirmed bill.</div>';
  }


  function navigate(view) {
    if (state.view === 'review') syncDraftFromReview();
    if (!['dashboard','choose','reports','profile','new-ledger','existing-ledger'].includes(view)) return;
    state.view = view === 'choose' && !state.ledgers.length ? 'new-ledger' : view;
    state.message = ''; render();
  }

  async function refreshAccount() {
    if (!state.user || state.busy) return;
    const context = accountContext(); state.busy = true; state.message = ''; render();
    try { await refreshData(context); if (currentAccount(context)) toast('Totals refreshed from the database.'); }
    catch (error) { if (currentAccount(context)) setMessage('error','Refresh unavailable.',error.message); }
    finally { if (currentAccount(context)) { state.busy = false; render(); } }
  }

  document.addEventListener('click',function (event) {
    const target = event.target.closest('[data-act]');
    if (!target || target.disabled) return;
    event.preventDefault();
    const action = target.dataset.act;
    if (state.busy && action !== 'logout') return;
    if (action === 'signinTab' || action === 'signupTab') { state.authMode = action === 'signinTab' ? 'signin' : 'signup'; state.message = ''; render(); return; }
    if (action === 'configure' && !state.user) { state.view = 'setup'; state.message = ''; render(); return; }
    if (action === 'home' && !state.user) return;
    if (!state.user) return;
    if (action === 'logout') { signOut().catch(function (error) { if (!state.user) { setMessage('error','Sign out needs attention.',error.message); render(); } }); }
    else if (action === 'home' || action === 'dashboard') navigate('dashboard');
    else if (action === 'route') navigate(target.dataset.view);
    else if (action === 'chooseBill') navigate('choose');
    else if (action === 'newLedger') navigate('new-ledger');
    else if (action === 'existingLedger') navigate(state.ledgers.length ? 'existing-ledger' : 'new-ledger');
    else if (action === 'reloadAccount') { state.view = 'loading'; render(); loadAccount(accountContext()); }
    else if (action === 'refreshAccount') refreshAccount();
    else if (action === 'useLedger') {
      if (!ledgerFor(target.dataset.id)) return;
      removeSelectedFile(); state.parsed = freshDraft(); state.rawText = ''; state.duplicateBills = []; state.reviewed = false; state.tablePages = {};
      state.activeLedger = target.dataset.id; state.view = 'upload'; state.message = ''; render();
    }
    else if (action === 'openLedger') { state.activeLedger = target.dataset.id; state.view = 'ledger'; render(); }
    else if (action === 'uploadToActive') { if (activeLedger()) { removeSelectedFile(); state.view = 'upload'; state.message = ''; render(); } }
    else if (action === 'openBill') { state.detailId = target.dataset.id; state.tablePages = {}; state.view = 'detail'; render(); }
    else if (action === 'removeFile') { removeSelectedFile(); state.message = ''; render(); }
    else if (action === 'scanAgain') scanSelectedFile();
    else if (action === 'manualEntry') { if (state.file && state.file.hash) { state.view = 'review'; state.parsed.extractionMethod = 'manual'; render(); } }
    else if (action === 'viewSelectedFile') {
      if (state.file) {
        const url = URL.createObjectURL(state.file.source), tab = window.open('about:blank','_blank');
        if (tab) { tab.opener = null; sourcePreviews.add({url:url,tab:tab}); tab.location = url; }
        else { URL.revokeObjectURL(url); toast('Allow popups to view the selected bill.'); }
      }
    }
    else if (action === 'backToUpload') { syncDraftFromReview(); state.view = 'upload'; render(); }
    else if (action === 'addItem') { syncDraftFromReview(); state.parsed.items.push({description:'',quantity:'',rate:'',amount:''}); render(); }
    else if (action === 'removeItem') { syncDraftFromReview(); state.parsed.items.splice(Number(target.dataset.index),1); render(); }
    else if (action === 'useItemTotal') { syncDraftFromReview(); const total = state.parsed.items.reduce((sum,item) => sum + (parseMoney(item.amount) || 0),0); state.parsed.total = total ? String(Math.round(total*100)/100) : state.parsed.total; render(); }
    else if (action === 'addTable') { syncDraftFromReview(); state.parsed.tables.push({name:'Table ' + (state.parsed.tables.length+1),columns:['Description','Amount'],rows:[['','']]}); render(); }
    else if (action === 'addTableColumn') { syncDraftFromReview(); const table = state.parsed.tables[Number(target.dataset.table)]; table.columns.push('Column ' + (table.columns.length+1)); table.rows.forEach(row => row.push('')); render(); }
    else if (action === 'addTableRow') { syncDraftFromReview(); const t = Number(target.dataset.table), table = state.parsed.tables[t]; table.rows.push(table.columns.map(() => '')); state.tablePages[t] = Math.floor((table.rows.length-1)/50); render(); }
    else if (action === 'tablePage') { syncDraftFromReview(); state.tablePages[Number(target.dataset.table)] = Math.max(0,Number(target.dataset.page)); render(); }
    else if (action === 'addField') { syncDraftFromReview(); state.parsed.fields.push({label:'',value:''}); render(); }
    else if (action === 'deleteBill') deleteBill(target.dataset.id);
    else if (action === 'downloadExcel') downloadExcel();
  });

  document.addEventListener('submit',function (event) {
    const form = event.target;
    if (!form.dataset.form) return;
    event.preventDefault();
    if (state.busy) return;
    if (form.dataset.form === 'connection') saveConnection(form);
    else if (form.dataset.form === 'auth') handleAuth(form);
    else if (state.user && form.dataset.form === 'newLedger') createLedger(form);
    else if (state.user && form.dataset.form === 'saveBill') saveBill(form);
  });

  document.addEventListener('input',function (event) { if (event.target.closest('#reviewForm')) syncDraftFromReview(); });
  document.addEventListener('change',function (event) {
    const input = event.target;
    if (input.type === 'file' && input.files && input.files[0]) { const file = input.files[0]; input.value = ''; selectFile(file); }
    else if (input.matches('[data-use-ai]')) state.useAI = input.checked;
    else if (input.closest('#reviewForm')) syncDraftFromReview();
  });
  document.addEventListener('dragover',function (event) { const zone = event.target.closest('#dropZone'); if (zone) { event.preventDefault(); zone.classList.add('drag'); } });
  document.addEventListener('dragleave',function (event) { const zone = event.target.closest('#dropZone'); if (zone) zone.classList.remove('drag'); });
  document.addEventListener('drop',function (event) { const zone = event.target.closest('#dropZone'); if (!zone) return; event.preventDefault(); zone.classList.remove('drag'); if (event.dataTransfer.files && event.dataTransfer.files[0]) selectFile(event.dataTransfer.files[0]); });

  init();
  
