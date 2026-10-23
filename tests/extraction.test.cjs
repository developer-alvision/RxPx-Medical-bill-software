const test = require('node:test');
const assert = require('node:assert/strict');
const extraction = require('../bill-extraction.js');

test('file kinds accept supported raster images and reject active SVG despite misleading names', async () => {
  for (const extension of ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']) {
    assert.equal(extraction.fileKind({ name: 'photo.' + extension, type: '' }), 'image', extension);
  }
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/bmp']) {
    assert.equal(extraction.fileKind({ name: 'photo', type }), 'image', type);
  }
  assert.equal(extraction.fileKind({ name: 'PHOTO.PNG', type: 'IMAGE/PNG' }), 'image');
  assert.equal(extraction.fileKind({ name: 'photo.jpeg', type: 'application/octet-stream' }), 'image');
  for (const file of [
    { name: 'photo.jpg', type: 'image/svg+xml' }, { name: 'photo.jpg', type: 'image/svg+xml; charset=utf-8' },
    { name: 'photo.svg', type: 'image/png' }, { name: 'photo.svgz', type: '' },
    { name: 'photo.png', type: 'image/unknown' }, { name: 'photo.jpg', type: 'text/html' },
    { name: 'bill.xlsx', type: 'image/svg+xml' }
  ]) {
    assert.equal(extraction.fileKind(file), '', JSON.stringify(file));
    await assert.rejects(extraction.extract(Object.assign({ size: 1, arrayBuffer: async () => { throw new Error('Unsafe file content must not be read'); } }, file)), /Choose a raster image/);
  }
  assert.equal(extraction.fileKind({ name: 'bill.pdf', type: 'application/pdf' }), 'pdf');
  assert.equal(extraction.fileKind({ name: 'bill.xlsx', type: '' }), 'sheet');
  assert.equal(extraction.fileKind({ name: 'bill.csv', type: 'text/csv' }), 'sheet');
  for (const extension of ['tif', 'tiff', 'heic', 'heif']) {
    const file = { name: 'bill.' + extension, type: '', size: 1, arrayBuffer: async () => { throw new Error('Unsupported image must not be read'); } };
    assert.equal(extraction.fileKind(file), '');
    await assert.rejects(extraction.extract(file), /Convert TIFF, HEIC or HEIF/);
  }
});

test('money preserves zero and rejects blank, malformed and OCR-confused values', () => {
  assert.equal(extraction.parseMoney('0.00'), 0);
  assert.equal(extraction.parseMoney('₹1,23,456.78'), 123456.78);
  assert.equal(extraction.parseMoney('Rs. 1,250/-'), 1250);
  assert.equal(extraction.parseMoney('(125.50)'), -125.5);
  for (const value of ['', ' ', null, undefined, '1O0.00', '1,2,3', '10/10/2026', 'INR']) assert.equal(extraction.parseMoney(value), null);
});

test('validates calendar dates rather than inventing valid dates', () => {
  assert.equal(extraction.normalizeDate('31/02/2026'), '');
  assert.equal(extraction.normalizeDate('29/02/2024'), '2024-02-29');
  assert.equal(extraction.normalizeDate('18 Oct 2026'), '2026-10-18');
  assert.equal(extraction.normalizeDate('2026-10-18'), '2026-10-18');
  assert.equal(extraction.normalizeDate('10/18/2026'), '2026-10-18');
});

test('maps five-column bill without replacing a missing total with item sums', () => {
  const result = extraction.fromText('Vendor: Acme\nInvoice No: A-104\nBill date: 18/10/2026\nDescription\tBatch\tQty\tRate\tAmount\nTablet\tB-1\t2\t25\t50\nFree sample\tB-2\t0\t0\t0');
  assert.equal(result.vendor, 'Acme');
  assert.equal(result.bill_number, 'A-104');
  assert.equal(result.bill_date, '2026-10-18');
  assert.equal(result.total, null);
  assert.deepEqual(result.items[0], { description: 'Tablet', quantity: 2, rate: 25, amount: 50 });
  assert.equal(result.items[1].amount, 0);
  assert.ok(result.warnings.some(warning => /bill total/.test(warning)));
});

