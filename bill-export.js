/* Export saved values without altering original column names or evaluating text. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillExport = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const scalar = value => {
    if (value === null || value === undefined) return '';
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString();
    if (typeof value === 'object') return JSON.stringify(value);
    if (typeof value === 'number') return Number.isFinite(value) ? value : '';
    return typeof value === 'boolean' ? value : String(value);
  };
  const array = value => Array.isArray(value) ? value : [];
  const categoryNames = Object.freeze({
    pharmacy: 'Pharmacy', medical_stock: 'Medical stock', patient: 'Patient',
    discharge: 'Discharge', outpatient: 'Outpatient (OP)', inpatient: 'Inpatient (IP)',
    laboratory: 'Laboratory', diagnostics: 'Diagnostics', procedure: 'Procedure',
    emergency: 'Emergency', other: 'Other'
  });
  const trimName = (value, length) => {
    let output = '';
    for (const char of value) { if ((output + char).length > length) break; output += char; }
    return output;
  };
  function textChunks(value, limit) {
    const chunks = [];
    for (let start = 0; start < value.length;) {
      let end = Math.min(start + limit, value.length);
      // An isolated UTF-16 surrogate produces invalid XML and can erase the
      // cell when Excel/SheetJS reads it. Keep each code point in one chunk.
      if (end < value.length && /[\uD800-\uDBFF]/.test(value[end - 1]) && /[\uDC00-\uDFFF]/.test(value[end])) end--;
      chunks.push(value.slice(start, end));
      start = end;
    }
    return chunks;
  }

  function safeSheetName(requested, usedNames) {
    const used = usedNames || new Set();
    const base = String(requested || 'Table').replace(/[\x00-\x1f\\/*?:\[\]]/g, ' ').trim().replace(/^'+|'+$/g, '').trim() || 'Table';
    let name = trimName(base, 31), suffix = 1;
    while (used.has(name.toLowerCase())) {
      const tail = ' (' + (++suffix) + ')';
      name = trimName(base, 31 - tail.length) + tail;
    }
    used.add(name.toLowerCase());
    return name;
  }

  function createWorkbook(bills, ledgers, XLSX) {
    if (!XLSX || !XLSX.utils || typeof XLSX.utils.aoa_to_sheet !== 'function') throw new Error('The Excel library did not load. Reload and try the download again.');
    // Historical foreign amounts stay untouched in storage and cannot be
    // relabelled as rupees or included in this INR-only workbook.
    bills = array(bills).filter(bill => bill && String(bill.currency || '').trim().toUpperCase() === 'INR');
    ledgers = array(ledgers);
    const workbook = XLSX.utils.book_new(), usedNames = new Set();
    const ledgerNames = new Map(ledgers.map(ledger => [ledger.id, ledger.name]));
    const nameFor = bill => ledgerNames.get(bill.ledger_id) || '';
    const indexRows = [['Bill ID', 'Bill name', 'Bill number', 'Currency', 'Table name', 'Extracted table worksheet', 'Original cells worksheet', 'Original range', 'Source', 'Page', 'Header row (zero-based)']];
    const metadataRows = [['Bill ID', 'Bill name', 'Table name', 'Property', 'Part', 'Value (JSON for objects)']];

    function append(requested, inputRows) {
      const name = safeSheetName(requested, usedNames);
      const rows = inputRows.map(row => array(row).map(value => {
        const result = scalar(value);
        if (typeof result === 'string' && result.length > 32767) throw new Error('A cell in "' + requested + '" exceeds the Excel text limit. Shorten or split that value before exporting.');
        return result;
      }));
      const width = Math.max(1, rows.reduce((max, row) => Math.max(max, row.length), 0));
      if (width > 16384 || rows.length > 1048576) throw new Error('A table exceeds the Excel worksheet limit. Split the records before exporting.');
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      // SheetJS stores strings as text even if they start with =, +, - or @.
      // Keep a rectangular range so trailing blank source columns/rows survive.
      if (rows.length) sheet['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: width - 1 } });
      sheet['!cols'] = Array.from({ length: width }, (_, index) => ({ wch: Math.min(48, Math.max(12, ...rows.slice(0, 50).map(row => String(row[index] == null ? '' : row[index]).length + 2))) }));
      XLSX.utils.book_append_sheet(workbook, sheet, name);
      return name;
    }

    const billRows = [['Bill ID', 'Bill name', 'Type', 'Category', 'Vendor / hospital', 'Bill number', 'Bill date', 'Currency', 'Total (₹)', 'Saved at', 'OCR confidence (%)', 'Extraction method', 'Duplicate override']];
    const itemRows = [['Bill ID', 'Bill name', 'Bill number', 'Bill date', 'Currency', 'Line', 'Description', 'Quantity', 'Rate', 'Amount']];
    const fieldRows = [['Bill ID', 'Bill name', 'Bill number', 'Currency', 'Label', 'Value']];
    for (const bill of bills) {
      const ledgerName = nameFor(bill), currency = 'INR';
      billRows.push([bill.id, ledgerName, bill.bill_type === 'income' ? 'Income / receipt' : 'Expense / purchase', categoryNames[bill.bill_category] || 'Other', bill.vendor, bill.bill_number, bill.bill_date, currency,
        bill.total, bill.created_at, bill.extraction_confidence, bill.extraction_method, bill.force_uploaded ? 'Yes' : 'No']);
      array(bill.items).forEach((item, index) => itemRows.push([bill.id, ledgerName, bill.bill_number, bill.bill_date, currency, index + 1, item.description, item.quantity, item.rate, item.amount]));
      array(bill.fields).forEach(field => fieldRows.push([bill.id, ledgerName, bill.bill_number, currency, field.label, field.value]));
    }
    append('Bills', billRows);
    append('Line items', itemRows);
    append('Extra fields', fieldRows);
    // Reserve Index and Table metadata before unknown source names are appended.
    usedNames.add('index'); usedNames.add('table metadata');
    bills.forEach((bill, billIndex) => {
      array(bill.tables).forEach((table, tableIndex) => {
        const identifier = String(billIndex + 1) + '.' + String(tableIndex + 1);
        const baseName = table.name || 'Table ' + (tableIndex + 1);
        const rows = [array(table.columns), ...array(table.rows)];
        const tableSheet = append(identifier + ' ' + baseName, rows);
        const sourceSheet = Array.isArray(table.sourceRows) ? append(identifier + ' Original ' + baseName, table.sourceRows) : '';
        indexRows.push([bill.id, nameFor(bill), bill.bill_number, 'INR', baseName, tableSheet, sourceSheet, table.sourceRange, table.source, table.page, table.headerRow]);
        for (const [property, value] of Object.entries(table)) {
          if (['columns', 'rows', 'sourceRows'].includes(property)) continue;
          const text = scalar(value);
          const chunks = typeof text === 'string' && text.length > 32700 ? textChunks(text, 32700) : [text];
          chunks.forEach((chunk, part) => metadataRows.push([bill.id, nameFor(bill), baseName, property, part + 1, chunk]));
        }
      });
    });
    usedNames.delete('index'); usedNames.delete('table metadata');
    append('Index', indexRows);
    append('Table metadata', metadataRows);
    workbook.Props = Object.assign({}, workbook.Props, { Title: 'RxPx hospital bills (INR)', Subject: 'Confirmed hospital bill data and extracted tables in Indian rupees', Author: 'RxPx Bills' });
    return workbook;
  }

  return Object.freeze({ createWorkbook, safeSheetName });
});
