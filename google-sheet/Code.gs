/**
 * RxPx Hospitals – Bills: the app's server, inside your Google Sheet.
 *
 * Put it in the spreadsheet: Extensions → Apps Script → replace Code.gs with this file → Save.
 * Then Deploy → New deployment → type "Web app" → Execute as: Me → Who has access: Anyone → Deploy,
 * and copy the Web app URL (it ends with /exec) into SHEET_URL in index.html.
 *
 * Script properties (Apps Script → Project Settings → Script properties):
 *   ANTHROPIC_API_KEY   needed for the AI bill reader (Claude). Never put it in index.html.
 *   SIGNUP_CODE         optional: new staff must type this "hospital code" to create an account
 *   BILL_READER_MODEL   optional, default claude-opus-5-5
 *   BILL_READER_EFFORT  optional, default high (low | medium | high | xhigh | max)
 *
 * What it keeps where
 *   Bills, Items, Summary   visible tabs for people. Nothing is written until the first bill is saved,
 *                           and headings come from the bills themselves (a heading is added the first
 *                           time a scanned bill has a value for it).
 *   "app …" tabs            hidden tabs the app keeps its own records in (accounts, sign-ins, bill names,
 *                           full bill details, medicine stock). Please don't edit them.
 *   Google Drive            bill photos and PDFs, in a private folder "RxPx bill photos".
 * Every account sees only its own bills in the app. The visible tabs show everyone's bills, with an Account column.
 */

const SPREADSHEET_ID = '1AiuoslceNFX7koot7MA3mBIeVWZWbZydE8iSBC2S2ds';
const SESSION_DAYS = 90;
const PHOTO_FOLDER = 'RxPx bill photos';

const BILLS = 'Bills', ITEMS = 'Items', SUMMARY = 'Summary';
const ID = 'Bill ID', ACCOUNT = 'Account'; // always the last two columns of Bills and Items
const T_USERS = 'app users', T_SESSIONS = 'app sessions', T_NAMES = 'app names', T_BILLS = 'app bills', T_MEDS = 'app medicines';
const HEADS = {
  [T_USERS]: ['Email', 'Name', 'Salt', 'Password hash', 'Created'],
  [T_SESSIONS]: ['Session', 'Email', 'Expires'],
  [T_NAMES]: ['Name ID', 'Account', 'Name', 'Type', 'Created'],
  [T_BILLS]: ['Bill ID', 'Account', 'Name ID', 'File hash', 'Saved anyway', 'Updated', 'Data'],
  [T_MEDS]: ['Medicine ID', 'Account', 'Data'],
};
const BILL_DATA = 6, MED_DATA = 2; // column (0-based) where the JSON record starts
const CHUNK = 45000;               // a cell holds up to 50,000 characters; longer records use more cells
const KINDS = ['medicine_purchase', 'pharmacy_sales', 'patient', 'lab', 'expense'];

// how known headings of the visible tabs are shown
const TEXT_COLS = [ID, ACCOUNT, 'Added by', 'Corrected by', 'Bill name', 'Kind of bill', 'Money', 'Bill number',
  'Name printed on bill', 'Supplier GSTIN', 'Vendor GSTIN', 'Patient ID', 'Payment', 'Item', 'Batch',
  'Saved anyway', 'Please check', 'Read by'];
const MONEY_COLS = ['Sub-total', 'Tax', 'Discount', 'Total', 'MRP', 'Rate', 'Amount'];
const NUMBER_COLS = ['Items', 'Qty', 'Free', 'Disc %', 'GST %'];
const DATE_COLS = ['Bill date', 'Expiry', 'Mfg date'];
const TIME_COLS = ['Added on'];

/* ===================================================================== requests */

function doGet() {
  return json({ ok: true, app: 'rxpx-bills', version: 2, signupCode: !!prop('SIGNUP_CODE'), ai: !!prop('ANTHROPIC_API_KEY') });
}