test('does not confuse tax, balance or subtotals with a grand total', () => {
  const result = extraction.fromText('Subtotal: 1000\nCGST: 90\nSGST: 90\nGrand Total: ₹1,180\nPaid: 1000\nBalance Due: 180');
  assert.equal(result.total, 1180);
  assert.equal(extraction.fromText('Subtotal: 1000\nTax: 180').total, null);
  assert.equal(extraction.fromText('Grand total: 100\nGrand total: 150').total, null);
  assert.equal(extraction.fromText('Grand total: 0').total, 0);
  assert.equal(extraction.fromText('Subtotal: 500\nBalance due: 250').total, null);
});

test('currency detection preserves foreign money and marks mixed or ambiguous sources for rejection', () => {
  assert.equal(extraction.fromText('Total: ₹1,000').currency, 'INR');
  assert.equal(extraction.fromText('Total: Rs. 1000').currency, 'INR');
  assert.equal(extraction.fromText('Grand total: USD 1,000').currency, 'USD');
  assert.equal(extraction.fromText('Grand total: USD 1,000').total, 1000);
  assert.equal(extraction.fromText('Total: $100').currency, 'USD');
  assert.equal(extraction.fromText('Total: €100').currency, 'EUR');
  assert.equal(extraction.fromText('Total: £100').currency, 'GBP');
  assert.equal(extraction.fromText('Total: 100').currency, '');
  assert.equal(extraction.fromText('Total: INR 100\nUSD 10').currency, '');
  assert.equal(extraction.fromText('Total: INR 100\nUSD 10').currencyConflict, true);
  assert.equal(extraction.fromText('Total: 100').currencyConflict, false);
  assert.equal(extraction.fromText('Total: ¥100').currencyConflict, true);
  assert.equal(extraction.fromText('Currency: Kenyan shillings\nTotal: 100').currencyConflict, true);
  assert.ok(extraction.fromText('Total: EUR 100').warnings.some(warning => /Only Indian rupee/.test(warning)));
});

test('hospital categories follow the document purpose and use fixed category keys', () => {
  const examples = {
    pharmacy: 'Sun Pharmacy\nTax Invoice\nBatch No: 001\nGrand total: INR 100',
    medical_stock: 'Sun Pharmacy\nMedical Stock Purchase Invoice\nGrand total: INR 100',
    patient: 'Patient Bill\nPatient name: Anu\nGrand total: INR 100',
    discharge: 'Sun Pharmacy Hospital\nDischarge Bill\nPharmacy charges: 100\nGrand total: INR 100',
    outpatient: 'Acme Diagnostics\nOP Bill\nLab charges: 100\nGrand total: INR 100',
    inpatient: 'Inpatient Bill\nGrand total: INR 100',
    laboratory: 'Pathology Laboratory Bill\nGrand total: INR 100',
    diagnostics: 'Radiology Invoice\nGrand total: INR 100',
    procedure: 'Procedure Bill\nGrand total: INR 100',
    emergency: 'Casualty Receipt\nGrand total: INR 100',
    other: 'Invoice\nGrand total: INR 100'
  };
  assert.deepEqual(Object.keys(examples), [...extraction.BILL_CATEGORIES]);
  for (const [category, text] of Object.entries(examples)) assert.equal(extraction.fromText(text).billCategory, category, category);
});

test('medical store issuer names do not turn pharmacy or patient bills into stock purchases', () => {
  assert.equal(extraction.detectBillCategory('Sri Medical Stores\nPHARMACY BILL\nPatient: Jane\nGrand Total: Rs. 100'), 'pharmacy');
  assert.equal(extraction.detectBillCategory('Sri Medical Stores\nPATIENT BILL\nPatient: Jane\nGrand Total: Rs. 100'), 'patient');
  assert.equal(extraction.detectBillCategory('Sri Medical Stores\nMedical Stock Purchase Invoice\nGrand Total: Rs. 100'), 'medical_stock');
  assert.equal(extraction.detectBillCategory('Sri Medical Stores\nPurchase Invoice\nGrand Total: Rs. 100'), 'medical_stock');
});

