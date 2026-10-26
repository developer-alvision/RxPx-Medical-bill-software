'use strict';
// The bill reader inside 'medical bills.html' (the page the app actually runs), checked on
// Tesseract output for six bill types, plus receipts with the print around their items and the
// corner maths of the photo editor. Run: node --test tests/page-reader.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'medical bills.html'), 'utf8');
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
const end = script.search(/if\s*\(typeof module\s*!==?\s*['"]undefined['"]\)\s*module\.exports\s*=\s*BillParser;/);
assert.ok(end > 0, 'the page keeps its bill reader in an exportable block');
const sandbox = { module: { exports: null } };
vm.runInNewContext(script.slice(0, end) + '\nmodule.exports = BillParser;', sandbox);
const BillParser = sandbox.module.exports;
const { bills } = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'page-ocr-bills.json'), 'utf8'));
// results are copied out of the sandbox so they compare like ordinary objects
const read = name => JSON.parse(JSON.stringify(BillParser.parse(bills[name], { hospitalKey: 'rxpx', today: '2026-10-25' })));

test('supplier invoice: full medicine names and clean batch numbers', () => {
  const d = read('purchase_mono');
  assert.equal(d.type, 'medicine_purchase');
  assert.equal(d.bill_number, 'SSP/1182');
  assert.equal(d.bill_date, '2026-10-21');
  assert.equal(d.total_amount, 1398.88);
  assert.deepEqual(d.items.map(i => [i.description, i.batch_no, i.expiry_date, i.quantity]), [
    ['PARACETAMOL 500MG TAB', 'PCM2611', '2027-09-30', 10],
    ['AMOXICILLIN 506MG CAP', 'AMX0425', '2027-03-31', 5], // "506" is how the photo was read
    ['PANTOPRAZOLE 406MG TAB', 'PAN3310', '2026-12-31', 8],
  ]);
});

test('GST invoice with pack, free quantity, rate and amount in words', () => {
  const d = read('purchase_table');
  assert.equal(d.type, 'medicine_purchase');
  assert.equal(d.total_amount, 5243.28);
  assert.equal(d.tax_amount, 561.78);
  assert.equal(d.items.length, 5);
  const dolo = d.items[0];
  assert.deepEqual([dolo.description, dolo.batch_no, dolo.quantity, dolo.free, dolo.pack_n, dolo.rate, dolo.amount], ['DOLO 650 TAB', 'DL6243', 20, 2, 15, 24.1, 482]);
});

test('pharmacy sale issued by the hospital', () => {
  const d = read('pharmacy_sale');
  assert.equal(d.type, 'pharmacy_sales');
  assert.equal(d.party_ref, 'RX10442');
  assert.equal(d.payment_mode, 'UPI');
  assert.equal(d.total_amount, 219.4);
  assert.deepEqual(d.items.map(i => [i.description, i.batch_no, i.quantity, i.amount]), [
    ['DOLO 650 TAB', 'DL6243', 10, 22.4], ['PAN 40 TAB', 'P40X921', 15, 155], ['CALPOL 250 SUSP', 'CS1187', 1, 42],
  ]);
});

test('in-patient bill, lab bill and an electrical repair bill', () => {
  const ip = read('patient_ip');
  assert.deepEqual([ip.type, ip.bill_number, ip.bill_date, ip.total_amount, ip.discount_amount, ip.items.length], ['patient', 'IP-26-0915', '2026-10-19', 9000, 550.5, 5]);
  const lab = read('lab');
  assert.deepEqual([lab.type, lab.bill_number, lab.total_amount, lab.items.length, lab.payment_mode], ['lab', 'LAB/7781', 1950, 4, 'Cash']);
  const ex = read('expense');
  assert.deepEqual([ex.type, ex.bill_number, ex.total_amount, ex.tax_amount, ex.items.length], ['expense', 'SKE-0332', 5605, 855, 3]);
});

// Word boxes like the reader's for a block of fixed-width text (one character = 12 px wide)
const mono = text => ({ source: 'ocr', lines: text.split('\n').filter(l => l.trim()).map((l, r) => ({ toks: [...l.matchAll(/\S+/g)].map(m => ({ t: m[0], x0: m.index * 12, x1: (m.index + m[0].length) * 12, y0: r * 30, y1: r * 30 + 22, c: 90 })) })) });
const readText = text => JSON.parse(JSON.stringify(BillParser.parse(mono(text), { hospitalKey: 'rxpx', today: '2026-10-25' })));