const ACTIONS = {
  signup: (ss, r) => signup(ss, r),
  signin: (ss, r) => signin(ss, r),
  signout: (ss, r) => { deleteWhere(ss, T_SESSIONS, x => x[0] === hex(digest(r.session))); return {}; },
  me: (ss, r, u) => ({ user: u }),
  load: (ss, r, u) => loadAll(ss, u),
  read: (ss, r) => readBill(r),
  save: (ss, r, u) => saveBill(ss, r, u),
  delete: (ss, r, u) => deleteBill(ss, r, u),
  meds: (ss, r, u) => { saveMeds(ss, u, r.meds || []); return {}; },
  photo: (ss, r, u) => photos(ss, r, u),
  import: (ss, r, u) => importBills(ss, r, u),
  sync: (ss, r, u) => { writeVisible(ss, r.rows || [], [], u.email, u.email); writeSummary(ss); return {}; },
};
const OPEN = ['signup', 'signin'];                // no sign-in needed
const NO_LOCK = ['me', 'load', 'read', 'photo'];  // only read, or (read) wait a long time for the AI reader

function doPost(e) {
  let req;
  try { req = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { return json({ ok: false, error: 'The request could not be read.' }); }
  const fn = ACTIONS[req.action];
  if (!fn) return json({ ok: false, error: 'Unknown action.' });
  const lock = LockService.getScriptLock(), locked = NO_LOCK.indexOf(req.action) < 0;
  try {
    if (locked && !lock.tryLock(30000)) return json({ ok: false, error: 'The sheet is busy. Try again in a moment.' });
    const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
    let user = null;
    if (OPEN.indexOf(req.action) < 0) {
      user = sessionUser(ss, req.session);
      if (!user) return json({ ok: false, code: 'session', error: 'Please sign in again.' });
    }
    return json(Object.assign({ ok: true }, fn(ss, req, user)));
  } catch (err) {
    return json({ ok: false, error: String((err && err.message) || err) });
  } finally {
    if (locked) try { lock.releaseLock(); } catch (x) {}
  }
}

/* ===================================================================== accounts */

function signup(ss, r) {
  const email = cleanEmail(r.email), name = String(r.name || '').trim(), pw = String(r.password || '');
  if (!email) throw new Error('Please enter a valid email address.');
  if (!name) throw new Error('Please tell us your full name.');
  if (pw.length < 6) throw new Error('Your password needs at least 6 characters.');
  const code = prop('SIGNUP_CODE');
  if (code && String(r.code || '').trim() !== code) throw new Error('The hospital code is wrong. Ask your admin for it.');
  const sh = tab(ss, T_USERS);
  if (findRow(sh, email) > 0) throw new Error('An account with this email already exists. Sign in instead.');
  const salt = Utilities.getUuid();
  appendRow(sh, [email, name, salt, pwHash(pw, salt), new Date().toISOString()]);
  return { session: newSession(ss, email), user: { id: email, email: email, name: name } };
}

function signin(ss, r) {
  const email = cleanEmail(r.email), pw = String(r.password || '');
  const sh = ss.getSheetByName(T_USERS), row = sh && email ? findRow(sh, email) : -1;
  if (row < 0) throw new Error('Email or password is wrong.');
  const v = sh.getRange(row, 1, 1, 4).getValues()[0];
  if (pwHash(pw, String(v[2])) !== String(v[3])) throw new Error('Email or password is wrong.');
  return { session: newSession(ss, email), user: { id: email, email: email, name: String(v[1]) } };
}

function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@=+\-][^\s@]*@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

// salted, repeated HMAC-SHA256; only the hash is stored
function pwHash(pw, salt) {
  const key = Utilities.newBlob(String(salt)).getBytes();
  let h = Utilities.computeHmacSha256Signature(Utilities.newBlob(pw).getBytes(), key);
  for (let i = 0; i < 1000; i++) h = Utilities.computeHmacSha256Signature(h, key);
  return hex(h);
}

function newSession(ss, email) {
  const sh = tab(ss, T_SESSIONS), now = Date.now();
  deleteWhere(ss, T_SESSIONS, x => new Date(x[2]).getTime() < now); // forget sign-ins that have expired
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  appendRow(sh, [hex(digest(token)), email, new Date(now + SESSION_DAYS * 864e5).toISOString()]);
  return token;
}

function sessionUser(ss, token) {
  if (!token) return null;
  const sh = ss.getSheetByName(T_SESSIONS), row = sh ? findRow(sh, hex(digest(String(token)))) : -1;
  if (row < 0) return null;
  const v = sh.getRange(row, 1, 1, 3).getValues()[0];
  if (new Date(v[2]).getTime() < Date.now()) return null;
  const us = ss.getSheetByName(T_USERS), ur = us ? findRow(us, String(v[1])) : -1;
  if (ur < 0) return null; // the admin removed this account
  return { id: String(v[1]), email: String(v[1]), name: String(us.getRange(ur, 2).getValue()) };
}