test('hospital patient identifiers, encounter dates, doctor and pharmacy details retain printed values', () => {
  const result = extraction.fromText('Acme Hospital\nDischarge Bill\nPatient Name: Sageetha Age: 42 Gender: Female\nUHID: 000092 IP No: IP-0012 OP No: OP-0007\nConsultant: Dr. S. Rao\nAdmission Date: 17/10/2026 09:35 Discharge Date: 18/10/2026 16:00\nWard: ICU Bed No: 003\nBatch No: 000B Expiry Date: 05/2027\nCGST: 2.50 SGST: 2.50\nCustom hospital field: Keep this\nDescription\tBatch\tExpiry\tQty\tRate\tCGST %\tSGST %\tAmount\nTablet\t000B\t05/2027\t2\t50\t2.5\t2.5\t100\nGrand total: INR 100');
  const values = new Map(result.fields.map(field => [field.label.toLowerCase(), field.value]));
  for (const [label, value] of Object.entries({ 'patient name': 'Sageetha', age: '42', gender: 'Female', uhid: '000092', 'ip no': 'IP-0012', 'op no': 'OP-0007', consultant: 'Dr. S. Rao', 'admission date': '17/10/2026 09:35', 'discharge date': '18/10/2026 16:00', ward: 'ICU', 'bed no': '003', 'batch no': '000B', 'expiry date': '05/2027', cgst: '2.50', sgst: '2.50', 'custom hospital field': 'Keep this' })) {
    assert.equal(values.get(label), value, label);
  }
  assert.deepEqual(result.tables[0].columns, ['Description', 'Batch', 'Expiry', 'Qty', 'Rate', 'CGST %', 'SGST %', 'Amount']);
  assert.deepEqual(result.tables[0].rows[0], ['Tablet', '000B', '05/2027', '2', '50', '2.5', '2.5', '100']);
});

test('spreadsheet patient fields are preserved in both paired cells and unfamiliar columns', () => {
  const table = extraction.tableFromRows('Patient details', [
    ['Patient Name', 'Anu', 'UHID', '00017'],
    ['IP No', 'IP-007', 'Doctor', 'Dr. Rao'],
    ['Description', 'Qty', 'Amount', 'Custom Ward'],
    ['Room rent', 1, 500, 'A']
  ]);
  const result = extraction.fromText('Inpatient Bill\nGrand total: INR 500', { tables: [table] });
  assert.ok(result.fields.some(field => field.label === 'UHID' && field.value === '00017'));
  assert.ok(result.fields.some(field => field.label === 'Doctor' && field.value === 'Dr. Rao'));
  assert.deepEqual(result.tables[0].sourceRows[0], ['Patient Name', 'Anu', 'UHID', '00017']);
  assert.equal(result.tables[0].rows[0][3], 'A');
});

