const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const exporter = require('../bill-export.js');
let XLSX;
try { XLSX = require(process.env.RXPX_XLSX_MODULE || 'xlsx'); }
catch { try { XLSX = require(path.join(os.tmpdir(), 'rxpx-bill-tests', 'xlsx-0.20.3.cjs')); } catch { try { XLSX = require(path.join(os.tmpdir(), 'rxpx-bill-tests', 'xlsx-0.18.5.cjs')); } catch {} } }

test('worksheet names are legal, unique without regard to case, and at most 31 code units', () => {
  const used = new Set();
  const names = ['Bills', 'bills', 'a'.repeat(50), 'a'.repeat(50), "'[]?/*\\:'", '😀'.repeat(25)].map(value => exporter.safeSheetName(value, used));
  assert.equal(new Set(names.map(value => value.toLowerCase())).size, names.length);
  assert.ok(names.every(value => value.length > 0 && value.length <= 31 && !/[\[\]?/*\\:]/.test(value)));
  assert.ok(names.every(value => !/^[']|[']$/.test(value)));
  assert.ok(!/[\uD800-\uDBFF]$/.test(names.at(-1)));
});

test('export rejects a missing Excel library clearly', () => {
  assert.throws(() => exporter.createWorkbook([], [], null), /Excel library did not load/);
});

const fixture = () => ({ bills: [
  { id: 'bill-1', ledger_id: 'ledger-1', bill_type: 'expense', bill_category: 'pharmacy', vendor: 'Acme', bill_number: 'INV-1', bill_date: '2026-10-18', currency: 'INR', total: 100, extraction_confidence: 0,
    items: [{ description: 'Free sample', quantity: 0, rate: 0, amount: 0 }, { description: 'Consultation', quantity: 1, rate: 100, amount: 100 }],
    fields: [{ label: 'Patient note', value: '=HYPERLINK("https://example.test")' }, { label: 'Zero', value: 0 }],
    tables: [{ name: 'Ward / ICU [extra]: quite a long title beyond limit', columns: ['Description', 'Amount', 'Amount', '', 'Extra'], rows: [['Sample', 0, '', '', '=2+2'], ['', '', '', '', '']],
      sourceRows: [['Vendor:', 'Acme', '', '', ''], ['Description', 'Amount', 'Amount', '', 'Extra'], ['Sample', 0, '', '', '=2+2'], ['', '', '', '', '']], headerRow: 1, source: 'spreadsheet', sourceRange: 'A1:E4', formulas: { E3: '2+2' } }] },
  { id: 'bill-2', ledger_id: 'ledger-2', bill_type: 'income', vendor: 'US Hospital', bill_number: 'INV-2', bill_date: '2026-10-18', currency: 'USD', total: 50,
    items: [{ description: 'Foreign test', quantity: 1, rate: 50, amount: 50 }], fields: [{ label: 'Foreign field', value: 'Foreign value' }],
    tables: [{ name: 'Foreign table', columns: ['USD'], rows: [[50]], sourceRows: [['USD', 50]] }] }
], ledgers: [{ id: 'ledger-1', name: 'Medical' }, { id: 'ledger-2', name: 'Foreign' }] });

test('actual Excel round-trip exports INR hospital data with category, tables, duplicate headers, blanks and zeroes', { skip: !XLSX && 'Set RXPX_XLSX_MODULE to a SheetJS CommonJS module to run binary export tests.' }, () => {
  const { bills, ledgers } = fixture();
  const book = exporter.createWorkbook(bills, ledgers, XLSX);
  const binary = XLSX.write(book, { bookType: 'xlsx', type: 'buffer' });
  const read = XLSX.read(binary, { type: 'buffer', raw: true });
  const rows = name => XLSX.utils.sheet_to_json(read.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true });
  assert.deepEqual(rows('Bills').map(row => row[7]), ['Currency', 'INR']);
  assert.deepEqual(rows('Bills').map(row => row[3]), ['Category', 'Pharmacy']);
  assert.ok(rows('Bills')[0].includes('Total (₹)'));
  assert.ok(!rows('Bills')[0].includes('Original file'));
  assert.equal(rows('Bills')[1][10], 0);
  assert.equal(rows('Line items')[1][7], 0);
  assert.equal(rows('Extra fields')[2][5], 0);
  const index = rows('Index');
  const tableName = index[1][5], originalName = index[1][6];
  assert.deepEqual(rows(tableName), [bills[0].tables[0].columns, ...bills[0].tables[0].rows]);
  assert.deepEqual(rows(originalName), bills[0].tables[0].sourceRows);
  assert.equal(index[1][0], 'bill-1');
  assert.equal(index[1][1], 'Medical');
  assert.equal(index[1][7], 'A1:E4');
  assert.equal(read.Sheets[tableName].E2.t, 's');
  assert.equal(read.Sheets[tableName].E2.v, '=2+2');
  assert.equal(read.Sheets[tableName].E2.f, undefined);
  assert.equal(read.Sheets['Extra fields'].F2.t, 's');
  assert.equal(read.Sheets['Extra fields'].F2.f, undefined);
  assert.equal(rows('Line items').length, 3);
  assert.equal(rows('Extra fields').length, 3);
  assert.equal(rows('Index').length, 2);
  assert.ok(!read.SheetNames.some(name => /Foreign/.test(name)));
});

test('foreign and unknown currencies never enter an INR workbook and rupee amounts are not converted', { skip: !XLSX }, () => {
  const bills = ['USD', 'EUR', '', null, undefined, 'inr'].map((currency, index) => ({
    id: 'currency-' + index, currency, bill_type: 'expense', total: 123.45, items: [], fields: [], tables: []
  }));
  const before = JSON.stringify(bills);
  const book = exporter.createWorkbook(bills, [], XLSX);
  const rows = XLSX.utils.sheet_to_json(book.Sheets.Bills, { header: 1, raw: true });
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'currency-5');
  assert.equal(rows[1][3], 'Other');
  assert.equal(rows[1][7], 'INR');
  assert.equal(rows[1][8], 123.45);
  assert.equal(JSON.stringify(bills), before);
});

test('workbook export does not mutate stored records and every metadata property is retained', { skip: !XLSX }, () => {
  const { bills, ledgers } = fixture();
  const before = JSON.stringify(bills);
  const book = exporter.createWorkbook(bills, ledgers, XLSX);
  assert.equal(JSON.stringify(bills), before);
  const metadata = XLSX.utils.sheet_to_json(book.Sheets['Table metadata'], { header: 1, raw: true });
  assert.ok(metadata.some(row => row[3] === 'headerRow' && row[5] === 1));
  assert.ok(metadata.some(row => row[3] === 'formulas' && row[5] === '{"E3":"2+2"}'));
  assert.ok(book.SheetNames.includes('Index'));
});

test('wide tables and more than a thousand rows survive an in-memory Excel round-trip', { skip: !XLSX }, () => {
  const columns = Array.from({ length: 32 }, (_, index) => index === 31 ? '' : 'Column ' + (index + 1));
  const data = Array.from({ length: 1201 }, (_, row) => columns.map((_, column) => column === 31 ? '' : row * 32 + column));
  data.push(columns.map(() => ''));
  const sourceRows = [columns, ...data];
  const note = 'A' + '\uD83D\uDC8A'.repeat(20000);
  const bill = { id: 'wide', currency: 'INR', bill_category: 'medical_stock', total: 1,
    items: [], fields: [], tables: [{ name: 'Stock', columns, rows: data, sourceRows, note }] };
  const book = exporter.createWorkbook([bill], [], XLSX);
  const read = XLSX.read(XLSX.write(book, { bookType: 'xlsx', type: 'buffer' }), { type: 'buffer', raw: true });
  const rows = name => XLSX.utils.sheet_to_json(read.Sheets[name], { header: 1, raw: true, defval: '', blankrows: true });
  const index = rows('Index')[1];
  assert.deepEqual(rows(index[5]), sourceRows);
  assert.deepEqual(rows(index[6]), sourceRows);
  assert.equal(read.Sheets[index[5]]['!ref'], 'A1:AF1203');
  const noteParts = rows('Table metadata').filter(row => row[3] === 'note').sort((a, b) => a[4] - b[4]);
  assert.ok(noteParts.length > 1);
  assert.equal(noteParts.map(row => row[5]).join(''), note);
});

test('Excel limits fail clearly before oversized values or columns can be truncated', { skip: !XLSX }, () => {
  const base = { id: 'oversized', currency: 'INR', total: 1, items: [], fields: [], tables: [] };
  assert.throws(() => exporter.createWorkbook([{ ...base, fields: [{ label: 'Value', value: 'x'.repeat(32768) }] }], [], XLSX), /exceeds the Excel text limit/);
  assert.throws(() => exporter.createWorkbook([{ ...base, tables: [{ columns: Array(16385).fill('Column'), rows: [] }] }], [], XLSX), /exceeds the Excel worksheet limit/);
});