/* ===================================================================== bills */

function loadAll(ss, u) {
  const names = rowsOf(ss, T_NAMES).filter(x => x[1] === u.email).map(x => ({ id: x[0], name: x[2], type: x[3], created_at: x[4] }));
  const bills = rowsOf(ss, T_BILLS).filter(x => x[1] === u.email).map(x => unpack(x.slice(BILL_DATA)));
  const meds = rowsOf(ss, T_MEDS).filter(x => x[1] === u.email).map(x => unpack(x.slice(MED_DATA)));
  return { names: names, bills: bills, meds: meds };
}

function saveBill(ss, r, u, quiet) {
  const b = r.bill || {};
  if (!b.id) throw new Error('This bill has no ID.');
  if (KINDS.indexOf(b.type) < 0) throw new Error('Choose what kind of bill this is.');
  if (!(Number(b.total) > 0)) throw new Error('Enter the total amount of the bill.');
  const sh = tab(ss, T_BILLS), row = findRow(sh, b.id);
  if (row > 0 && String(sh.getRange(row, 2).getValue()) !== u.email) throw new Error('This bill belongs to another account.');
  // the same photo or file saved before is refused, unless the user chose "Save anyway"
  if (row < 0 && b.file_hash && !b.forced &&
      rowsOf(ss, T_BILLS).some(x => x[1] === u.email && x[3] === b.file_hash && x[4] !== 'yes')) {
    throw new Error('This bill is already saved.');
  }
  const nameId = saveName(ss, u, r.name || {}, b.type);
  let file = b.file || null, photoError = '';
  if (row > 0 && !(r.files && r.files.length)) {
    // a corrected bill keeps the photos already stored for it
    const old = unpack(sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0].map(String).slice(BILL_DATA));
    if (old.file && old.file.drive && !(file && file.drive)) file = old.file;
  }
  if (r.files && r.files.length) {
    try {
      file = Object.assign({}, file, { drive: saveFiles(b.id, r.files), types: r.files.map(f => f.type), stored: true });
    } catch (err) {
      photoError = String((err && err.message) || err); // the bill is still saved, without its photo
      file = Object.assign({}, file, { stored: false });
    }
  }
  const rec = Object.assign({}, b, { name_id: nameId, file: file, raw_text: String(b.raw_text || '').slice(0, 20000) });
  putRow(sh, [b.id, u.email, nameId, b.file_hash || '', b.forced ? 'yes' : '', new Date().toISOString()].concat(pack(rec)), row > 0 ? row : 0);
  saveMeds(ss, u, r.meds || []);
  dropMeds(ss, u, r.drop || []);
  if (r.sheet) writeVisible(ss, [{ id: b.id, bill: r.sheet.bill || {}, items: r.sheet.items || [] }], [], null, u.email);
  if (!quiet) writeSummary(ss);
  return { name_id: nameId, file: file, photoError: photoError };
}

function deleteBill(ss, r, u) {
  const sh = ss.getSheetByName(T_BILLS), row = sh ? findRow(sh, r.id) : -1;
  if (row < 0) return {};
  const v = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x));
  if (v[1] !== u.email) throw new Error('This bill belongs to another account.');
  const rec = unpack(v.slice(BILL_DATA));
  sh.deleteRow(row);
  // a bill name goes away with its last bill
  if (!rowsOf(ss, T_BILLS).some(x => x[2] === v[2])) deleteWhere(ss, T_NAMES, x => x[0] === v[2] && x[1] === u.email);
  saveMeds(ss, u, r.meds || []);
  dropMeds(ss, u, r.drop || []);
  trashFiles(rec.file);
  writeVisible(ss, [], [String(r.id)], null, u.email);
  writeSummary(ss);
  return {};
}

function saveName(ss, u, n, type) {
  const sh = tab(ss, T_NAMES), key = normName(n.name);
  if (!key) throw new Error('This bill has no name.');
  const hit = rowsOf(ss, T_NAMES).find(x => x[1] === u.email && normName(x[2]) === key);
  if (hit) {
    if (!hit[3] && type) sh.getRange(findRow(sh, hit[0]), 4).setValue(type);
    return hit[0];
  }
  const id = n.id && findRow(sh, n.id) < 0 ? String(n.id) : Utilities.getUuid();
  appendRow(sh, [id, u.email, String(n.name).trim(), type || '', new Date().toISOString()]);
  return id;
}

function normName(v) { return String(v || '').trim().toLowerCase().replace(/\s+/g, ' '); }