test('all worksheet columns, blank cells, zeroes and preamble rows survive extraction', () => {
  const workbook = { SheetNames: ['Medicines', 'Services'], Sheets: {
    Medicines: { '!ref': 'A1:K4', A1: { v: 'Vendor:' }, B1: { v: 'Acme' },
      A2: { v: 'Description' }, B2: { v: 'Batch' }, C2: { v: 'HSN' }, D2: { v: 'Qty' }, E2: { v: 'Rate' }, F2: { v: 'Discount' }, G2: { v: 'GST %' }, H2: { v: 'Amount' }, I2: { v: 'Custom' }, J2: { v: 'Expiry' },
      A3: { v: 'Medicine' }, B3: { v: '00123' }, D3: { v: 0 }, E3: { v: 0 }, H3: { v: 0 }, I3: { v: 'Keep me' }, K3: { v: 'Unknown extra' }, A4: { v: 'Grand total' }, H4: { v: 0 } },
    Services: { '!ref': 'A1:C2', A1: { v: 'Description' }, B1: { v: 'Qty' }, C1: { v: 'Amount' }, A2: { v: 'Consultation' }, B2: { v: 1 }, C2: { v: 0 } }
  } };
  const result = extraction.fromWorkbook(workbook);
  assert.equal(result.tables.length, 2);
  const table = result.tables[0];
  assert.equal(table.columns.length, 11);
  assert.equal(table.columns[10], '');
  assert.equal(table.rows[0][1], '00123');
  assert.equal(table.rows[0][2], '');
  assert.equal(table.rows[0][3], 0);
  assert.equal(table.rows[0][8], 'Keep me');
  assert.equal(table.rows[0][10], 'Unknown extra');
  assert.equal(table.sourceRows[0][1], 'Acme');
  assert.equal(result.items.length, 2);
  assert.equal(result.total, 0);
});

test('numeric workbook display and number formats establish currency without replacing numeric data', () => {
  const fromCell = cell => extraction.fromWorkbook({ SheetNames: ['Bill'], Sheets: { Bill: { '!ref': 'A1:B1', A1: { v: 'Grand total' }, B1: cell } } });
  for (const cell of [
    { t: 'n', v: 100, z: '"$"#,##0.00', w: '$100.00' },
    { t: 'n', v: 100, z: '[$USD-409]#,##0.00' },
    { t: 'n', v: 100, w: '$100.00' }
  ]) {
    const result = fromCell(cell);
    assert.equal(result.currency, 'USD');
    assert.equal(result.currencyConflict, false);
    assert.equal(result.total, 100);
    assert.equal(result.tables[0].sourceRows[0][1], 100);
  }
  for (const cell of [
    { t: 'n', v: 100, z: '"₹"#,##0.00', w: '₹100.00' },
    { t: 'n', v: 100, z: '[$₹-en-IN]#,##0.00' },
    { t: 'n', v: 100, z: '"Rs. "#,##0.00' }
  ]) assert.equal(fromCell(cell).currency, 'INR');
  const mixed = extraction.fromWorkbook({ SheetNames: ['Bill'], Sheets: { Bill: {
    '!ref': 'A1:B2', A1: { v: 'Grand total' }, B1: { t: 'n', v: 100, z: '"₹"0.00' },
    A2: { v: 'Foreign charge' }, B2: { t: 'n', v: 10, z: '"€"0.00' }
  } } });
  assert.equal(mixed.currency, '');
  assert.equal(mixed.currencyConflict, true);
  assert.ok(mixed.warnings.some(warning => /Multiple currencies/.test(warning)));
  assert.equal(mixed.tables[0].sourceRows[1][1], 10);
});

test('workbook currency inference ignores locale markers, string-cell formats and inactive numeric sections', () => {
  const fromCell = cell => extraction.fromWorkbook({ SheetNames: ['Bill'], Sheets: { Bill: { '!ref': 'A1:B1', A1: { v: 'Grand total' }, B1: cell } } });
  for (const cell of [
    { t: 'n', v: 100, z: '[$-409]0.00' },
    { t: 's', v: '100', z: '"$"0.00', w: '$100.00' },
    { t: 'n', v: 100, z: '0.00;0.00;0.00;"USD "@' },
    { t: 'n', v: 100, z: '0.00;"USD "0.00' },
    { t: 'n', v: 0, z: '0.00;"USD "0.00' },
    { t: 'n', v: -100, z: '0.00;;"USD "0.00' },
    { t: 'n', v: 100, z: '[>=200]"USD "0.00;0.00' },
    { t: 'n', v: 100, z: '0.00_$' }
  ]) {
    const result = fromCell(cell);
    assert.equal(result.currency, '', JSON.stringify(cell));
    assert.equal(result.currencyConflict, false, JSON.stringify(cell));
  }
  assert.equal(fromCell({ t: 'n', v: -100, z: '0.00;"USD "0.00' }).currency, 'USD');
  assert.equal(fromCell({ t: 'n', v: 200, z: '[>=200]"USD "0.00;0.00' }).currency, 'USD');
});

