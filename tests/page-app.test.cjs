/* Browser checks for the page the app runs ('medical bills.html'): accounts, saved data,
 * reading photo / PDF / Excel bills, the photo editor (frame on the bill's corners, turn),
 * the upload options and photo editor on a small phone screen, stock in and out, expired batches,
 * duplicates and their clean-up, edits, deletes, starting fresh, reports, export, the second look at
 * a hard photo with the note after saving, and two open tabs.
 * Run: node tests/page-app.test.cjs
 * Needs Playwright with Chromium (or PLAYWRIGHT_PACKAGE) and internet access for the page's
 * CDN libraries. Offline: set RXPX_CDN_DIR to a node_modules folder holding lucide@0.469.0,
 * chart.js@4.5.0, tesseract.js@5.1.1, tesseract.js-core@5, @tesseract.js-data/eng,
 * pdfjs-dist@3.11.174 and SheetJS 0.20.3 (as xlsx).
 * Bills are rendered in memory; no images, PDFs or workbooks are written to disk.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_PACKAGE, 'playwright', 'playwright-core'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch (_) {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PACKAGE to its installed package directory.');
let XLSX = null;
try { XLSX = require('xlsx'); } catch (_) {}

const root = path.resolve(__dirname, '..');
const CDN_DIR = process.env.RXPX_CDN_DIR;
const CDN = [
  [/^https:\/\/cdn\.jsdelivr\.net\/npm\/(lucide@[^/]+|chart\.js@[^/]+|tesseract\.js@[^/]+|tesseract\.js-core@[^/]+|@tesseract\.js-data\/eng)\/(.*)$/, (m) => path.join(m[1].replace(/@v?[\d.]+$/, ''), m[2])],
  [/^https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/pdf\.js\/[^/]+\/(.*)$/, (m) => path.join('pdfjs-dist', 'build', m[1])],
  [/^https:\/\/cdn\.sheetjs\.com\/xlsx-[^/]+\/package\/(.*)$/, (m) => path.join('xlsx', m[1])],
];

const css = 'body{margin:0;background:#fff;color:#111;font:20px Arial,sans-serif}.w{width:1100px;padding:36px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #333;padding:6px 8px}th{text-align:left}.r{text-align:right}';
const bill = body => `<html><head><style>${css}</style></head><body><div class="w">${body}</div></body></html>`;
const table = (head, rows, rightFrom) => `<table><tr>${head.map((h, i) => `<th class="${i >= rightFrom ? 'r' : ''}">${h}</th>`).join('')}</tr>${rows.map(r => `<tr>${r.map((c, i) => `<td class="${i >= rightFrom ? 'r' : ''}">${c}</td>`).join('')}</tr>`).join('')}</table>`;
const BILLS = {
  purchase: bill(`<h2 style="text-align:center">LAKSHMI MEDICAL AGENCIES</h2><div style="text-align:center">Pharma Distributors · GSTIN 37AAKFL5521M1ZQ</div><b>GST INVOICE</b>
<div>Bill To: RxPx Hospitals &nbsp;&nbsp; Invoice No: LMA-4471 &nbsp;&nbsp; Invoice Date: 14-10-2026</div>
${table(['S.No', 'Product Name', 'Pack', 'Batch', 'Exp', 'Qty', 'Free', 'MRP', 'Rate', 'GST%', 'Amount'], [
    ['1', 'DOLO 650 TAB', '15\'S', 'DL6243', '08/28', '20', '2', '33.60', '24.10', '12', '482.00'],
    ['2', 'PAN 40 TAB', '15\'S', 'P40X921', '11/27', '15', '1', '155.00', '110.40', '12', '1656.00'],
    ['3', 'MONTEK LC TAB', '10\'S', 'MLC5502', '07/27', '10', '0', '210.00', '150.00', '12', '1500.00'],
  ], 5)}<div class="r">Taxable Value: 3638.00</div><div class="r">CGST 6%: 218.28 &nbsp; SGST 6%: 218.28</div><div class="r"><b>Net Amount: 4074.56</b></div>`),
  purchaseMono: bill(`<h2 style="text-align:center">SRI SAI PHARMA DISTRIBUTORS</h2><div style="text-align:center">GSTIN 37ABCDE1234F1Z5</div><b>TAX INVOICE</b>
<div>Invoice No: SSP/1182 &nbsp;&nbsp;&nbsp; Date: 21/10/2026</div>
<pre style="font:22px 'Courier New',monospace">Sl Product                Batch   Exp    Qty   MRP     Amount
1  PARACETAMOL 500MG TAB  PCM2611 09/27  10    25.00   185.00
2  CETIRIZINE 10MG TAB    CTZ2201 03/27  5     18.00    65.00
                                  Sub Total      250.00
                                  CGST 6%         15.00
                                  SGST 6%         15.00
                                  Grand Total    280.00</pre>`),
  sale: bill(`<h2 style="text-align:center">RxPx HOSPITALS PHARMACY</h2><b>CASH BILL</b><div>Bill No: PH/2026/3391 &nbsp;&nbsp; Date: 22/10/2026</div>
<div>Patient Name: Ramesh Kumar &nbsp;&nbsp; UHID: RX10442 &nbsp;&nbsp; Dr. Suresh Babu</div>
${table(['Sl', 'Medicine', 'Batch', 'Exp', 'Qty', 'MRP', 'Amount'], [
    ['1', 'DOLO 650 TAB', 'DL6243', '08/28', '10', '33.60', '22.40'],
    ['2', 'PAN 40 TAB', 'P40X921', '11/27', '15', '155.00', '155.00'],
  ], 4)}<div class="r"><b>Total: 177.40</b></div><div>Payment Mode: UPI</div>`),
  lab: bill(`<h2>RxPx HOSPITALS - DIAGNOSTIC LABORATORY</h2><div>Receipt No: LAB/7781 &nbsp;&nbsp; Date: 20/10/2026</div><div>Patient Name: Arun Prasad &nbsp; Age/Sex: 42/M</div>
${table(['Test Name', 'Amount'], [['Complete Blood Count (CBC)', '350.00'], ['Lipid Profile', '600.00']], 1)}<div class="r"><b>Total Amount: 950.00</b></div>`),
};

function serve() {
  const server = http.createServer((req, res) => {
    const name = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'medical bills.html';
    if (name !== 'medical bills.html' && name !== 'index.html') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(fs.readFileSync(path.join(root, 'medical bills.html')));
  });
  return new Promise(done => server.listen(0, '127.0.0.1', () => done(server)));
}
async function routeCdn(context) {
  if (!CDN_DIR) return;
  await context.route(/^https:\/\/(cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|cdn\.sheetjs\.com|fonts\.googleapis\.com|fonts\.gstatic\.com)\//, route => {
    const url = route.request().url();
    if (/fonts\.g/.test(url)) return route.fulfill({ status: 200, contentType: 'text/css', body: '' });
    for (const [re, to] of CDN) {
      const m = url.match(re);
      if (!m) continue;
      const file = path.join(CDN_DIR, to(m));
      if (fs.existsSync(file)) return route.fulfill({ status: 200, body: fs.readFileSync(file), contentType: file.endsWith('.js') ? 'text/javascript' : 'application/octet-stream', headers: { 'access-control-allow-origin': '*' } });
    }
    return route.abort();
  });
}

(async () => {
  const server = await serve();
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await playwright.chromium.launch();
  let passed = 0;
  const ok = (cond, msg) => { assert.ok(cond, msg); passed++; console.log('  ✓', msg); };
  try {
    const render = async (html, pdf) => {
      const p = await browser.newPage({ viewport: { width: 1180, height: 900 } });
      await p.setContent(html);
      const buffer = pdf ? await p.pdf({ format: 'A4', printBackground: true }) : await p.screenshot({ fullPage: true });
      await p.close();
      return buffer;
    };
    const files = {};
    for (const [k, h] of Object.entries(BILLS)) files[k] = await render(h);
    files.labPdf = await render(BILLS.lab, true);

    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, acceptDownloads: true });
    await routeCdn(context);
    // data and session left by the earlier version of the page
    await context.addInitScript(() => {
      if (localStorage.getItem('__seeded')) return;
      localStorage.setItem('__seeded', '1');
      localStorage.setItem('rxpx-session-v1', JSON.stringify({ name: 'Old User', email: 'old@rxpx.test', admin: true }));
      localStorage.setItem('hospital-bills-preview-v1', JSON.stringify({ bills: [{ id: 'legacy-1', type: 'medicine_purchase', bill_number: 'OLD-9', bill_date: '2026-09-01', party: 'Old Supplier', total: 500, tax: 0, disc: 0, notes: 'x'.repeat(4000), items: [{ description: 'AMLODIPINE 5MG TAB', batch_no: 'AML1', expiry_date: '2027-06-30', quantity: 10, amount: 400 }], file: null, by: 'Old', at: '2026-09-01T10:00:00.000Z', warnings: [] }], meds: [{ id: 'm-old', name: 'AMLODIPINE 5MG TAB', key: 'AMLODIPINE 5MG TAB', batch: 'AML1', qty: 10, expiry: '2027-06-30' }], lastUpload: null }));
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await page.goto(url);
    await page.waitForFunction(() => typeof S !== 'undefined' && (S.view !== 'login' || document.querySelector('#app').innerText.length > 20));
    const S = expr => page.evaluate(new Function('return (' + expr + ')'));
    const text = () => page.evaluate(() => document.querySelector('#app').innerText);
    const idle = async () => { for (let i = 0; i < 600; i++) { const v = await S('({v:S.view,bad:S.bad,busy:S.busy})'); if ((v.v !== 'proc' || v.bad) && !v.busy) return v; await page.waitForTimeout(250); } throw new Error('reading did not finish'); };
    const upload = async (party, input, name, mimeType, buffer, type) => {
      await page.evaluate(p => { A.newbill(); S.flow = 'newName'; S.partyName = p; go('upload'); }, party);
      await page.setInputFiles(input, { name, mimeType, buffer });
      if (mimeType.startsWith('image/')) await page.waitForSelector('#crop .ch', { timeout: 20000 });
      await page.click('[data-a="submit"]');
      const v = await idle();
      if (v.v === 'kind') { await page.click(`[data-a="pickType"][data-t="${type}"]`); await page.click('[data-a="saveKind"]'); await page.waitForFunction(() => !S.busy && S.view !== 'kind'); }
    };
    const typed = async (party, fields) => {
      await page.evaluate(([p, f]) => { S.file = null; S.partyName = p; A.manual(); Object.assign(S.edit, f); return A.saveEdit(); }, [party, fields]);
      await page.waitForFunction(() => !S.busy);
    };

    console.log('Saved data');
    ok(await S('DATA.idb') && await S('S.bills.length') === 1, 'earlier data moved into IndexedDB');
    ok(await page.evaluate(() => localStorage.getItem('hospital-bills-preview-v1')) === null, 'browser-storage copy removed');
    ok(!(await S('"notes" in S.bills[0]')), 'unused OCR text no longer kept');
    await page.evaluate(() => { S.detail = 'legacy-1'; A.edit(); S.edit.bill_number = 'OLD-9A'; return A.saveEdit(); });
    ok(await S('S.meds.find(m=>m.id=="m-old").qty') === 10, 'editing a bill without stock history does not add its stock again');

    console.log('Accounts');
    const auth = async (mode, fields) => {
      await page.evaluate(() => A.out());
      await page.click(`[data-a="mode"][data-m="${mode}"]`);
      for (const [k, v] of Object.entries(fields)) await page.fill(`[data-k="auth.${k}"]`, v);
      await page.click('[data-a="auth"]');
      await page.waitForFunction(() => !S.busy);
    };
    await auth('up', { name: 'Kumar Staff', email: 'staff@rxpx.test', pw: 'secret123', pw2: 'secret123' });
    ok(await S('S.user && S.user.name') === 'Kumar Staff', 'create account');
    ok(!(await page.evaluate(() => localStorage.getItem('rxpx-accounts-v1'))).includes('secret123'), 'password kept only as a hash');
    await auth('in', { email: 'staff@rxpx.test', pw: 'wrong-pass' });
    ok(!(await S('S.user')) && /Wrong password/.test(await text()), 'wrong password refused');
    await auth('in', { email: 'nobody@rxpx.test', pw: 'secret123' });
    ok(/No account/.test(await text()), 'unknown email refused');
    await auth('up', { name: 'Other', email: 'staff@rxpx.test', pw: 'another1', pw2: 'another1' });
    ok(/already exists/.test(await text()), 'existing email cannot be registered again');
    await auth('in', { email: 'Staff@RxPx.test', pw: 'secret123' });
    ok(await S('S.user && S.user.name') === 'Kumar Staff', 'sign in keeps the registered name');

    console.log('Reading bills and stock');
    await upload('Sri Sai Pharma', '#f2', 'invoice.png', 'image/png', files.purchaseMono, 'medicine_purchase');
    ok(await S('S.meds.some(m=>m.name=="PARACETAMOL 500MG TAB"&&m.batch=="PCM2611")'), 'medicine form and strength stay in the name, not the batch');
    await upload('Lakshmi Medical Agencies', '#f2', 'gst.png', 'image/png', files.purchase, 'medicine_purchase');
    ok(await S('S.meds.find(m=>m.batch=="DL6243").qty') === 22, 'purchase adds 20 + 2 free strips');
    await page.evaluate(() => { S.mform = { name: 'DOLO 650 TAB', batch: 'OLDX1', qty: '5', manufacture_date: '2023-01-01', expiry: '2024-01-31', supplier: 'Old' }; return A.savemed(); });
    await typed('Walk-in', { type: 'pharmacy_sales', bill_number: 'PH-1', total: '33.60', items: [{ description: 'DOLO 650', quantity: 1, mrp: '33.60', amount: '33.60' }] });
    ok(await S('S.meds.find(m=>m.batch=="OLDX1").qty') === 5 && await S('S.meds.find(m=>m.batch=="DL6243").qty') === 21, 'sale uses the unexpired batch and matches "DOLO 650" to "DOLO 650 TAB"');
    await upload('Ramesh Kumar', '#f2', 'sale.png', 'image/png', files.sale, 'pharmacy_sales');
    ok(!(await S('S.lastUpload.shortage')) && Math.abs(await S('S.meds.find(m=>m.batch=="DL6243").qty') - 20.333) < 0.01, 'pharmacy sale photo takes 10 tablets (2/3 strip) from stock');
    await upload('Arun Prasad', '#f3', 'lab.pdf', 'application/pdf', files.labPdf, 'lab');
    ok(await S('S.bills[0].type') === 'lab' && await S('S.bills[0].total') === 950, 'lab bill PDF read');

    console.log('Photo editor');
    // a lab bill photographed on a dark table, a little turned and tilted
    const shot = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    await shot.setContent(`<html><head><style>${css}</style></head><body style="margin:0;background:#4a3a2c;width:900px;height:1200px;overflow:hidden"><div style="position:absolute;left:50%;top:48%;perspective:1600px"><div id="w" style="position:absolute;width:760px;left:-380px;top:-330px;background:#fff;transform:rotateX(9deg) rotateZ(-4deg);box-shadow:0 12px 30px rgba(0,0,0,.5)"><div style="padding:28px"><h2 style="margin:0 0 10px">RxPx HOSPITALS - LABORATORY</h2><div>Receipt No: LAB/7790 &nbsp;&nbsp; Date: 21/10/2026</div><div>Patient Name: Meena Kumari &nbsp; Age/Sex: 35/F</div>
${table(['Test Name', 'Amount'], [['Thyroid Profile (T3 T4 TSH)', '550.00'], ['Vitamin D3 Total', '1200.00'], ['Serum Calcium', '250.00']], 1)}<div class="r"><b>Total Amount: 2000.00</b></div><div>Paid by Cash. Thank you.</div></div>
${['left:0;top:0', 'right:0;top:0', 'right:0;bottom:0', 'left:0;bottom:0'].map(p => `<i class="m" style="position:absolute;width:1px;height:1px;${p}"></i>`).join('')}</div></div></body></html>`);
    const corners = await shot.evaluate(() => [...document.querySelectorAll('.m')].map(m => { const r = m.getBoundingClientRect(); return [r.left / 900, r.top / 1200] }));
    const tablePhoto = await shot.screenshot({ type: 'jpeg', quality: 85 });
    await shot.close();
    await page.evaluate(() => { A.newbill(); S.flow = 'newName'; S.partyName = 'Meena Kumari'; go('upload'); });
    await page.setInputFiles('#f2', { name: 'lab-photo.jpg', mimeType: 'image/jpeg', buffer: tablePhoto });
    await page.waitForSelector('#crop .ch', { timeout: 20000 });
    const auto = await S('S.file.quad');
    ok(auto.every((p, i) => Math.hypot(p[0] - corners[i][0], p[1] - corners[i][1]) < 0.02), 'the frame is put on the bill\'s corners by itself');
    const handle = await (await page.$('#crop .ch[data-h="0"]')).boundingBox(), box = await (await page.$('#crop')).boundingBox();
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 + 24, handle.y + handle.height / 2 + 30, { steps: 5 });
    ok(await page.$eval('#loupe', l => !l.hidden), 'a magnified view shows while a corner is dragged');
    await page.mouse.up();
    const moved = await S('S.file.quad[0]');
    ok(Math.abs((moved[0] - auto[0][0]) * box.width - 24) < 3 && Math.abs((moved[1] - auto[0][1]) * box.height - 30) < 3, 'a dragged corner follows the finger');
    await page.click('[data-a="turn"][data-d="1"]');
    const turnedView = await S('({rot:S.file.rot,w:EDIT.view.width,h:EDIT.view.height,q:S.file.quad})');
    ok(turnedView.rot === 1 && turnedView.w > turnedView.h && Math.abs(turnedView.q[1][0] - (1 - moved[1])) < 0.002, 'Turn right turns the photo and its frame');
    await page.click('[data-a="turn"][data-d="-1"]');
    await page.click('[data-a="cropAll"]');
    ok(await S('BillCrop.isFull(S.file.quad)'), 'Whole photo uses the whole picture');
    await page.click('[data-a="cropFit"]');
    ok(await S('sameQuad(S.file.quad,S.file.auto)'), 'Fit to bill puts the frame back on the bill');
    await page.evaluate(() => { S.file.touched = 0; });
    const still = await (await page.$('#crop .ch[data-h="2"]')).boundingBox();
    await page.mouse.move(still.x + still.width / 2, still.y + still.height / 2); await page.mouse.down(); await page.mouse.up();
    ok(!(await S('S.file.touched')), 'tapping a corner without moving it leaves the frame as it was found');
    await page.click('[data-a="submit"]');
    let v = await idle();
    if (v.v === 'kind') { await page.click('[data-a="pickType"][data-t="lab"]'); await page.click('[data-a="saveKind"]'); await page.waitForFunction(() => !S.busy && S.view !== 'kind'); }
    const lab2 = await S('({no:S.bills[0].bill_number,total:S.bills[0].total,items:S.bills[0].items.map(i=>i.description+"="+i.amount)})');
    ok(lab2.no === 'LAB/7790' && lab2.total === 2000 && lab2.items.length === 3, 'the framed photo is read: ' + JSON.stringify(lab2));
    await page.waitForFunction(() => S.bills[0].file && S.bills[0].file.stored, null, { timeout: 15000 });
    const kept = await page.evaluate(async () => { const b = await IDB.get(S.bills[0].id); const i = await createImageBitmap(b); return i.width / i.height; });
    const billRatio = Math.hypot((corners[1][0] - corners[0][0]) * 900, (corners[1][1] - corners[0][1]) * 1200) / Math.hypot((corners[3][0] - corners[0][0]) * 900, (corners[3][1] - corners[0][1]) * 1200);
    ok(Math.abs(kept - billRatio) / billRatio < 0.06, 'the saved copy is the flattened bill, not the whole photo');

    // a long receipt gets a taller editor, so its corners are not crowded together
    const tallShot = await browser.newPage({ viewport: { width: 420, height: 1500 } });
    await tallShot.setContent(`<html><body style="margin:0;background:#fff;font:22px monospace"><pre style="margin:20px">${Array.from({ length: 40 }, (_, i) => `ITEM ${i + 1}      1    10.00`).join('\n')}</pre></body></html>`);
    const receipt = await tallShot.screenshot({ type: 'png' });
    await tallShot.close();
    await page.evaluate(() => { A.newbill(); S.flow = 'newName'; S.partyName = 'Long receipt'; go('upload'); });
    await page.setInputFiles('#f2', { name: 'receipt.png', mimeType: 'image/png', buffer: receipt });
    await page.waitForSelector('#crop .ch', { timeout: 20000 });
    const tallBox = await (await page.$('#crop')).boundingBox(), tallBar = await page.$eval('.bar', b => b.getBoundingClientRect().top);
    ok(tallBox.y + tallBox.height <= tallBar + 1 && tallBox.y + tallBox.height >= tallBar - 30, 'a long receipt uses all the height above the Submit bar (' + Math.round(tallBox.height) + ' px)');
    await page.click('[data-a="rmfile"]');
    ok(await S('!S.file && !EDIT.img'), 'removing the photo lets go of it');
    // a photo that cannot be read sends the person back to the frame, even after the photo was let go
    const blankShot = await browser.newPage({ viewport: { width: 600, height: 800 } });
    await blankShot.setContent('<body style="margin:0;background:#fff"></body>');
    const blank = await blankShot.screenshot({ type: 'png' });
    await blankShot.close();
    await page.evaluate(() => { A.newbill(); S.flow = 'newName'; S.partyName = 'Blank page'; go('upload'); });
    await page.setInputFiles('#f2', { name: 'blank.png', mimeType: 'image/png', buffer: blank });
    await page.waitForSelector('#crop .ch', { timeout: 20000 });
    await page.click('[data-a="submit"]');
    await idle();
    ok(!!(await page.$('[data-a="reframe"]')) && !(await S('S.bills.some(b=>b.party=="Blank page")')), 'a photo that cannot be read is not saved and offers Fix the frame');
    await page.evaluate(() => editorRelease());
    await page.click('[data-a="reframe"]');
    await page.waitForSelector('#crop .ch', { timeout: 20000 });
    ok(await S('S.view') === 'upload' && await S('!!EDIT.img'), 'Fix the frame goes back to the photo editor and opens the photo again');
    await page.click('[data-a="rmfile"]');

    console.log('Small phone screen');
    await page.setViewportSize({ width: 360, height: 640 });
    await page.evaluate(() => { A.newbill(); S.flow = 'newName'; S.partyName = 'Small screen'; go('upload'); scrollTo(0, 0); });
    const picks = await page.evaluate(() => ({ bar: !!document.querySelector('.bar'), bottoms: [...document.querySelectorAll('label.tile')].map(l => l.getBoundingClientRect().bottom) }));
    ok(!picks.bar && picks.bottoms.length === 4 && picks.bottoms.every(b => b <= 640), 'the four upload options fit a 360 x 640 screen, with no Submit bar over them');
    // headless Chromium opens no picker here, like the in-app viewers that cannot reach the camera
    await page.tap('label[for="f2"]');
    const told = await page.waitForFunction(() => blocked(), null, { timeout: 5000 }).then(() => true, () => false);
    ok(told && /can't open on this screen/.test(await text()) && await page.$$eval('.blocked .stack [data-a]', bs => bs.length === 2 && bs.every(b => b.getBoundingClientRect().top >= 0 && b.getBoundingClientRect().bottom <= 640)), 'a tap that opens nothing says, in plain words, that the camera and files cannot open here, with both ways on in view on a 360 x 640 screen');
    const blockedUi = await page.evaluate(() => ({ typed: !!document.querySelector('.blocked [data-a="manual"]'), copy: !!document.querySelector('.blocked [data-a="copylink"]'), link: document.querySelector('.blocked .lk').innerText, here: location.href, kept: !!localStorage.getItem('rxpx-nopick-v1') }));
    ok(blockedUi.typed && blockedUi.copy && blockedUi.link === blockedUi.here && blockedUi.kept, 'it offers Type the details myself and Copy link for Chrome, shows the link, and remembers it');
    await page.evaluate(() => { window.__copied = null; Object.defineProperty(navigator, 'clipboard', { value: { writeText: async t => { window.__copied = t; } }, configurable: true }); });
    await page.tap('[data-a="copylink"]');
    ok(await page.evaluate(() => window.__copied === location.href) && /Link copied/.test(await page.$eval('#toast', e => e.innerText)), 'Copy link puts the page address on the clipboard');
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => { throw new Error('blocked'); } }, configurable: true }); });
    await page.tap('[data-a="copylink"]');
    ok(await page.$eval('#toast', e => /copied|hold/i.test(e.innerText)), 'Copy link still answers when the clipboard is blocked');
    await page.evaluate(() => { Object.defineProperty(navigator, 'userAgent', { get: () => 'Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230901.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36', configurable: true }); });
    ok(/Android app view/.test(await page.evaluate(() => pickInfo())), 'the details line says when this is an Android app view');
    await page.evaluate(() => { S.nopick = 0; render(); });
    ok(!!(await page.$('.blocked')), 'the explanation is there when the upload screen opens again, before any button is tapped');
    await page.tap('.blocked [data-a="manual"]');
    ok(await S('S.view') === 'edit' && await S('S.edit.isNew && S.edit.party') === 'Small screen', 'Type the details myself opens the bill form with the name filled in');
    await page.tap('[data-a="cancelEdit"]');
    ok(await S('S.view') === 'upload' && !!(await page.$('.typein [data-a="manual"]')), 'Back returns to the upload screen, where No bill photo? Type the details myself sits under the options');
    // a photo chosen while the screen was redrawn behind the open picker still arrives
    const chooserOpened = page.waitForEvent('filechooser');
    await page.tap('label[for="f2"]');
    const chooser = await chooserOpened;
    await page.evaluate(() => render());
    await chooser.setFiles({ name: 'lab-photo.jpg', mimeType: 'image/jpeg', buffer: tablePhoto });
    ok(await page.waitForSelector('#crop .ch', { timeout: 20000 }).then(() => true, () => false), 'a photo chosen after the screen was redrawn behind the picker still arrives');
    ok(await page.evaluate(() => localStorage.getItem('rxpx-nopick-v1') === null && !blocked()), 'choosing a photo shows the pickers work here, so the explanation is gone');
    await page.evaluate(() => scrollTo(0, 0));
    await page.waitForTimeout(400); // measure after any entrance animation has finished
    const small = await page.evaluate(() => ({ msg: S.msg, bar: document.querySelector('.bar').getBoundingClientRect().top, tools: [...document.querySelectorAll('.ctools .btn')].map(b => [b.getBoundingClientRect().top, b.getBoundingClientRect().bottom]), photo: document.querySelector('#crop').getBoundingClientRect() }));
    ok(!small.msg && small.tools.length === 4 && small.tools.every(([t, b]) => t >= 0 && b <= small.bar), 'Turn left, Turn right, Fit to bill and Whole photo are all above the Submit bar');
    ok(small.photo.top >= 0 && small.photo.bottom <= small.bar + 1, 'the whole photo and its frame fit above the Submit bar');
    // a tap that redraws the same screen does not replay its entrance fade (the screen used to blink)
    await page.waitForTimeout(400);
    await page.tap('[data-a="turn"][data-d="1"]');
    const shown = await page.evaluate(() => +getComputedStyle(document.querySelector('.flow')).opacity);
    await page.tap('[data-a="turn"][data-d="-1"]');
    ok(shown > 0.95, 'tapping Turn right does not make the screen blink');
    await page.click('[data-a="rmfile"]');
    await page.setViewportSize({ width: 390, height: 844 });

    console.log('Dashboard');
    await page.evaluate(() => go('home'));
    const due = await S('S.meds.filter(m=>st(m)!="good"&&m.qty>0).length');
    await page.click('.dt[data-a="medgo"]');
    ok(due > 0 && await S('S.mf') === 'due' && await page.$$eval('#ml .card', c => c.length) === due, 'the "Expiring or expired" number opens exactly those medicines');

    console.log('Duplicates, edits, deletes');
    await upload('Sri Sai Pharma', '#f2', 'invoice.png', 'image/png', files.purchaseMono, 'medicine_purchase');
    ok(!!(await S('S.dup')), 'same photo again is blocked');
    const n = await S('S.bills.length');
    await typed('Another Supplier', { type: 'expense', bill_number: 'SSP/1182', bill_date: '2026-10-21', total: '750', items: [{ description: 'Printer cartridge', quantity: 1, amount: '750' }] });
    ok(await S('S.bills.length') === n + 1, 'same bill number from another supplier is saved');
    const pid = await S('S.bills.find(b=>b.bill_number=="LMA-4471").id');
    await page.evaluate(id => { S.detail = id; A.edit(); S.edit.items.find(i => i.description == 'MONTEK LC TAB').quantity = '12'; return A.saveEdit(); }, pid);
    ok(await S('S.meds.find(m=>m.name=="MONTEK LC TAB").qty') === 12, 'purchase bill can be corrected after some of its stock was sold');
    await page.evaluate(id => { S.detail = id; A.edit(); const i = S.edit.items.find(x => x.description == 'DOLO 650 TAB'); i.quantity = '0'; i.free = '0'; return A.saveEdit(); }, pid);
    ok(/Cannot reduce DOLO 650 TAB/.test(await S('S.msg')), 'but it cannot take back stock that was already sold');
    await page.evaluate(() => A.cancelEdit());
    const labId = await S('S.bills.find(b=>b.type=="lab").id');
    await page.evaluate(id => { S.detail = id; return A.del(); }, labId);
    ok(!(await S(`S.bills.some(b=>b.id=="${labId}")`)), 'bill deleted');

    console.log('Reports and export');
    await page.evaluate(() => { S.rep = 'all'; go('reports'); });
    const rep = await text();
    ok(/Revenue \(\d+ bills?\)/.test(rep) && /Expenses \(\d+ bills?\)/.test(rep), 'All bills keeps revenue and expenses apart');
    const download = page.waitForEvent('download');
    await page.click('[data-a="export"]');
    const file = await (await download).path();
    if (XLSX) {
      const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(file)).Sheets['All bills']);
      ok(rows.some(r => /^Total revenue/.test(r.Name)) && rows.some(r => /^Total expenses/.test(r.Name)), 'Excel has separate revenue and expense totals');
    } else console.log('  - Excel content check skipped (install xlsx to run it)');
    await page.evaluate(() => { S.bills[0].party = '=HYPERLINK("http://x","y")'; });
    const csvDownload = page.waitForEvent('download');
    await page.evaluate(() => { const x = window.XLSX; window.XLSX = undefined; try { exportReport(); } finally { window.XLSX = x; } });
    ok(fs.readFileSync(await (await csvDownload).path(), 'utf8').includes(`"'=HYPERLINK(`), 'CSV export does not create formulas');

    console.log('Copies and starting fresh');
    // a copy of a saved bill, as an earlier version let through (the check is bypassed on purpose)
    const doloQty = () => S('S.meds.find(m=>m.batch=="DL6243").qty');
    const was = { bills: await S('S.bills.length'), dolo: await doloQty() };
    ok(!(await S('dupGroups().length')), 'the saved bills so far hold no copies');
    await page.evaluate(() => { const c = JSON.parse(JSON.stringify(S.bills.find(b => b.bill_number == 'LMA-4471'))); c.id = uid(); c.at = new Date(Date.now() + 5000).toISOString(); c.file = null; c.stock_movements = stock(c).movements; S.bills.unshift(c); return persist(); });
    ok(await doloQty() > was.dolo && await S('S.bills.length') === was.bills + 1, 'set up: a copy of a purchase bill, its stock counted twice');
    const mine = await S('billKey(S.bills.find(b=>b.bill_number=="LMA-4471"))');
    ok(await page.evaluate(k => sameBill({ ...k, no: '', n: 0, hash: 'other' }, k), mine), 'a photo where the bill number and the items could not be read is still seen as a copy');
    ok(await page.evaluate(k => !sameBill({ ...k, no: 'LMA9999', hash: 'other' }, k) && !sameBill({ ...k, no: '', date: '2026-01-02', hash: 'other' }, k), mine), 'another bill number, or another date, is another bill');
    await page.evaluate(() => go('home'));
    ok(/1 bill looks like a copy/.test(await text()), 'the dashboard says one bill looks like a copy');
    await page.click('[data-a="copies"]');
    ok(/Remove 1 copy\?/.test(await text()) && await S('S.view') === 'profile', 'tapping it opens Profile and asks before removing');
    await page.click('[data-a="noask"]');
    ok(await S('S.bills.length') === was.bills + 1, 'Keep leaves the copy');
    await page.click('[data-a="copies"]');
    await page.click('[data-a="dedupe"]');
    await page.waitForFunction(() => !S.busy && !dupGroups().length);
    ok(await S('S.bills.length') === was.bills && await doloQty() === was.dolo, 'removing the copy puts its stock back');
    ok(/No copies found/.test(await text()) && /updated 29 Oct 2026/.test(await text()), 'Profile says no copies are left, and which version of the app is open');
    // the "Bill saved" note belongs to the moment of saving, not to every later sign-in
    await typed('Tea Stall', { type: 'expense', bill_number: 'N-1', total: '10', items: [{ description: 'Tea', quantity: 1, amount: '10' }] });
    ok(!!(await S('S.lastUpload')), 'a saved bill leaves the Bill saved note');
    await auth('in', { email: 'staff@rxpx.test', pw: 'secret123' });
    ok(!(await S('S.lastUpload')) && !(await page.$('.saved')) && await S('S.bills.length') === was.bills + 1, 'it is gone at the next sign-in, and the bills stay');
    await page.evaluate(() => go('profile'));
    await page.click('[data-a="askwipe"]');
    ok(/Delete everything\?/.test(await text()), 'Delete everything asks first');
    await page.click('[data-a="noask"]');
    ok(await S('S.bills.length') === was.bills + 1, 'Keep leaves the bills');
    await page.click('[data-a="askwipe"]');
    await page.click('[data-a="wipe"]');
    await page.waitForFunction(() => !S.busy && !S.bills.length && S.view === 'home');
    const keys = await page.evaluate(async () => { const db = await IDB.open(); return new Promise(r => { const q = db.transaction('files').objectStore('files').getAllKeys(); q.onsuccess = () => r(q.result); }); });
    ok(!(await S('S.meds.length')) && keys.length === 1 && keys[0] === '__rxpx_data__', 'everything is deleted: bills, stock, saved photos and older copies');
    ok(/Add your first bill/.test(await text()) && !!(await S('S.user')), 'the dashboard asks for the first bill, and the account still works');

    console.log('A second look at a hard photo, and the note after saving');
    // the reader engine is swapped for what it read on a real phone photo of a GST invoice (tests/fixtures/page-ocr-photo-invoice.json)
    const invoice = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'page-ocr-photo-invoice.json'), 'utf8'));
    await page.evaluate(fx => {
      window.__realOcr = ocrCanvas; window.__mode = 'helps'; window.__calls = [];
      window.ocrCanvas = async (canvas, label) => {
        window.__calls.push({ h: canvas.height, label });
        const m = window.__mode, closer = /Looking closer/.test(label);
        const lines = m === 'complete' ? fx.docs.framed.lines : !closer ? fx.docs.whole_first.lines
          : m === 'helps' && /top of the bill/.test(label) ? fx.docs.top_strip.lines : [{ toks: [{ t: '~~', x0: 10, x1: 40, y0: 20, y1: 44, c: 30 }] }];
        return { conf: 82, lines: JSON.parse(JSON.stringify(lines)) };
      };
    }, invoice);
    const look = mode => page.evaluate(async m => {
      window.__mode = m; window.__calls = [];
      const prepare = BillImage.prepare;
      BillImage.prepare = () => { const c = document.createElement('canvas'); c.width = 3200; c.height = 1600; return c; };
      const src = document.createElement('canvas'); src.width = 800; src.height = 400;
      const id = S.run = 'look-' + m;
      try { const best = await readPhoto(src, id, {}); return { d: JSON.parse(JSON.stringify(best.d)), lines: best.r.lines.length, calls: window.__calls }; } finally { BillImage.prepare = prepare; S.run = 0; }
    }, mode);
    const helped = await look('helps');
    ok(helped.calls.length === 2 && /top of the bill/.test(helped.calls[1].label) && helped.calls[1].h === invoice.headY - 4, 'a read without the bill number and date reads the strip above the items again, once');
    ok(helped.d.bill_number === 'SD00518' && helped.d.bill_date === '2026-05-08' && helped.d.payment_mode === 'Credit' && helped.d.total_amount === 6163 && helped.d.items.length === 1 && !helped.d.warnings.length, 'and keeps the number, date and payment found there');
    const worse = await look('worse');
    ok(worse.calls.length === 2 && worse.d.bill_number === '' && worse.lines === invoice.docs.whole_first.lines.length && worse.d.total_amount === 6163, 'a second look that reads worse is not used');
    const complete = await look('complete');
    ok(complete.calls.length === 1 && complete.d.bill_number === 'SD00518', 'a complete first read is not read again');
    await page.evaluate(() => { window.__mode = 'helps'; });
    await upload('Sample Distributors', '#f2', 'invoice.png', 'image/png', files.purchase, 'medicine_purchase');
    const note = (await page.$eval('.saved', e => e.innerText)).replace(/\s+/g, ' ');
    ok(/Bill saved/.test(note) && note.includes('Added to expenses (May 2026): ₹6,163 · Stock added: 30 packs of SURBEX GOLD-CAP'), 'the note names the month the expense went to, and the packs that came in');
    ok(/SURBEX GOLD-CAP is past its expiry date \(Sept? 2026\)\./.test(note), 'and says the batch is already past its expiry date');
    await page.click('.saved [data-a="open"]');
    const billText = (await text()).replace(/\s+/g, ' ');
    ok(/SD00518/.test(billText) && /8 May 2026/.test(billText) && /Credit/.test(billText) && /₹293\.49/.test(billText) && /₹6,163/.test(billText), 'the bill shows its number, date, payment, tax and total as printed');
    ok(/25 packs \+ 5 free · batch SFL0013 · Exp Sept? 2026 Expired/.test(billText) && billText.includes('Pack 1X15 · MRP ₹308.17 · Rate ₹234.79 · GST 5%'), 'the item shows quantity, free packs, batch, expiry, pack, MRP, rate and GST');
    ok(await page.evaluate(() => reasonsOf(['no_date', 'no_number', 'no_expiry:2', 'no_qty:1'])) === 'Date and bill number not found · 2 medicines without an expiry date · 1 item without a quantity', 'a bill to check says why in words');
    ok(await page.evaluate(() => impactOf({ type: 'medicine_purchase', bill_date: thisMonth() + '-02', total: 120 }, { added: 1, removed: 0, movements: [{ direction: 'in', name: 'DOLO 650 TAB' }], shortage: [] })) === 'Added to expenses: ₹120 · Stock added: 1 pack of DOLO 650 TAB', 'a bill of this month needs no month name, and one pack is "1 pack"');
    await page.evaluate(() => { window.ocrCanvas = window.__realOcr; go('home'); });

    console.log('Two tabs');
    const second = await context.newPage();
    await second.goto(url);
    await second.waitForFunction(() => typeof S !== 'undefined' && S.user);
    const before = await second.evaluate(() => S.bills.length);
    await typed('Tab one', { type: 'expense', bill_number: 'T1', total: '100', items: [{ description: 'Diesel', quantity: 1, amount: '100' }] });
    await second.waitForFunction(n => S.bills.length === n + 1, before);
    await second.evaluate(() => { S.partyName = 'Tab two'; A.manual(); Object.assign(S.edit, { type: 'expense', bill_number: 'T2', total: '200', items: [{ description: 'Water', quantity: 1, amount: '200' }] }); return A.saveEdit(); });
    await page.reload();
    await page.waitForFunction(() => typeof S !== 'undefined' && S.user);
    const numbers = await S('S.bills.map(b=>b.bill_number)');
    ok(numbers.includes('T1') && numbers.includes('T2'), 'bills saved in two tabs are both kept');
    ok(!errors.length, 'no script errors' + (errors.length ? ': ' + errors.join('; ') : ''));
    console.log(`\n${passed} checks passed`);
  } finally {
    await browser.close();
    server.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