function saveMeds(ss, u, meds) {
  if (!meds.length) return;
  const sh = tab(ss, T_MEDS), rows = idRows(sh);
  meds.forEach(m => {
    if (!m || !m.id) return;
    const at = rows[String(m.id)];
    if (at && String(sh.getRange(at, 2).getValue()) !== u.email) return; // never touch another account's stock
    rows[String(m.id)] = putRow(sh, [String(m.id), u.email].concat(pack(m)), at || 0);
  });
}

// stock rows a deleted or corrected bill had created, now empty and used by no other bill
// (the app works this out; only that account's own rows can be removed)
function dropMeds(ss, u, ids) {
  if (!ids.length) return;
  deleteWhere(ss, T_MEDS, x => ids.indexOf(x[0]) >= 0 && x[1] === u.email);
}

function importBills(ss, r, u) {
  let n = 0;
  (r.bills || []).forEach(b => {
    const name = (r.names || []).find(x => x.id === b.name_id) || { name: 'Imported bill' };
    try { saveBill(ss, { bill: b, name: name, meds: [], drop: [] }, u, true); n++; } catch (err) { /* already saved or not valid: left out */ }
  });
  saveMeds(ss, u, r.meds || []);
  writeVisible(ss, r.sheet || [], [], null, u.email);
  writeSummary(ss);
  return { count: n };
}

/* ===================================================================== photos (Google Drive) */

function folder() {
  const p = PropertiesService.getScriptProperties(), id = p.getProperty('PHOTO_FOLDER_ID');
  if (id) { try { return DriveApp.getFolderById(id); } catch (err) { /* removed: make a new one */ } }
  const f = DriveApp.createFolder(PHOTO_FOLDER);
  p.setProperty('PHOTO_FOLDER_ID', f.getId());
  return f;
}

function saveFiles(billId, files) {
  const f = folder();
  return files.slice(0, 6).map((x, i) => f.createFile(Utilities.newBlob(Utilities.base64Decode(x.data),
    x.type || 'application/octet-stream', billId + '-' + (i + 1) + '.' + (x.ext || 'bin'))).getId());
}

function trashFiles(file) {
  ((file && file.drive) || []).forEach(id => { try { DriveApp.getFileById(id).setTrashed(true); } catch (err) {} });
}

function photos(ss, r, u) {
  const sh = ss.getSheetByName(T_BILLS), row = sh ? findRow(sh, r.id) : -1;
  if (row < 0) return { files: [] };
  const v = sh.getRange(row, 1, 1, sh.getLastColumn()).getValues()[0].map(x => String(x));
  if (v[1] !== u.email) throw new Error('This bill belongs to another account.');
  const rec = unpack(v.slice(BILL_DATA));
  return {
    files: ((rec.file && rec.file.drive) || []).map(id => {
      try { const b = DriveApp.getFileById(id).getBlob(); return { data: Utilities.base64Encode(b.getBytes()), type: b.getContentType() }; } catch (err) { return null; }
    }).filter(Boolean),
  };
}

/* ===================================================================== AI bill reader (Claude) */

// every value is a string copied exactly as printed ("" when the bill does not show it);
// keeping numbers as printed text avoids silent rounding and keeps the schema free of nullable unions
const S_ = { type: 'string' };
const ITEM_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    description: S_, batch_no: S_, hsn: S_, pack: S_, manufacturer: S_, manufacture_date: S_, expiry_date: S_,
    quantity: S_, free_quantity: S_, mrp: S_, rate: S_, discount_percent: S_, gst_percent: S_, amount: S_,
    unclear: { type: 'boolean' },
  },
  required: ['description', 'batch_no', 'hsn', 'pack', 'manufacturer', 'manufacture_date', 'expiry_date',
    'quantity', 'free_quantity', 'mrp', 'rate', 'discount_percent', 'gst_percent', 'amount', 'unclear'],
};
const BILL_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: {
    is_bill: { type: 'boolean' },
    bill_type: { type: 'string', enum: KINDS },
    type_certain: { type: 'boolean' },
    seller_name: S_, seller_gstin: S_, buyer_name: S_, patient_name: S_, patient_id: S_,
    bill_number: S_, bill_date: S_, bill_time: S_, payment_mode: S_,
    items: { type: 'array', items: ITEM_SCHEMA },
    subtotal: S_, discount_amount: S_, tax_amount: S_, round_off: S_, total_amount: S_, amount_in_words: S_,
    unclear_fields: { type: 'array', items: S_ },
  },
  required: ['is_bill', 'bill_type', 'type_certain', 'seller_name', 'seller_gstin', 'buyer_name', 'patient_name',
    'patient_id', 'bill_number', 'bill_date', 'bill_time', 'payment_mode', 'items', 'subtotal', 'discount_amount',
    'tax_amount', 'round_off', 'total_amount', 'amount_in_words', 'unclear_fields'],
};