test('quoted CSV keeps newlines, empty cells and embedded commas', () => {
  assert.deepEqual(extraction.parseCSV('\uFEFFDescription,Qty,Amount,Custom\r\n"Text, with comma",0,0,\r\n"Multi\nline",1,12,"A ""quote"""\r\n'), [
    ['Description', 'Qty', 'Amount', 'Custom'], ['Text, with comma', '0', '0', ''], ['Multi\nline', '1', '12', 'A "quote"']
  ]);
  assert.throws(() => extraction.parseCSV('"unclosed'), /unterminated/);
});

test('PDF/OCR coordinate tables preserve extra unknown columns', () => {
  const line = (y, values) => ({ tokens: values.map(([text, x0, x1]) => ({ text, x0, x1, y0: y, y1: y + 10 })) });
  const tables = extraction.tablesFromLines([
    line(0, [['Description', 0, 75], ['Batch', 100, 140], ['Qty', 160, 185], ['Rate', 210, 240], ['Amount', 270, 320], ['Ward', 350, 390]]),
    line(20, [['Consultation', 0, 75], ['B-12', 100, 130], ['1', 170, 180], ['200', 220, 240], ['200', 285, 305], ['ICU', 350, 375]]),
    line(40, [['Grand Total', 0, 90], ['200', 285, 305]])
  ], { page: 2, source: 'pdf' });
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['Description', 'Batch', 'Qty', 'Rate', 'Amount', 'Ward']);
  assert.deepEqual(tables[0].rows[0], ['Consultation', 'B-12', '1', '200', '200', 'ICU']);
  assert.equal(tables[0].page, 2);
});

test('ambiguous amount columns remain unknown; oversized workbooks are rejected whole', () => {
  const result = extraction.fromText('Description\tQty\tAmount\tNet Amount\nItem A\t1\t100\t90\nGrand total: 90');
  assert.equal(result.items[0].amount, null);
  assert.ok(result.warnings.some(warning => /amount column/.test(warning)));
  assert.throws(() => extraction.fromWorkbook({ SheetNames: ['Too big'], Sheets: { 'Too big': { '!ref': 'A1:XFD1000' } } }), /cell limit/);
});

test('unknown PDF table schemas remain available without assigning imaginary item amounts', () => {
  const tokens = (y, cells) => ({ tokens: cells.map((text, index) => ({ text, x0: index * 100, x1: index * 100 + 60, y0: y, y1: y + 10 })) });
  const tables = extraction.tablesFromLines([
    tokens(0, ['Code', 'Finding', 'Reference', 'Unit', 'Status']),
    tokens(20, ['T001', '4.2', '3.5-5.5', 'mmol/L', 'Normal'])
  ]);
  assert.equal(tables.length, 1);
  assert.deepEqual(tables[0].columns, ['Code', 'Finding', 'Reference', 'Unit', 'Status']);
  assert.deepEqual(tables[0].rows[0], ['T001', '4.2', '3.5-5.5', 'mmol/L', 'Normal']);
  assert.deepEqual(extraction.itemsFromTables(tables), []);
});

test('CSV extraction supports upload API and reports completion', async () => {
  const progress = [];
  const file = { name: 'bill.csv', type: 'text/csv', size: 100, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'Description,Qty,Rate,Amount\nConsultation,1,250,250\nGrand total,,,250' };
  const result = await extraction.extract(file, { onProgress: update => progress.push(update) });
  assert.equal(result.total, 250);
  assert.equal(result.items[0].amount, 250);
  assert.equal(progress.at(-1).progress, 100);
});

