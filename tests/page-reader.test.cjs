'use strict';
// The bill reader inside 'medical bills.html' (the page the app actually runs), checked on
// Tesseract output for six bill types. Run: node --test tests/page-reader.test.cjs
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