function systemPrompt(hospital) {
  return `You read bills for ${hospital}, a hospital in India, and copy them into a database. Staff photograph paper bills on their phones; the photos can be tilted, curled, dim or partly blurred. The hospital pays and records money from these numbers, so a wrong value is far worse than an empty one.

Copy what is printed, exactly:
- Read every line item in the order printed, across all pages. Do not skip, merge or summarise items, and never add one that is not printed. Header rows, sub-totals, tax summary tables, "amount in words", signatures and addresses are not items.
- Copy numbers as printed but without currency symbols or thousands separators ("1,234.50" -> "1234.50"). Leave a field "" when the bill does not show it or you cannot read it with confidence. Never work a value out from other values and enter it as if it were printed.
- quantity is the billed quantity column; free_quantity is the free/scheme/bonus column (or the "+2" in "10+2"). rate is the price per unit before tax (PTR/rate column); mrp is the MRP column; amount is the line's own amount column.
- Dates: bill_date as YYYY-MM-DD (Indian bills are day/month/year). Expiry and manufacturing dates as YYYY-MM when only month and year are printed ("06/27", "JUN-27" -> "2027-06"), else YYYY-MM-DD.
- total_amount is the final amount payable (grand total / net amount / net payable), after tax, discount and round-off.
- Set unclear: true on any item where a character was hard to read, and list the bill-level fields you were unsure of in unclear_fields (for example "bill_date", "total_amount").
- Check your reading: the item amounts should add up to the sub-total or total, and quantity x rate should match each amount once discount and GST are allowed for. If they do not, look at the image again and correct misread digits. If the printed values still do not add up, keep them as printed and mark them unclear.

bill_type is about how the money moves for ${hospital}:
- medicine_purchase: a distributor, wholesaler or pharma company sold medicines TO the hospital (supplier name at the top, often PTR, free qty, HSN, batch and expiry columns).
- pharmacy_sales: ${hospital}'s own pharmacy sold medicines to a patient.
- patient: ${hospital} billed a patient for room, doctor, nursing, procedures, surgery or similar charges.
- lab: ${hospital} billed for lab tests, scans or other diagnostics.
- expense: any other bill the hospital pays (electricity, water, rent, repairs, maintenance, supplies, fuel, services).
Set type_certain to false when the bill could reasonably be more than one type. Set is_bill to false if the image is not a bill or receipt at all.`;
}