test('pharmacy receipt: batch and expiry lines join their item; counts, totals and greetings are not items', () => {
  const d = readText(`
      SRI LAKSHMI MEDICALS
  Opp. Govt Hospital, Main Road
  Ph: 08571-221133, 9440112233
    GSTIN: 37ABCPL7788M1Z9
Bill No : SLM/7741   Date: 23/1O/2026
Patient : K. Venkata Ramana
Item               Qty   MRP    Amount
DOLO 650 TAB        15   2.24    33.60
  B:DL6243  E:08/28
AZITHRAL 500 TAB     3  23.90    71.70
  B:AZ24117 E:05/27
PAN-D CAP           10  15.50   155.00
  B:PND4410 E:10/27
Items: 4             Qty: 28
Gross Amount                260.30
Discount (10%)               26.03
Net Amount                  234.27
Round Off                    -0.27
TOTAL                       234.00
You Saved Rs. 26.03
Paid: Cash 234.00   Balance: 0.00
Goods once sold cannot be taken back
      ** GET WELL SOON **`);
  assert.equal(d.bill_number, 'SLM/7741');
  assert.equal(d.bill_date, '2026-10-23'); // "1O" read for "10"
  assert.equal(d.total_amount, 234);
  assert.equal(d.discount_amount, 26.03);
  assert.deepEqual(d.items.map(i => [i.description, i.batch_no, i.expiry_date, i.quantity, i.amount]), [
    ['DOLO 650 TAB', 'DL6243', '2028-08-31', 15, 33.6],
    ['AZITHRAL 500 TAB', 'AZ24117', '2027-05-31', 3, 71.7],
    ['PAN-D CAP', 'PND4410', '2027-10-31', 10, 155],
  ]);
  assert.ok(!d.warnings.includes('sum_mismatch'), d.warnings.join());
});

test('receipt without a table heading: phone, timings and sample lines are left out', () => {
  const d = readText(`
CITY DIAGNOSTICS
Ph: 08571-229900    Lab timings: 7.00 AM to 9.00 PM
Receipt No: LB/4471    Date: 24/10/2026
Patient: Mrs. S. Padmavathi   Age: 56
Sample Collected      09.40
Complete Blood Picture        300.00
HbA1c                         450.00
Fasting Blood Sugar            80.00
Serum Creatinine              200.00
Gross Total                  1030.00
Discount (Sr. Citizen 10%)    103.00
Net Amount                    927.00
Thank you. Visit again`);
  assert.deepEqual([d.bill_number, d.bill_date, d.total_amount, d.discount_amount], ['LB/4471', '2026-10-24', 927, 103]);
  assert.deepEqual(d.items.map(i => [i.description, i.amount]), [['Complete Blood Picture', 300], ['HbA1c', 450], ['Fasting Blood Sugar', 80], ['Serum Creatinine', 200]]);
  assert.ok(!d.warnings.includes('sum_mismatch'), d.warnings.join());
});

test('shop bill: bare "No:" bill number, and a later line starting with "Total" is not the total', () => {
  const d = readText(`
SRI RAMA GENERAL STORES
Cell: 9989012345, 8885012345
No: 2817                       Date: 19-10-2026
M/s. RxPx Hospitals
S.No Particulars               Qty   Rate   Amount
1    Phenyl 5 Ltr Can           4  320.00  1280.00
2    Register Book 200 Pages   10   60.00   600.00
Total                                     1880.00
Total Bags Delivered 3
For SRI RAMA GENERAL STORES`);
  assert.equal(d.bill_number, '2817');
  assert.equal(d.bill_date, '2026-10-19');
  assert.equal(d.total_amount, 1880);
  assert.deepEqual(d.items.map(i => [i.description, i.quantity, i.amount]), [['Phenyl 5 Ltr Can', 4, 1280], ['Register Book 200 Pages', 10, 600]]);
});

test('a misread Total line is not an item; the amount in words picks the real items', () => {
  const tota1 = readText(`
S.No Particulars            Qty   Rate   Amount
1    Phenyl 5 Ltr Can         4  320.00  1280.00
2    Register Book           10   60.00   600.00
3    Ball Pens Blue           3   50.00   150.00
     Tota1                                2030.00`);
  assert.deepEqual([tota1.total_amount, tota1.items.length], [2030, 3]);
  const garbled = readText(`
S.No Particulars            Qty   Rate   Amount
1    Phenyl 5 Ltr Can         4  320.00  1280.00
2    Register Book           10   60.00   600.00
3    Ball Pens Blue           3   50.00   150.00
     Grnd Tot                             2030.00
Rupees Two Thousand Thirty Only`);
  assert.equal(garbled.total_amount, 2030);
  assert.deepEqual(garbled.items.map(i => i.description), ['Phenyl 5 Ltr Can', 'Register Book', 'Ball Pens Blue']);
});

