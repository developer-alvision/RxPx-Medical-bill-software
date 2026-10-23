/* Live browser OCR smoke test. Requires internet access for the pinned readers.
 * All source images/PDFs are generated in browser memory; no source files,
 * screenshots, downloads or extraction artifacts are written to disk.
 * Run: node tests/ocr-browser.test.cjs
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_PACKAGE, 'playwright', 'playwright-core', 'E:/Rubicorn/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch (_) {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PACKAGE.');

(async () => {
  const browser = await playwright.chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    const failures = [];
    page.on('requestfailed', request => failures.push({ url: request.url(), error: request.failure()?.errorText }));
    await page.setContent('<!doctype html><meta charset="utf-8"><title>In-memory OCR verification</title>');
    await page.addScriptTag({ url: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js' });
    await page.addScriptTag({ url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js' });
    await page.addScriptTag({ content: await fs.readFile(path.join(__dirname, '..', 'bill-extraction.js'), 'utf8') });
    const result = await page.evaluate(async () => {
      const workers = { created: 0, terminated: 0 };
      const createWorker = Tesseract.createWorker;
      Tesseract.createWorker = async (...args) => {
        const worker = await createWorker(...args);
        workers.created++;
        const terminate = worker.terminate;
        worker.terminate = async (...parameters) => { workers.terminated++; return terminate(...parameters); };
        return worker;
      };
      function drawBill(second = false) {
        const canvas = document.createElement('canvas');
        canvas.width = 1600; canvas.height = 1600;
        const drawing = canvas.getContext('2d');
        drawing.fillStyle = '#fff'; drawing.fillRect(0, 0, canvas.width, canvas.height);
        drawing.fillStyle = '#000'; drawing.font = '40px Arial';
        const lines = second ? [
          'ACME HOSPITAL', 'OP BILL', 'Bill No: OP-104', 'Bill Date: 18/10/2026',
          'Patient Name: Rani', 'UHID: 000092', 'Doctor: Dr Rao',
          'Additional patient information', 'Ward: GENERAL', 'Page 2 of 2'
        ] : [
          'ACME HOSPITAL', 'OP BILL', 'Bill No: OP-104', 'Bill Date: 18/10/2026',
          'Patient Name: Rani', 'UHID: 000092', 'Doctor: Dr Rao'
        ];
        lines.forEach((line, index) => drawing.fillText(line, 80, 100 + index * 78));
        if (!second) {
          const columns = [80, 760, 970, 1210];
          [['Description', 'Qty', 'Rate', 'Amount'], ['Consultation', '1', '200.00', '200.00'], ['Paracetamol', '2', '25.00', '50.00']]
            .forEach((row, index) => row.forEach((value, column) => drawing.fillText(value, columns[column], 760 + index * 90)));
          drawing.fillText('Grand Total: INR 250.00', 80, 1160);
        }
        return canvas;
      }
      const first = drawBill();
      const png = await new Promise(resolve => first.toBlob(resolve, 'image/png'));
      const image = await BillExtraction.extract(new File([png], 'in-memory-bill.png', { type: 'image/png' }));
      const rasterVariants = [];
      for (const [type, extension] of [['image/jpeg', 'jpg'], ['image/webp', 'webp']]) {
        const blob = await new Promise(resolve => first.toBlob(resolve, type, 0.95));
        if (!blob || blob.type !== type) throw new Error('This browser could not encode the required ' + type + ' fixture.');
        rasterVariants.push({ type, bill: await BillExtraction.extract(new File([blob], 'in-memory-bill.' + extension, { type })) });
      }

      // Build a two-page scanned PDF from in-memory JPEG streams. There is no
      // embedded text, so both pages must pass through PDF rendering and OCR.
      const encoder = new TextEncoder();
      const text = value => encoder.encode(value);
      const join = chunks => {
        const bytes = new Uint8Array(chunks.reduce((size, chunk) => size + chunk.length, 0));
        let offset = 0;
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
        return bytes;
      };
      const images = [];
      for (const canvas of [first, drawBill(true)]) {
        const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.95));
        images.push(new Uint8Array(await jpeg.arrayBuffer()));
      }
      const objects = [text('<< /Type /Catalog /Pages 2 0 R >>'), text('<< /Type /Pages /Kids [3 0 R 6 0 R] /Count 2 >>')];
      for (let index = 0; index < 2; index++) {
        const contentNumber = 4 + index * 3, imageNumber = 5 + index * 3;
        objects.push(text(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 600] /Resources << /XObject << /Im1 ${imageNumber} 0 R >> /Font << /F1 9 0 R >> >> /Contents ${contentNumber} 0 R >>`));
        const watermark = index === 1 ? ' BT /F1 8 Tf 3 Tr 20 20 Td (Digitally verified copy for hospital administration. This long hidden watermark is not the patient bill and must not prevent OCR of the image.) Tj ET' : '';
        const stream = text('q 600 0 0 600 0 0 cm /Im1 Do Q' + watermark);
        objects.push(join([text(`<< /Length ${stream.length} >>\nstream\n`), stream, text('\nendstream')]));
        objects.push(join([text(`<< /Type /XObject /Subtype /Image /Width 1600 /Height 1600 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${images[index].length} >>\nstream\n`), images[index], text('\nendstream')]));
      }
      objects.push(text('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'));
      const chunks = [text('%PDF-1.4\n')], offsets = [0];
      let offset = chunks[0].length;
      objects.forEach((object, index) => {
        offsets.push(offset);
        const chunk = join([text(`${index + 1} 0 obj\n`), object, text('\nendobj\n')]);
        chunks.push(chunk); offset += chunk.length;
      });
      chunks.push(text(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(value => String(value).padStart(10, '0') + ' 00000 n \n').join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`));
      const pdf = await BillExtraction.extract(new File([join(chunks)], 'in-memory-scanned-bill.pdf', { type: 'application/pdf' }));
      first.width = 0; first.height = 0;
      return { image, rasterVariants, pdf, workers };
    });
    for (const [kind, bill] of [['PNG image', result.image], ...result.rasterVariants.map(variant => [variant.type, variant.bill]), ['scanned PDF', result.pdf]]) {
      assert.equal(bill.bill_number, 'OP-104', kind);
      assert.equal(bill.bill_date, '2026-10-18', kind);
      assert.equal(bill.total, 250, kind);
      assert.equal(bill.currency, 'INR', kind);
      assert.equal(bill.billCategory, 'outpatient', kind);
      assert.ok(bill.fields.some(field => /patient name/i.test(field.label) && field.value === 'Rani'), kind);
      assert.ok(bill.fields.some(field => /uhid/i.test(field.label) && field.value === '000092'), kind);
      assert.deepEqual(bill.items.map(item => [item.description, item.quantity, item.rate, item.amount]), [['Consultation', 1, 200, 200], ['Paracetamol', 2, 25, 50]], kind);
    }
    assert.match(result.pdf.rawText, /Additional patient information/);
    assert.match(result.pdf.rawText, /Page 2 of 2/);
    assert.ok(result.pdf.warnings.some(warning => /Page 2 contains a large image/.test(warning)));
    assert.equal(result.workers.created, 5);
    assert.equal(result.workers.terminated, 5);
    console.log(JSON.stringify({ status: 'PASS', image: { bill_number: result.image.bill_number, total: result.image.total, confidence: result.image.confidence, items: result.image.items }, additionalRasterFormats: result.rasterVariants.map(variant => ({ type: variant.type, total: variant.bill.total, bill_number: variant.bill.bill_number, confidence: variant.bill.confidence })), scannedPDF: { pages: 2, bill_number: result.pdf.bill_number, total: result.pdf.total, confidence: result.pdf.confidence, items: result.pdf.items }, workers: result.workers, failedRequests: failures }, null, 2));
    await context.close();
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