test('browser extraction reads source bytes transiently and returns data without persisting the source', async () => {
  const previousStorage = global.localStorage, previousDB = global.indexedDB, previousFetch = global.fetch;
  const forbidden = () => { throw new Error('Extraction must not persist or upload a source document'); };
  global.localStorage = { setItem: forbidden };
  global.indexedDB = { open: forbidden };
  global.fetch = forbidden;
  try {
    const result = await extraction.extract({ name: 'private-source.csv', type: 'text/csv', size: 100, arrayBuffer: async () => new ArrayBuffer(0), text: async () => 'Patient Name,Anu\nDescription,Qty,Amount\nConsultation,1,250\nGrand total,,250' });
    assert.equal(result.total, 250);
    assert.ok(result.fields.some(field => field.label === 'Patient Name' && field.value === 'Anu'));
    assert.equal(Object.values(result).some(value => value instanceof Blob || value instanceof ArrayBuffer || value instanceof Uint8Array), false);
    assert.equal(JSON.stringify(result).includes('base64,'), false);
    assert.equal(result.tables[0].name, 'CSV data');
    assert.equal(JSON.stringify(result).includes('private-source.csv'), false);
  } finally { global.localStorage = previousStorage; global.indexedDB = previousDB; global.fetch = previousFetch; }
});

test('PDF extraction reads every textual page and rejects oversized documents whole', async () => {
  const previous = global.pdfjsLib;
  const readPages = [];
  let pageCount = 5, destroyed = false;
  global.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: options => {
    assert.equal(options.isEvalSupported, false, 'Untrusted PDFs must use the documented PDF.js security mitigation');
    return { promise: Promise.resolve({
    numPages: pageCount,
    async getPage(number) {
      readPages.push(number);
      return {
        getViewport: () => ({ width: 600, height: 800 }), cleanup() {},
        async getTextContent() { return { items: [{ str: 'Medical documentation page ' + number + ': all original details are preserved for review and the remaining page content is readable.', transform: [1, 0, 0, 12, 0, 600], height: 12, width: 550 }] }; }
      };
    }, async destroy() { destroyed = true; }
  }) }; } };
  try {
    const file = { name: 'five-pages.pdf', type: 'application/pdf', size: 100, arrayBuffer: async () => new ArrayBuffer(0) };
    const result = await extraction.extract(file);
    assert.deepEqual(readPages, [1, 2, 3, 4, 5]);
    assert.ok(result.rawText.includes('documentation page 5'));
    assert.equal(destroyed, true);
    pageCount = 31; readPages.length = 0; destroyed = false;
    await assert.rejects(extraction.extract(file), /limit is 30/);
    assert.deepEqual(readPages, []);
    assert.equal(destroyed, true);
  } finally { global.pdfjsLib = previous; }
});

test('all scanned PDF pages use OCR, preserve tables and clean up their workers', async () => {
  const previousPDF = global.pdfjsLib, previousOCR = global.Tesseract, previousDocument = global.document;
  const scanned = [], terminated = [];
  let pageNumber = 0;
  global.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ fillRect() {}, fillStyle: '' }) }) };
  global.Tesseract = { async createWorker() {
    const currentPage = pageNumber;
    return { async setParameters() {}, async recognize() {
      scanned.push(currentPage);
      return { data: { text: 'Bill no: SCAN-1\nGrand total: 100\nPage ' + currentPage, confidence: 87, words: [] } };
    }, async terminate() { terminated.push(currentPage); } };
  } };
  global.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    numPages: 4,
    async getPage(number) { pageNumber = number; return {
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), async getTextContent() { return { items: [] }; },
      render: () => ({ promise: Promise.resolve() }), cleanup() {}
    }; }, async destroy() {}
  }) }) };
  try {
    const result = await extraction.extract({ name: 'scan.pdf', type: 'application/pdf', size: 100, arrayBuffer: async () => new ArrayBuffer(0) });
    assert.deepEqual(scanned, [1, 2, 3, 4]);
    assert.deepEqual(terminated, [1, 2, 3, 4]);
    assert.equal(result.total, 100);
    assert.ok(result.rawText.includes('Page 4'));
  } finally { global.pdfjsLib = previousPDF; global.Tesseract = previousOCR; global.document = previousDocument; }
});