function readBill(r) {
  const key = prop('ANTHROPIC_API_KEY');
  if (!key) throw new Error('The AI reader is not set up yet: add ANTHROPIC_API_KEY in the script properties (see SETUP.md).');
  const pages = (Array.isArray(r.pages) ? r.pages : []).slice(0, 6);
  if (!pages.length) throw new Error('No bill was sent.');
  const content = [];
  pages.forEach((p, i) => {
    if (!p || !p.data) throw new Error('A page of the bill was empty.');
    if (p.media_type === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: p.data } });
    } else if (['image/jpeg', 'image/png', 'image/webp'].indexOf(p.media_type) >= 0) {
      if (pages.length > 1) content.push({ type: 'text', text: 'Page ' + (i + 1) + ' of ' + pages.length + ':' });
      content.push({ type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.data } });
    } else {
      throw new Error('Only photos (JPG, PNG, WebP) and PDFs can be read.');
    }
  });
  const hospital = String(r.hospital_name || 'the hospital').slice(0, 120);
  const name = String(r.bill_name || '').slice(0, 120), usual = KINDS.indexOf(r.usual_type) >= 0 ? r.usual_type : '';
  content.push({
    type: 'text',
    text: 'Read this bill' + (pages.length > 1 ? ' (' + pages.length + ' pages)' : '') + ' and fill in every field.' +
      (name ? ' Staff filed it under the name "' + name + '".' : '') +
      (usual ? ' Earlier bills filed under this name were of type ' + usual + '.' : ''),
  });
  const body = {
    model: prop('BILL_READER_MODEL') || 'claude-opus-5-5',
    max_tokens: 16000,
    fallbacks: 'default',
    output_config: { effort: prop('BILL_READER_EFFORT') || 'high', format: { type: 'json_schema', schema: BILL_SCHEMA } },
    system: systemPrompt(hospital),
    messages: [{ role: 'user', content: content }],
  };
  const started = Date.now();
  let res;
  for (let attempt = 0; ; attempt++) {
    res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
      timeoutSeconds: 330,
    });
    const c = res.getResponseCode();
    // a busy or briefly failing service gets one more try, if there is time left
    if ((c === 429 || c === 529 || c >= 500) && attempt === 0 && Date.now() - started < 60000) { Utilities.sleep(5000); continue; }
    break;
  }
  const code = res.getResponseCode();
  let j = {};
  try { j = JSON.parse(res.getContentText()); } catch (err) {}
  if (code === 401 || code === 403) throw new Error('The AI reader key is not valid. Check ANTHROPIC_API_KEY in the script properties.');
  if (code === 429 || code === 529) throw new Error('The AI reader is busy. Wait a minute and try again.');
  if (code === 413) throw new Error('The bill is too large to read. Use fewer or smaller pages.');
  if (code >= 400) throw new Error('The bill could not be read: ' + ((j.error && j.error.message) || ('error ' + code)));
  if (j.stop_reason === 'refusal') throw new Error('This bill could not be read automatically. Please type the details.');
  if (j.stop_reason === 'max_tokens') throw new Error('This bill is too long to read in one go. Upload fewer pages at a time.');
  const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  if (!text) throw new Error('The AI reader returned nothing. Try again.');
  return { bill: JSON.parse(text), model: j.model };
}

/* ===================================================================== visible tabs: Bills, Items, Summary */

function writeVisible(ss, saves, remove, syncAccount, account) {
  const groups = saves.filter(s => s && s.id);
  writeRows(ss, BILLS, groups.map(s => ({ id: String(s.id), account: account, rows: [Object.assign({}, s.bill || {})] })), remove, syncAccount);
  writeRows(ss, ITEMS, groups.map(s => ({ id: String(s.id), account: account, rows: (s.items || []).map(x => Object.assign({}, x)) })), remove, syncAccount);
}

// replaces the rows of the given bills (keeping their place), removes deleted bills, appends new ones
function writeRows(ss, name, groups, remove, syncAccount) {
  groups.forEach(g => g.rows.forEach(r => { r[ID] = g.id; r[ACCOUNT] = g.account; }));
  let sh = ss.getSheetByName(name);
  if (!sh) {
    if (!groups.some(g => g.rows.length)) return; // nothing to write yet: create nothing
    sh = newSheet(ss, name);
  }
  const keys = [];
  groups.forEach(g => g.rows.forEach(r => Object.keys(r).forEach(k => {
    if (keys.indexOf(k) < 0 && r[k] !== '' && r[k] !== null && r[k] !== undefined) keys.push(k);
  })));
  const head = ensureHeadings(sh, keys);
  const width = head.length;
  if (!width) return;
  const lastRow = sh.getLastRow();
  const old = lastRow > 1 ? sh.getRange(2, 1, lastRow - 1, width).getValues() : [];
  const idCol = head.indexOf(ID), accCol = head.indexOf(ACCOUNT);
  const fresh = {}, placed = {}, removed = {};
  groups.forEach(g => { fresh[g.id] = g.rows; });
  remove.forEach(id => { removed[id] = true; });
  const out = [];
  old.forEach(r => {
    const id = String(r[idCol]);
    if (removed[id]) return;
    if (fresh[id]) {
      if (!placed[id]) { placed[id] = true; fresh[id].forEach(nr => out.push(toRow(nr, head))); }
      return;
    }
    if (syncAccount && id && String(r[accCol]) === syncAccount) return; // that account no longer has this bill
    out.push(r.map(keepText));
  });
  groups.forEach(g => { if (!placed[g.id]) g.rows.forEach(nr => out.push(toRow(nr, head))); });
  if (sh.getMaxRows() < out.length + 1) sh.insertRowsAfter(sh.getMaxRows(), out.length + 1 - sh.getMaxRows());
  if (old.length) sh.getRange(2, 1, old.length, width).clearContent();
  if (out.length) sh.getRange(2, 1, out.length, width).setValues(out);
}