test('bill corners: order, quarter turns and shape checks used by the photo editor', () => {
  const src = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).join('\n');
  const start = src.indexOf('const BillCrop = (() => {'), stop = src.indexOf('})();', start);
  assert.ok(start > 0 && stop > start, 'the page has the BillCrop block');
  const box = { module: { exports: null } };
  vm.runInNewContext(src.slice(start, stop + 5) + '\nmodule.exports = BillCrop;', box);
  const C = box.module.exports, plain = v => JSON.parse(JSON.stringify(v));
  const q = [[0.1, 0.2], [0.8, 0.15], [0.9, 0.85], [0.05, 0.9]];
  assert.deepEqual(plain(C.order([q[2], q[0], q[3], q[1]])), q, 'corners come back as top-left, top-right, bottom-right, bottom-left');
  const turned = C.turnQuad(q, 1);
  assert.deepEqual(plain(turned[0]).map(v => +v.toFixed(3)), [0.1, 0.05], 'turning right moves the bottom-left corner to the top-left');
  let back = q; for (let k = 0; k < 4; k++) back = C.turnQuad(back, 1);
  assert.deepEqual(plain(back).map(p => p.map(v => +v.toFixed(6))), q, 'four quarter turns come back to the start');
  assert.deepEqual(plain(C.turnQuad(C.turnQuad(q, 1), -1)).map(p => p.map(v => +v.toFixed(6))), q, 'right then left is no turn');
  assert.ok(C.valid(q) && C.valid(C.FULL()) && C.isFull(C.FULL()) && !C.isFull(q));
  assert.ok(!C.valid([[0.1, 0.2], [0.9, 0.85], [0.8, 0.15], [0.05, 0.9]]), 'a twisted frame is refused');
  assert.ok(!C.valid([[0.1, 0.1], [0.12, 0.1], [0.12, 0.12], [0.1, 0.12]]), 'a tiny frame is refused');
});

test('two amounts that lost their decimal points are put right by the bill total', () => {
  const d = readText(`
S.No Product               Qty   Amount
1    LIMCEE 500 CHEW TAB    25    46425
2    BECOSULES CAP          12    46548
3    ONDEM 4 TAB            15   558.15
Sub Total                       1487.88
Grand Total                     1487.88`);
  assert.deepEqual(d.items.map(i => [i.description, i.amount]), [['LIMCEE 500 CHEW TAB', 464.25], ['BECOSULES CAP', 465.48], ['ONDEM 4 TAB', 558.15]]);
  assert.ok(!d.warnings.includes('sum_mismatch'));
});

test('review fixes: "@ rate" rows, "After Discount" totals, GST in a total line, units after a number', () => {
  const at = readText(`
Sl Particulars                          Days   Amount
1  Room Rent @1500.00 per day              3   4500.00
2  Nursing Care @300.00 per day            3    900.00
3  Doctor Visit                            2   1000.00
Total                                          6400.00`);
  assert.deepEqual(at.items.map(i => i.amount), [4500, 900, 1000], '"@ 1500.00" is a rate, not an e-mail address');
  const after = readText(`
Sl Test Name                    Amount
1  Lipid Profile                650.00
2  Serum Creatinine             200.00
Gross Total                     850.00
Discount                         85.00
Net Amount After Discount       765.00`);
  assert.deepEqual([after.total_amount, after.discount_amount], [765, 85]);
  const gst = readText(`
Sl Product                Qty   Rate    Amount
1  DOLO 650 TAB            20   24.10   482.00
2  PAN 40 TAB              15  110.40  1656.00
Taxable Value                          2138.00
CGST 6%                                 128.28
SGST 6%                                 128.28
Grand Total (Incl. GST)                2394.56`);
  assert.deepEqual([gst.total_amount, gst.tax_amount], [2394.56, 256.56]);
  assert.ok(!gst.warnings.includes('sum_mismatch'));
  const units = readText(`
CITY MEDICALS
Bill No: 4471   Date: 20/10/2026
1000 ML NS Bottle          2   90.00   180.00
50 ML Syringe              5   12.00    60.00
Net Amount                         240.00`);
  assert.deepEqual(units.items.map(i => i.description), ['1000 ML NS Bottle', '50 ML Syringe']);
});

test('a row whose own maths works is never dropped to match a total', () => {
  const d = readText(`
Sl Particulars              Qty   Rate    Amount
1  Phenyl 5 Ltr Can           4  320.00  1280.00
2  Register Book             10   60.00   600.00
3  Ball Pens Blue             3   50.00   150.00
Total                                     750.00`);
  assert.deepEqual(d.items.map(i => i.description), ['Phenyl 5 Ltr Can', 'Register Book', 'Ball Pens Blue']);
  assert.ok(d.warnings.some(w => w === 'total_calculated' || w === 'sum_mismatch'), 'the mismatch is shown for checking instead');
});