test('large scanned PDF images use OCR even when their embedded watermark has many text characters', async () => {
  const previousPDF = global.pdfjsLib, previousOCR = global.Tesseract, previousDocument = global.document;
  let recognized = 0, terminated = 0, cleaned = 0, destroyed = 0;
  const canvases = [];
  global.document = { createElement: () => { const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, fillStyle: '' }) }; canvases.push(canvas); return canvas; } };
  global.Tesseract = { async createWorker() { return { async setParameters() {}, async recognize() { recognized++; return { data: { text: 'Acme Hospital\nOP Bill\nBill no: OP-104\nGrand total: INR 250', confidence: 90, words: [] } }; }, async terminate() { terminated++; } }; } };
  const OPS = { save: 10, restore: 11, transform: 12, paintImageXObject: 85, paintFormXObjectBegin: 74, paintFormXObjectEnd: 75 };
  global.pdfjsLib = { OPS, GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    numPages: 2, async getPage(number) { return {
      getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
      async getTextContent() { return { items: [{ str: 'Digitally verified copy for hospital administration. This long watermark is not the patient bill data and must never hide the actual scanned contents.', transform: [1, 0, 0, 10, 0, 50], height: 10, width: 550 }] }; },
      async getOperatorList() { return { fnArray: [OPS.save, OPS.transform, OPS.paintImageXObject, OPS.restore], argsArray: [null, [number === 1 ? 600 : 60, 0, 0, number === 1 ? 800 : 80, 0, 0], ['image'], null] }; },
      render: () => ({ promise: Promise.resolve() }), cleanup() { cleaned++; }
    }; }, async destroy() { destroyed++; }
  }) }) };
  try {
    const result = await extraction.extract({ name: 'watermarked.pdf', type: 'application/pdf', size: 100, arrayBuffer: async () => new ArrayBuffer(0) });
    assert.equal(recognized, 1, 'A page-sized image needs OCR, while a small logo does not');
    assert.equal(result.total, 250);
    assert.ok(result.warnings.some(warning => /large image/.test(warning)));
    assert.equal(terminated, 1);
    assert.equal(cleaned, 2);
    assert.equal(destroyed, 1);
    assert.ok(canvases.every(canvas => canvas.width === 0 && canvas.height === 0));
  } finally { global.pdfjsLib = previousPDF; global.Tesseract = previousOCR; global.document = previousDocument; }
});

test('a scanned PDF OCR failure rejects the whole extraction and releases worker, page, canvas and document', async () => {
  const previousPDF = global.pdfjsLib, previousOCR = global.Tesseract, previousDocument = global.document;
  let terminated = 0, cleaned = 0, destroyed = 0;
  const canvas = { width: 0, height: 0, getContext: () => ({ fillRect() {}, fillStyle: '' }) };
  global.document = { createElement: () => canvas };
  global.Tesseract = { async createWorker() { return { async setParameters() {}, async recognize() { throw new Error('Unreadable scan'); }, async terminate() { terminated++; } }; } };
  global.pdfjsLib = { GlobalWorkerOptions: {}, getDocument: () => ({ promise: Promise.resolve({
    numPages: 2, async getPage() { return { getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), async getTextContent() { return { items: [] }; }, render: () => ({ promise: Promise.resolve() }), cleanup() { cleaned++; } }; }, async destroy() { destroyed++; }
  }) }) };
  try {
    await assert.rejects(extraction.extract({ name: 'bad-scan.pdf', type: 'application/pdf', size: 100, arrayBuffer: async () => new ArrayBuffer(0) }), /Unreadable scan/);
    assert.equal(terminated, 1);
    assert.equal(cleaned, 1);
    assert.equal(destroyed, 1);
    assert.equal(canvas.width, 0);
    assert.equal(canvas.height, 0);
  } finally { global.pdfjsLib = previousPDF; global.Tesseract = previousOCR; global.document = previousDocument; }
});