// a new tab; the spreadsheet's own, still empty tab ("Sheet1") becomes "Bills"
function newSheet(ss, name) {
  const own = ss.getSheets().filter(s => s.getName().indexOf('app ') !== 0);
  if (name === BILLS && own.length === 1 && own[0].getLastRow() === 0 && own[0].getLastColumn() === 0 &&
      [ITEMS, SUMMARY].indexOf(own[0].getName()) < 0) {
    own[0].setName(BILLS);
    return own[0];
  }
  return ss.insertSheet(name);
}

// adds headings this bill has and the tab does not, just before "Bill ID"
function ensureHeadings(sh, keys) {
  const lastCol = sh.getLastColumn();
  const head = lastCol ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  const add = keys.filter(k => head.indexOf(k) < 0 && k !== ID && k !== ACCOUNT);
  [ID, ACCOUNT].forEach(k => { if (head.indexOf(k) < 0 && keys.indexOf(k) >= 0) add.push(k); });
  if (!add.length) return head;
  const idPos = head.indexOf(ID);
  let at;
  if (idPos >= 0) {
    at = idPos + 1;
    sh.insertColumnsBefore(at, add.length);
    head.splice(idPos, 0, ...add);
  } else {
    at = head.length + 1;
    if (sh.getMaxColumns() < head.length + add.length) sh.insertColumnsAfter(sh.getMaxColumns(), head.length + add.length - sh.getMaxColumns());
    head.push(...add);
  }
  sh.getRange(1, at, 1, add.length).setValues([add.map(safe)]).setFontWeight('bold');
  const rows = Math.max(1, sh.getMaxRows() - 1);
  add.forEach((k, i) => sh.getRange(2, at + i, rows, 1).setNumberFormat(formatOf(k)));
  sh.setFrozenRows(1);
  return head;
}

function formatOf(k) {
  if (TEXT_COLS.indexOf(k) >= 0) return '@';
  if (MONEY_COLS.indexOf(k) >= 0) return '#,##0.00';
  if (DATE_COLS.indexOf(k) >= 0) return 'dd mmm yyyy';
  if (TIME_COLS.indexOf(k) >= 0) return 'dd mmm yyyy, h:mm am/pm';
  if (NUMBER_COLS.indexOf(k) >= 0) return '0.###';
  return 'General'; // a new column must not copy the text format of the column next to it
}

function toRow(obj, head) {
  return head.map(h => {
    const v = obj[h];
    if (v === '' || v === null || v === undefined) return '';
    if (TIME_COLS.indexOf(h) >= 0) { const d = new Date(v); return isNaN(d.getTime()) ? safe(String(v)) : d; }
    if (typeof v === 'boolean') return v ? 'Yes' : '';
    return typeof v === 'string' ? safe(v) : v; // "YYYY-MM-DD" dates are turned into dates by the sheet itself
  });
}

function keepText(v) { return typeof v === 'string' ? safe(v) : v; }

function writeSummary(ss) {
  const bills = ss.getSheetByName(BILLS);
  let sh = ss.getSheetByName(SUMMARY);
  if (!bills || bills.getLastRow() < 2) { if (sh) sh.clearContents(); return; }
  const width = bills.getLastColumn();
  const head = bills.getRange(1, 1, 1, width).getValues()[0].map(String);
  const rows = bills.getRange(2, 1, bills.getLastRow() - 1, width).getValues();
  const c = n => head.indexOf(n);
  const cMoney = c('Money'), cTotal = c('Total'), cKind = c('Kind of bill'), cDate = c('Bill date'), cAdded = c('Added on');
  const tz = ss.getSpreadsheetTimeZone();
  const month = v => (v && typeof v.getTime === 'function') ? Utilities.formatDate(v, tz, 'yyyy-MM') : String(v || '').slice(0, 7);
  const blank = () => ({ in: 0, out: 0, n: 0 });
  const all = blank(), kinds = {}, months = {};
  rows.forEach(r => {
    if (cTotal < 0 || r[cTotal] === '') return;
    const amt = Number(r[cTotal]) || 0, dir = /^(in|revenue)$/i.test(String(r[cMoney]).trim()) ? 'in' : 'out';
    const kind = String((cKind >= 0 && r[cKind]) || 'Other');
    const m = month((cDate >= 0 && r[cDate]) || (cAdded >= 0 ? r[cAdded] : '')) || 'No date';
    [all, kinds[kind] = kinds[kind] || blank(), months[m] = months[m] || blank()].forEach(t => { t[dir] += amt; t.n++; });
  });
  const r2 = x => Math.round(x * 100) / 100;
  const line = (label, t) => [label, r2(t.in), r2(t.out), r2(t.in - t.out), t.n];
  const heads = ['Revenue', 'Expenses', 'Balance (revenue − expenses)', 'Bills'];
  const out = [
    ['Summary · updated ' + Utilities.formatDate(new Date(), tz, 'dd MMM yyyy, h:mm a'), '', '', '', ''],
    [''].concat(heads),
    line('All bills', all),
    ['', '', '', '', ''],
    ['By kind of bill'].concat(heads),
  ];
  Object.keys(kinds).sort().forEach(k => out.push(line(k, kinds[k])));
  out.push(['', '', '', '', ''], ['By month (bill date)'].concat(heads));
  Object.keys(months).sort().reverse().forEach(m => out.push(line(m, months[m])));
  if (!sh) sh = ss.insertSheet(SUMMARY);
  sh.clearContents();
  sh.getRange(1, 1, out.length, 1).setNumberFormat('@'); // month labels like 2026-10 stay text
  sh.getRange(2, 2, out.length - 1, 3).setNumberFormat('#,##0.00');
  sh.getRange(1, 1, out.length, 5).setValues(out.map(r => [safe(r[0])].concat(r.slice(1))));
  out.forEach((r, i) => { if (i === 0 || r[1] === heads[0]) sh.getRange(i + 1, 1, 1, 5).setFontWeight('bold'); });
}

/* ===================================================================== hidden app tabs */

// a hidden tab with its heading row, created on first use; every cell holds plain text
function tab(ss, name) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
    sh.getRange(1, 1, 1, HEADS[name].length).setValues([HEADS[name]]).setFontWeight('bold');
    sh.setFrozenRows(1);
    sh.hideSheet();
  }
  return sh;
}

function rowsOf(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(1, sh.getLastColumn())).getValues()
    .map(r => r.map(x => (x === null || x === undefined ? '' : String(x))));
}

function idRows(sh) {
  const out = {}, last = sh.getLastRow();
  if (last < 2) return out;
  sh.getRange(2, 1, last - 1, 1).getValues().forEach((r, i) => { out[String(r[0])] = i + 2; });
  return out;
}

function findRow(sh, id) { return idRows(sh)[String(id)] || -1; }

function appendRow(sh, values) { return putRow(sh, values, 0); }

// writes a whole row (id in the first cell) at row `at`, or after the last row; returns the row number
function putRow(sh, values, at) {
  const row = at || Math.max(sh.getLastRow(), 1) + 1;
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows() + 20);
  if (values.length > sh.getMaxColumns()) {
    const extra = values.length - sh.getMaxColumns();
    sh.insertColumnsAfter(sh.getMaxColumns(), extra);
    sh.getRange(1, sh.getMaxColumns() - extra + 1, sh.getMaxRows(), extra).setNumberFormat('@');
  }
  const width = Math.max(values.length, sh.getLastColumn());
  const full = values.map(v => (typeof v === 'string' ? safe(v) : v)).concat(Array(width - values.length).fill(''));
  sh.getRange(row, 1, 1, width).setValues([full]);
  return row;
}

function deleteWhere(ss, name, test) {
  const sh = ss.getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return;
  const rows = rowsOf(ss, name);
  for (let i = rows.length - 1; i >= 0; i--) if (test(rows[i])) sh.deleteRow(i + 2);
}

// records are JSON, split over as many cells as needed; "~" keeps the sheet from reading a piece as a number or formula
function pack(obj) {
  const s = JSON.stringify(obj), out = [];
  for (let i = 0; i < s.length; i += CHUNK) out.push('~' + s.slice(i, i + CHUNK));
  return out;
}

function unpack(cells) {
  const s = cells.map(String).filter(x => x).map(x => (x.charAt(0) === '~' ? x.slice(1) : x)).join('');
  try { return JSON.parse(s || '{}'); } catch (err) { return {}; }
}

/* ===================================================================== small helpers */

// text that starts like a formula is stored as plain text
function safe(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }

function prop(k) {
  const v = PropertiesService.getScriptProperties().getProperty(k);
  return v === null || v === undefined ? '' : String(v).trim();
}

function digest(s) { return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s || '')); }

function hex(bytes) { return bytes.map(b => ((b < 0 ? b + 256 : b) + 0x100).toString(16).slice(1)).join(''); }

function json(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
