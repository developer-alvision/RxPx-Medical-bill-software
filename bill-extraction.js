/* Bill extraction keeps source tables intact. Every inferred value needs review. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillExtraction = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const LIMITS = Object.freeze({ maxPages: 30, maxCells: 300000, maxBytes: 20 * 1024 * 1024 });
  const BILL_CATEGORIES = Object.freeze(['pharmacy', 'medical_stock', 'patient', 'discharge', 'outpatient', 'inpatient', 'laboratory', 'diagnostics', 'procedure', 'emergency', 'other']);
  const aliases = {
    description: ['description', 'item', 'items', 'item name', 'item description', 'particulars', 'product', 'product name', 'medicine', 'medicine name', 'service', 'service name', 'test', 'test name', 'details', 'description of goods'],
    quantity: ['qty', 'quantity', 'qnty', 'units', 'nos', 'no of units'],
    rate: ['rate', 'unit rate', 'price', 'unit price', 'unit cost', 'ptr'],
    amount: ['amount', 'amt', 'net amount', 'net amt', 'line total', 'item total', 'total amount', 'value', 'total'],
    bill_number: ['invoice no', 'invoice number', 'bill no', 'bill number', 'receipt no', 'receipt number', 'invoice #', 'bill #', 'inv no'],
    bill_date: ['date', 'bill date', 'invoice date', 'receipt date', 'dated'],
    vendor: ['vendor', 'vendor name', 'supplier', 'supplier name', 'hospital', 'hospital name', 'pharmacy', 'pharmacy name', 'seller', 'sold by'],
    serial: ['s no', 'sl no', 'sr no', 'serial no', 'serial number', 'sno', 'no', '#'],
    batch: ['batch', 'batch no', 'batch number', 'lot', 'lot no'],
    expiry: ['exp', 'expiry', 'expiry date', 'exp date'],
    hsn: ['hsn', 'hsn code', 'hsn sac', 'sac'],
    tax: ['tax', 'tax %', 'gst', 'gst %', 'cgst', 'cgst %', 'sgst', 'sgst %', 'igst', 'igst %'],
    discount: ['discount', 'disc', 'discount %', 'disc %'],
    mrp: ['mrp'], pack: ['pack', 'packing', 'pack size'], manufacturer: ['mfr', 'manufacturer', 'mfg'],
    patient_name: ['patient', 'patient name', 'name of patient', 'pt name'],
    patient_id: ['patient id', 'patient no', 'patient number', 'uhid', 'uhid no', 'mr no', 'mrn'],
    encounter_id: ['ip no', 'ip number', 'ipd no', 'inpatient no', 'op no', 'op number', 'opd no', 'outpatient no', 'visit no'],
    doctor: ['doctor', 'doctor name', 'consultant', 'consulting doctor', 'treating doctor', 'referred by'],
    admission_date: ['admission date', 'date of admission', 'admitted on', 'doa'],
    discharge_date: ['discharge date', 'date of discharge', 'discharged on', 'dod'],
    ward: ['ward', 'ward no', 'bed', 'bed no', 'room', 'room no']
  };
  const key = value => String(value == null ? '' : value).toLowerCase().replace(/[^a-z0-9]/g, '');
  const dictionary = new Map();
  for (const [kind, names] of Object.entries(aliases)) for (const name of names) if (key(name)) dictionary.set(key(name), kind);
  const kindOf = value => cellString(value).trim() === '#' ? 'serial' : dictionary.get(key(value)) || '';
  const cellString = value => value == null ? '' : value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  const present = value => value !== null && value !== undefined && value !== '';
  const unique = values => Array.from(new Set(values.filter(present)));
  const round = value => Math.round((value + Number.EPSILON) * 100) / 100;
  const hospitalFieldKinds = new Set(['patient_name', 'patient_id', 'encounter_id', 'doctor', 'admission_date', 'discharge_date', 'ward']);

  function detectBillCategory(text) {
    const rules = [
      ['medical_stock', /\b(?:(?:medical|medicine|pharmacy|hospital)\s+(?:stock|inventory)|stock\s+(?:purchase|invoice|receipt|transfer|register)|(?:medical|medicine)\s+(?:purchase|supplies)|purchase\s+(?:invoice|bill)|goods\s+received\s+note|grn)\b/i],
      ['discharge', /\bdischarge\s+(?:bill|summary|invoice|receipt|statement)|\bfinal\s+(?:hospital|inpatient|ip)\s+bill\b/i],
      ['emergency', /\b(?:emergency|casualty)\s*(?:department|bill|invoice|receipt|charges|services)?\b/i],
      ['outpatient', /\b(?:out[\s-]*patient|opd)\b|\bo\.?\s*p\.?\s*(?:bill|invoice|receipt|consultation|registration)\b/i],
      ['inpatient', /\b(?:in[\s-]*patient|ipd)\b|\bi\.?\s*p\.?\s*(?:bill|invoice|receipt|admission)\b/i],
      ['laboratory', /\b(?:laborator(?:y|ies)|pathology|lab\s+(?:bill|invoice|receipt|test|charges))\b/i],
      ['diagnostics', /\b(?:diagnostics?|radiology|imaging|x[\s-]*ray|ultrasound|mri|ct\s+scan)\b/i],
      ['procedure', /\b(?:(?:procedure|surgery|surgical|operation|therapy|dialysis|physiotherapy)\s+(?:bill|invoice|receipt|charges)|operation\s+theatre)\b/i],
      ['pharmacy', /\b(?:pharmacy|medical\s+(?:shops?|stores?)|medicines?\s+(?:bill|invoice)|drug\s+(?:stores?|bill))\b/i],
      ['patient', /\b(?:patient|uhid|mrn)\b/i]
    ];
    // Prefer the document heading to secondary services elsewhere in a hospital bill.
    const lines = String(text || '').replace(/_/g, ' ').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    const headingLines = lines.slice(0, 12).filter(line => !/^\[page\s+\d+\]$/i.test(line) && !/[:=\t]/.test(line));
    const titles = headingLines.filter(line => /\b(?:bill|invoice|receipt|summary|statement|register|goods\s+received\s+note)\b/i.test(line)).join('\n');
    const title = rules.find(([, expression]) => expression.test(titles));
    if (title) return title[0];
    const headings = headingLines.join('\n');
    const heading = rules.find(([category, expression]) => category !== 'patient' && expression.test(headings));
    if (heading) return heading[0];
    const match = rules.find(([, expression]) => expression.test(String(text || '')));
    return match ? match[0] : 'other';
  }

  // Strict parsing prevents blank cells, phone numbers or mixed OCR letters becoming money.
  function parseMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    let text = cellString(value).trim();
    if (!text) return null;
    text = text.replace(/^(?:INR|USD|EUR|GBP|AUD|CAD|SGD|AED|JPY|CNY|Rs\.?)\s*/i, '').replace(/^[₹$€£]\s*/, '').replace(/\s*(?:INR|USD|EUR|GBP|AUD|CAD|SGD|AED|JPY|CNY|Rs\.?)$/i, '').replace(/\/-$/, '').trim();
    const negative = /^\(.*\)$/.test(text);
    if (negative) text = text.slice(1, -1).trim();
    // Accept Indian and international grouping, without treating arbitrary separators as digits.
    if (!/^[+-]?(?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d+)?$/.test(text)) return null;
    const number = Number(text.replace(/,/g, ''));
    return Number.isFinite(number) ? (negative ? -number : number) : null;
  }

  function normalizeDate(value) {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
    const text = cellString(value).trim();
    const make = (year, month, day) => {
      year = +year; month = +month; day = +day;
      if (year < 100) year += 2000;
      const check = new Date(Date.UTC(year, month - 1, day));
      return year >= 1900 && year <= 2199 && check.getUTCFullYear() === year && check.getUTCMonth() === month - 1 && check.getUTCDate() === day
        ? `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}` : '';
    };
    let match = text.match(/^\s*(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:T.*)?\s*$/);
    if (match) return make(match[1], match[2], match[3]);
    match = text.match(/^\s*(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})\s*$/);
    if (match) {
      // Indian day/month convention; unambiguous US dates are also readable.
      let day = +match[1], month = +match[2];
      if (month > 12 && day <= 12) [day, month] = [month, day];
      return make(match[3], month, day);
    }
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    match = text.match(/^(\d{1,2})(?:st|nd|rd|th)?[\s,./-]+([A-Za-z]{3,9})[\s,./-]+(\d{4}|\d{2})$/i);
    if (match) return make(match[3], months.indexOf(match[2].slice(0, 3).toLowerCase()) + 1, match[1]);
    match = text.match(/^([A-Za-z]{3,9})[\s,./-]+(\d{1,2})(?:st|nd|rd|th)?[\s,./-]+(\d{4})$/i);
    return match ? make(match[3], months.indexOf(match[1].slice(0, 3).toLowerCase()) + 1, match[2]) : '';
  }

  function baseResult() {
    return { vendor: '', bill_number: '', bill_date: '', total: null, items: [], confidence: 0,
      rawText: '', tables: [], fields: [], currency: '', currencyConflict: false, billCategory: 'other', warnings: [] };
  }

  function headerScore(row) {
    const kinds = row.map(kindOf).filter(kind => kind && !hospitalFieldKinds.has(kind));
    const count = new Set(kinds).size;
    return count >= 2 && (kinds.includes('description') || count >= 3) ? count : 0;
  }

  function findHeader(rows) {
    let best = -1, score = 0;
    for (let index = 0; index < Math.min(rows.length, 50); index++) {
      const next = headerScore(rows[index]);
      if (next > score) { best = index; score = next; }
    }
    if (best >= 0) return best;
    // A textual first row above values is a header even when its names are unfamiliar.
    const first = rows.findIndex(row => row.some(present));
    if (first < 0) return -1;
    const values = rows[first].filter(present);
    const following = rows[first + 1] || [];
    return values.length >= 2 && values.every(value => typeof value === 'string' && parseMoney(value) === null)
      && following.some(present) ? first : -1;
  }

  function tableFromRows(name, inputRows, metadata) {
    const width = inputRows.reduce((max, row) => Math.max(max, row.length), 0);
    const sourceRows = inputRows.map(row => Array.from({ length: width }, (_, i) => row[i] == null ? '' : row[i] instanceof Date ? cellString(row[i]) : row[i]));
    const headerRow = findHeader(sourceRows);
    return Object.assign({ name: name || 'Table', columns: headerRow < 0 ? Array(width).fill('') : sourceRows[headerRow].map(cellString),
      rows: sourceRows.slice(headerRow < 0 ? 0 : headerRow + 1), sourceRows, headerRow }, metadata || {});
  }

  function summaryKind(label) {
    const text = cellString(label).toLowerCase().trim().replace(/[.:]+$/, '').replace(/\s+/g, ' ');
    if (/^(?:grand total|net total|net amount|net payable|amount payable|invoice total|bill total|bill amount|total amount|total payable|total due|total)$/.test(text)) return 'total';
    return /^(?:sub\s*total|tax|cgst|sgst|igst|gst|discount|round\s*off|paid|amount paid|payment|balance)/.test(text) ? 'other' : '';
  }

  function fieldsFromTables(tables) {
    const fields = [];
    for (const table of tables) {
      for (const row of table.sourceRows || [table.columns, ...table.rows]) {
        const filled = row.map((value, index) => ({ value, index })).filter(cell => present(cell.value));
        if (filled.length >= 2) {
          const label = cellString(filled[0].value).trim();
          // Summary rows often span merged/blank cells with the value at the far right.
          if (summaryKind(label)) {
            const last = filled[filled.length - 1].value;
            if (parseMoney(last) !== null) fields.push({ label, value: last });
          } else if (filled.length === 2 && (kindOf(label) || /[:：]$/.test(label))) {
            fields.push({ label: label.replace(/[:：]$/, ''), value: filled[1].value });
          } else if (filled.length > 2) {
            for (let index = 0; index < filled.length - 1; index++) {
              const label = cellString(filled[index].value).trim();
              if (hospitalFieldKinds.has(kindOf(label)) && !kindOf(filled[index + 1].value)) {
                fields.push({ label: label.replace(/[:：]$/, ''), value: filled[index + 1].value });
              }
            }
          }
        }
      }
      const indexes = table.columns.map(kindOf);
      for (let index = 0; index < indexes.length; index++) {
        if (!['vendor', 'bill_number', 'bill_date'].includes(indexes[index]) && !hospitalFieldKinds.has(indexes[index])) continue;
        const values = unique(table.rows.map(row => present(row[index]) ? cellString(row[index]) : ''));
        for (const value of values) fields.push({ label: table.columns[index], value });
      }
    }
    return fields;
  }

  function itemsFromTables(tables) {
    const items = [];
    for (const table of tables) {
      const kinds = table.columns.map(kindOf);
      const descriptionIndex = kinds.indexOf('description');
      if (descriptionIndex < 0) continue;
      for (const row of table.rows) {
        const description = cellString(row[descriptionIndex]).trim();
        if (!description || summaryKind(description) || headerScore(row) >= 2) continue;
        const item = { description, quantity: null, rate: null, amount: null };
        for (const name of ['quantity', 'rate', 'amount']) {
          const candidates = kinds.map((kind, index) => kind === name ? index : -1).filter(index => index >= 0);
          // Multiple amount columns require review instead of choosing one arbitrarily.
          if (candidates.length === 1) item[name] = parseMoney(row[candidates[0]]);
        }
        items.push(item);
      }
    }
    return items;
  }

  function textFields(text) {
    const fields = [];
    const hospitalNames = '(?:name\\s*of\\s*patient|patient\\s*(?:name|id|no\\.?|number)|pt\\.?\\s*name|uhid(?:\\s*no\\.?)?|mrn|mr\\s*no\\.?|(?:ipd?|opd?)\\s*(?:no\\.?|number)|(?:inpatient|outpatient|visit)\\s*no\\.?|date\\s*of\\s*(?:admission|discharge)|(?:admission|discharge)\\s*(?:date|time)|(?:admitted|discharged)\\s*on|doa|dod|(?:consulting|treating)\\s*doctor|doctor(?:\\s*name)?|consultant|referred\\s*by|ward(?:\\s*no\\.?)?|bed(?:\\s*no\\.?)?|room(?:\\s*no\\.?)?|age|gender|sex|patient|batch(?:\\s*(?:no\\.?|number))?|expiry(?:\\s*date)?|exp\\.?\\s*date|cgst(?:\\s*%)?|sgst(?:\\s*%)?|igst(?:\\s*%)?|gst(?:in|\\s*%)?|discount|payment\\s*mode)';
    const names = '(?:' + hospitalNames + '|invoice\\s*(?:no\\.?|number|#)|bill\\s*(?:no\\.?|number|#)|receipt\\s*(?:no\\.?|number|#)|invoice\\s*date|bill\\s*date|receipt\\s*date|date|dated|vendor(?:\\s*name)?|supplier(?:\\s*name)?|hospital(?:\\s*name)?|pharmacy(?:\\s*name)?|sold\\s*by|grand\\s*total|net\\s*(?:amount|payable|total)|amount\\s*payable|invoice\\s*total|bill\\s*(?:total|amount)|total\\s*(?:amount|payable|due)|balance\\s*due|total)';
    const known = new RegExp('\\b(' + names + ')(?=$|[^A-Za-z0-9])\\s*[:：=#-]?\\s*', 'ig');
    for (const line of String(text || '').split(/\r?\n/)) {
      const matches = Array.from(line.matchAll(known));
      for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        const preceding = match.index ? line[match.index - 1] : '';
        if (preceding && /[A-Za-z]/.test(preceding)) continue;
        const value = line.slice(match.index + match[0].length, matches[index + 1] ? matches[index + 1].index : undefined).trim();
        if (value) fields.push({ label: match[1], value });
      }
      const custom = line.match(/^\s*([^:：]{2,60})\s*[:：]\s*(\S.*?)\s*$/);
      if (custom && !matches.some(match => key(match[1]) === key(custom[1]))) fields.push({ label: custom[1].trim(), value: custom[2].trim() });
    }
    return fields;
  }

  function tablesFromText(text) {
    const tables = [];
    let rows = [], delimiter = '';
    const flush = () => {
      if (rows.length >= 2 && rows.some(row => headerScore(row))) tables.push(tableFromRows('Extracted table ' + (tables.length + 1), rows, { source: 'text' }));
      rows = []; delimiter = '';
    };
    for (const line of String(text || '').replace(/\r/g, '').split('\n')) {
      const mode = line.includes('\t') ? 'tab' : /\|/.test(line) ? 'pipe' : /\S\s{2,}\S/.test(line) ? 'space' : '';
      if (!mode) { flush(); continue; }
      if (delimiter && delimiter !== mode) flush();
      delimiter = mode;
      let row = mode === 'tab' ? line.split('\t') : mode === 'pipe' ? line.split('|') : line.trim().split(/\s{2,}/);
      if (mode === 'pipe') { if (!row[0].trim()) row.shift(); if (!row[row.length - 1].trim()) row.pop(); }
      row = row.map(value => value.trim());
      if (!row.every(value => /^[-:]+$/.test(value))) rows.push(row);
    }
    flush();
    return tables;
  }

  function fromText(text, options) {
    options = options || {};
    const result = baseResult();
    result.rawText = String(text || '');
    result.tables = options.tables && options.tables.length ? options.tables : tablesFromText(text);
    result.billCategory = detectBillCategory(result.rawText);
    const fields = [...textFields(text), ...fieldsFromTables(result.tables), ...(options.fields || [])];
    const fieldKeys = new Set();
    result.fields = fields.filter(field => {
      const id = key(field.label) + '\u0000' + cellString(field.value);
      if (fieldKeys.has(id)) return false;
      fieldKeys.add(id); return true;
    });
    const currencyText = [result.rawText, options.currencyEvidence || ''].join('\n');
    const currencies = unique((currencyText.match(/\b(?:INR|USD|EUR|GBP|AUD|CAD|SGD|AED|JPY|CNY|NZD|CHF|SAR|KWD|QAR|BDT|PKR|LKR|NPR|MYR|ZAR|THB|IDR|HKD)\b/gi) || []).map(value => value.toUpperCase()));
    for (const field of result.fields) if (key(field.label) === 'currency' && /^[A-Z]{3}$/i.test(cellString(field.value).trim())) currencies.push(cellString(field.value).trim().toUpperCase());
    if (/₹|\bRs\.?\s*\d|\b(?:indian\s+)?rupees\b/i.test(currencyText)) currencies.push('INR');
    if (/€/.test(currencyText)) currencies.push('EUR');
    if (/£/.test(currencyText)) currencies.push('GBP');
    if (/\$/.test(currencyText) && !currencies.some(currency => ['USD', 'AUD', 'CAD', 'SGD', 'NZD', 'HKD'].includes(currency))) currencies.push('USD');
    const ambiguousCurrency = /[¥₩₽₺₴₦₱₫₪]/.test(currencyText) && !currencies.some(currency => currency !== 'INR')
      || result.fields.some(field => key(field.label) === 'currency' && present(field.value) && !/^(?:[A-Z]{3}|₹|Rs\.?|(?:Indian\s+)?rupees)$/i.test(cellString(field.value).trim()));
    const currencyCodes = unique(currencies);
    result.currency = currencyCodes.length === 1 && !ambiguousCurrency ? currencyCodes[0] : '';
    result.currencyConflict = currencyCodes.length > 1 || ambiguousCurrency;
    if (currencyCodes.length > 1) result.warnings.push('Multiple currencies were found. Confirm one bill currency; amounts have not been converted.');
    if (ambiguousCurrency) result.warnings.push('Currency is ambiguous. Confirm the printed currency; this bill cannot be saved as INR.');
    if (!currencyCodes.length && !ambiguousCurrency) result.warnings.push('No currency was printed. Confirm that this bill uses Indian rupees (INR) before saving.');
    if (currencyCodes.length === 1 && result.currency !== 'INR') result.warnings.push('This bill uses ' + result.currency + '. Only Indian rupee (INR) bills can be saved; amounts have not been converted.');
    const totals = [];
    const identity = { vendor: [], bill_number: [], bill_date: [] };
    for (const field of result.fields) {
      const kind = kindOf(field.label);
      if (Object.prototype.hasOwnProperty.call(identity, kind)) {
        const value = kind === 'bill_date' ? normalizeDate(field.value) : cellString(field.value).trim();
        if (value) identity[kind].push(value);
      }
      if (summaryKind(field.label) === 'total') {
        const amount = parseMoney(field.value);
        if (amount !== null) totals.push({ amount, priority: /^(?:grand|net|amount payable|invoice|bill|total payable)/i.test(field.label) ? 2 : 1 });
      }
    }
    for (const [name, values] of Object.entries(identity)) {
      const distinct = unique(values);
      if (distinct.length === 1) result[name] = distinct[0];
      if (distinct.length > 1) result.warnings.push('Multiple ' + name.replace(/_/g, ' ') + ' values were found. Select the correct value before saving.');
    }
    if (!result.vendor && !identity.vendor.length) {
      const firstLines = result.rawText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).slice(0, 6);
      const likely = firstLines.find(line => /\b(?:hospital|pharmacy|medical(?:s| centre| center)?|clinic|laborator(?:y|ies)|diagnostic(?:s)?)\b/i.test(line)
        && !/[:：\t]|\s{2,}|\b(?:invoice|bill|patient|date|address|gstin)\b/i.test(line) && line.length <= 120);
      if (likely) { result.vendor = likely; result.warnings.push('The vendor was inferred from the heading. Confirm it before saving.'); }
    }
    if (totals.length) {
      const priority = Math.max(...totals.map(total => total.priority));
      const amounts = unique(totals.filter(total => total.priority === priority).map(total => total.amount));
      if (amounts.length === 1) result.total = amounts[0];
      else result.warnings.push('Conflicting totals were found. Enter the correct bill total before saving.');
    }
    result.items = itemsFromTables(result.tables);
    if (result.total === null) result.warnings.push('No unambiguous bill total was found. Enter it before saving.');
    if (!result.bill_date) result.warnings.push('The bill date needs to be entered or confirmed.');
    if (!result.items.length) result.warnings.push('Item columns could not be mapped confidently. Review the original data and add items if needed.');
    else if (result.items.some(item => item.quantity === null || item.rate === null || item.amount === null)) result.warnings.push('Some item quantities, rates or amounts could not be read. Missing values were left blank for review.');
    if (result.tables.some(table => new Set(table.columns.map(kindOf).filter(kind => kind === 'amount')).size && table.columns.filter(column => kindOf(column) === 'amount').length > 1)) {
      result.warnings.push('More than one amount column was found. Item amounts need manual confirmation.');
    }
    if (result.total !== null && result.items.length && result.items.every(item => item.amount !== null)) {
      const sum = round(result.items.reduce((total, item) => total + item.amount, 0));
      if (Math.abs(sum - result.total) > 1) result.warnings.push('The item sum differs from the bill total. Check taxes, discounts and missing rows.');
    }
    const score = (result.vendor ? 15 : 0) + (result.bill_number ? 15 : 0) + (result.bill_date ? 20 : 0) + (result.total !== null ? 30 : 0) + (result.items.length ? 15 : 0);
    result.confidence = Math.round(Math.min(95, typeof options.confidence === 'number' ? Math.min(score, options.confidence) : score));
    result.warnings = unique([...result.warnings, ...(options.warnings || [])]);
    return result;
  }

  function columnNumber(letters) {
    return letters.toUpperCase().split('').reduce((value, letter) => value * 26 + letter.charCodeAt(0) - 64, 0) - 1;
  }
  function columnName(index) {
    let name = '';
    for (index += 1; index > 0; index = Math.floor((index - 1) / 26)) name = String.fromCharCode(65 + (index - 1) % 26) + name;
    return name;
  }
  function decodeRange(ref) {
    const parts = String(ref || '').replace(/\$/g, '').split(':');
    const decode = part => { const match = part.match(/^([A-Za-z]+)(\d+)$/); return match ? { c: columnNumber(match[1]), r: +match[2] - 1 } : null; };
    const start = decode(parts[0]), end = decode(parts[1] || parts[0]);
    if (!start || !end || start.c > end.c || start.r > end.r) throw new Error('The worksheet range is invalid. Export a fresh copy and try again.');
    return { start, end };
  }

  function spreadsheetCurrencyEvidence(cell, value) {
    if (!cell || typeof value !== 'number' || !Number.isFinite(value) || cell.t === 'd') return '';
    const display = typeof cell.w === 'string' ? cell.w : '';
    if (typeof cell.z !== 'string') return display;
    // Only numeric format sections apply here. A text-only currency label or a locale
    // marker such as [$-409] does not establish a currency for a numeric cell.
    const sections = [''];
    let quoted = false;
    for (let index = 0; index < cell.z.length; index++) {
      const character = cell.z[index];
      if (character === '\\' && index + 1 < cell.z.length) { sections[sections.length - 1] += character + cell.z[++index]; continue; }
      if (character === '"') quoted = !quoted;
      if (character === ';' && !quoted) sections.push('');
      else sections[sections.length - 1] += character;
    }
    const numeric = sections.slice(0, 3);
    const condition = section => {
      const match = section.match(/\[(<=|>=|<>|=|<|>)(-?\d+(?:\.\d+)?)\]/);
      if (!match) return null;
      const limit = Number(match[2]);
      return { '<': value < limit, '>': value > limit, '<=': value <= limit, '>=': value >= limit, '=': value === limit, '<>': value !== limit }[match[1]];
    };
    let selected;
    if (numeric.some(section => condition(section) !== null)) selected = numeric.find(section => condition(section) === true) || numeric.find(section => condition(section) === null) || '';
    else selected = numeric[value < 0 && numeric.length > 1 ? 1 : value === 0 && numeric.length > 2 ? 2 : 0] || '';
    const format = selected.replace(/\[\$-([^\]]+)\]/g, '').replace(/\[\$([^\]-]+)(?:-[^\]]*)?\]/g, ' $1 ')
      .replace(/\[[^\]]*\]/g, '').replace(/_.|\*./g, '').replace(/\\(.)/g, '$1').replace(/"/g, '').replace(/[#?]/g, '0');
    return display + '\n' + format;
  }

  function fromWorkbook(workbook, options) {
    options = options || {};
    const tables = [], warnings = [], currencyEvidence = [];
    let cellCount = 0;
    for (const name of workbook.SheetNames || []) {
      const sheet = workbook.Sheets[name];
      if (!sheet || !sheet['!ref']) continue;
      const { start, end } = decodeRange(sheet['!ref']);
      cellCount += (end.r - start.r + 1) * (end.c - start.c + 1);
      if (cellCount > (options.maxCells || LIMITS.maxCells)) throw new Error('This workbook exceeds the 300,000 cell limit. Split it into smaller workbooks; no partial data was imported.');
      const rows = [], formulas = {};
      for (let r = start.r; r <= end.r; r++) {
        const row = [];
        for (let c = start.c; c <= end.c; c++) {
          const address = columnName(c) + (r + 1), cell = sheet[address];
          if (cell && cell.f) formulas[address] = cell.f;
          if (cell && cell.f && cell.v == null) warnings.push('A formula on ' + name + ' has no cached value. Recalculate and save the workbook, or enter that value manually.');
          let value = cell && cell.v != null ? cell.v : '';
          if (cell && cell.t === 'e') { value = cell.w || '#ERROR'; warnings.push('A spreadsheet cell contains an error. Review the original worksheet.'); }
          const currency = spreadsheetCurrencyEvidence(cell, value);
          if (currency) currencyEvidence.push(currency);
          row.push(value);
        }
        rows.push(row);
      }
      tables.push(tableFromRows(name, rows, { source: 'spreadsheet', sourceRange: sheet['!ref'], formulas }));
    }
    if (!tables.length) throw new Error('This workbook contains no readable cells.');
    const text = tables.map(table => '[' + table.name + ']\n' + table.sourceRows.map(row => row.map(cellString).join('\t')).join('\n')).join('\n\n');
    const result = fromText(text, { tables, warnings, currencyEvidence: currencyEvidence.join('\n') });
    if (tables.length > 1) result.warnings.push('All ' + tables.length + ' worksheets were imported. Confirm that they belong to one bill before saving.');
    return result;
  }

  function parseCSV(text) {
    const rows = [], row = [];
    let value = '', quoted = false;
    text = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i <= text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { value += '"'; i++; }
        else if (char === '"') quoted = false;
        else if (char === undefined) throw new Error('The CSV has an unterminated quoted cell. Export it again and retry.');
        else value += char;
      } else if (char === '"' && value === '') quoted = true;
      else if (char === ',') { row.push(value); value = ''; }
      else if (char === '\n' || char === '\r' || char === undefined) {
        row.push(value); rows.push(row.splice(0)); value = '';
        if (char === '\r' && text[i + 1] === '\n') i++;
        if (char === undefined) break;
      } else value += char;
    }
    if (/[\r\n]$/.test(text) && rows.length && rows[rows.length - 1].every(value => value === '')) rows.pop();
    return rows;
  }

  function groupLines(tokens) {
    const lines = [];
    for (const token of tokens.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
      const cy = (token.y0 + token.y1) / 2, height = Math.max(1, token.y1 - token.y0);
      let line = lines.find(line => Math.abs(line.cy - cy) <= Math.min(line.height, height) * 0.45);
      if (!line) { line = { cy, height, tokens: [] }; lines.push(line); }
      line.tokens.push(token);
    }
    return lines.sort((a, b) => a.cy - b.cy).map(line => ({ tokens: line.tokens.sort((a, b) => a.x0 - b.x0) }));
  }

  function mergeHeaderTokens(tokens) {
    const cells = [];
    for (let index = 0; index < tokens.length; index++) {
      let count = 1;
      for (let size = Math.min(4, tokens.length - index); size > 1; size--) {
        if (kindOf(tokens.slice(index, index + size).map(token => token.text).join(' '))) { count = size; break; }
      }
      const group = tokens.slice(index, index + count);
      cells.push({ text: group.map(token => token.text).join(' '), x0: group[0].x0, x1: group[group.length - 1].x1 });
      index += count - 1;
    }
    return cells;
  }

  function splitPositionedTokens(tokens) {
    return tokens.flatMap(token => {
      const text = token.text;
      if (kindOf(text) || !/\s/.test(text)) return [token];
      const words = Array.from(text.matchAll(/\S+/g));
      if (!/\s{2,}/.test(text) && words.filter(word => kindOf(word[0])).length < 2) return [token];
      const unit = (token.x1 - token.x0) / Math.max(1, text.length);
      return words.map(word => Object.assign({}, token, { text: word[0], x0: token.x0 + word.index * unit, x1: token.x0 + (word.index + word[0].length) * unit }));
    });
  }

  function tablesFromLines(lines, metadata) {
    lines = lines.map(line => ({ tokens: splitPositionedTokens(line.tokens) }));
    const tables = [];
    for (let index = 0; index < lines.length; index++) {
      const cells = mergeHeaderTokens(lines[index].tokens);
      const knownHeader = headerScore(cells.map(cell => cell.text));
      const nextTokens = lines[index + 1] && lines[index + 1].tokens || [];
      const genericHeader = cells.length >= 3 && cells.every(cell => parseMoney(cell.text) === null)
        && nextTokens.length >= 3 && nextTokens.some(token => parseMoney(token.text) !== null);
      if (!knownHeader && !genericHeader) continue;
      const rows = [];
      let next = index + 1;
      for (; next < lines.length; next++) {
        const line = lines[next];
        if (headerScore(mergeHeaderTokens(line.tokens).map(token => token.text))) break;
        const plain = line.tokens.map(token => token.text).join(' ');
        if (/^(?:grand\s*total|net\s*(?:amount|total|payable)|sub\s*total|amount\s*payable|total|cgst|sgst|igst|discount|round\s*off)\b/i.test(plain.trim())) break;
        const row = Array(cells.length).fill('');
        for (const token of line.tokens) {
          const center = (token.x0 + token.x1) / 2;
          let column = 0;
          while (column < cells.length - 1 && center > (cells[column].x1 + cells[column + 1].x0) / 2) column++;
          row[column] += (row[column] ? ' ' : '') + token.text;
        }
        if (row.some(present)) rows.push(row);
      }
      if (rows.length) tables.push(tableFromRows('Page ' + ((metadata && metadata.page) || 1) + ' table ' + (tables.length + 1), [cells.map(cell => cell.text), ...rows], Object.assign({ inferredHeader: !knownHeader }, metadata)));
      index = Math.max(index, next - 1);
    }
    return tables;
  }

  function progress(callback, status, percent) {
    if (typeof callback === 'function') callback({ status, progress: Math.max(0, Math.min(100, percent)) });
  }

  function withTimeout(promise, milliseconds, message) {
    let timer;
    return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), milliseconds); })]).finally(() => clearTimeout(timer));
  }

  async function readOCR(input, onProgress, start, end) {
    if (!root.Tesseract) throw new Error('The image reader did not load. Check your internet connection and reload.');
    let worker;
    try {
      const pendingWorker = root.Tesseract.createWorker('eng', 1, { logger: message => {
        progress(onProgress, message.status || 'Reading image', start + (end - start) * (message.progress || 0));
      } });
      try { worker = await withTimeout(pendingWorker, 150000, 'The image reader took too long to load. Check your connection and retry.'); }
      catch (error) { Promise.resolve(pendingWorker).then(lateWorker => lateWorker.terminate()).catch(() => {}); throw error; }
      await withTimeout(worker.setParameters({ preserve_interword_spaces: '1', user_defined_dpi: '300' }), 30000, 'The image reader did not initialize in time. Please retry.');
      const recognized = await withTimeout(worker.recognize(input), 150000, 'Reading the image took too long. Try a clearer image.');
      const data = recognized.data || {};
      const tokens = (data.words || (data.lines || []).flatMap(line => line.words || [])).filter(word => word.text && word.bbox).map(word => ({
        text: word.text, x0: word.bbox.x0, x1: word.bbox.x1, y0: word.bbox.y0, y1: word.bbox.y1
      }));
      return { text: data.text || '', confidence: Number(data.confidence) || 0, lines: groupLines(tokens) };
    } finally {
      if (worker) await worker.terminate().catch(() => {});
    }
  }

  async function hasLargePageImage(page, viewport) {
    const ops = root.pdfjsLib.OPS;
    if (!ops || typeof page.getOperatorList !== 'function') return false;
    const list = await withTimeout(page.getOperatorList(), 30000, 'PDF page images could not be inspected in time. Try another copy.');
    let area = 1;
    const stack = [];
    const determinant = matrix => Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]);
    const imageOps = new Set([ops.paintImageXObject, ops.paintInlineImageXObject, ops.paintImageMaskXObject].filter(value => value !== undefined));
    for (let index = 0; index < list.fnArray.length; index++) {
      const operation = list.fnArray[index], args = list.argsArray[index];
      if (operation === ops.save || operation === ops.paintFormXObjectBegin) {
        stack.push(area);
        if (operation === ops.paintFormXObjectBegin && args && args[0]) area *= determinant(args[0]);
      } else if (operation === ops.restore || operation === ops.paintFormXObjectEnd) area = stack.length ? stack.pop() : 1;
      else if (operation === ops.transform) area *= determinant(args);
      else if (imageOps.has(operation) && area >= viewport.width * viewport.height * 0.25) return true;
    }
    return false;
  }

  async function extractPDF(file, onProgress) {
    if (!root.pdfjsLib) throw new Error('The PDF reader did not load. Check your connection and reload.');
    if (!root.pdfjsLib.GlobalWorkerOptions.workerSrc) root.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
    // Mitigates PDF.js CVE-2024-4367 while the pinned reader remains on v3.
    const task = root.pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    let pdf;
    try {
      pdf = await withTimeout(task.promise, 30000, 'This PDF could not be opened in time. Try another copy.');
      if (pdf.numPages > LIMITS.maxPages) throw new Error('This PDF has ' + pdf.numPages + ' pages. The limit is 30; split it into smaller files. No partial data was imported.');
      const pages = [], tables = [], confidences = [], warnings = [];
      for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
        const start = 5 + (pageNumber - 1) / pdf.numPages * 90, end = 5 + pageNumber / pdf.numPages * 90;
        progress(onProgress, 'Reading PDF page ' + pageNumber + ' of ' + pdf.numPages, start);
        const page = await withTimeout(pdf.getPage(pageNumber), 30000, 'PDF page ' + pageNumber + ' could not be opened. Try another copy.');
        try {
          const viewport = page.getViewport({ scale: 1 });
          const content = await withTimeout(page.getTextContent(), 30000, 'PDF page ' + pageNumber + ' could not be read. Try another copy.');
          const tokens = content.items.filter(item => item.str && item.str.trim()).map(item => {
            const height = Math.abs(item.height || item.transform[3]) || 10;
            return { text: item.str.trim(), x0: item.transform[4], x1: item.transform[4] + item.width,
              y0: viewport.height - item.transform[5] - height, y1: viewport.height - item.transform[5] };
          });
          let lines = groupLines(tokens), text = lines.map(line => line.tokens.map(token => token.text).join('  ')).join('\n'), source = 'pdf';
          // Even a long embedded watermark can sit over the actual scanned bill.
          const largeImage = text.replace(/\s/g, '').length >= 60 && await hasLargePageImage(page, viewport);
          if (text.replace(/\s/g, '').length < 60 || largeImage) {
            const scale = Math.min(3, 2400 / viewport.width, Math.sqrt(12000000 / (viewport.width * viewport.height)));
            const rendered = page.getViewport({ scale });
            const canvas = root.document.createElement('canvas');
            canvas.width = Math.ceil(rendered.width); canvas.height = Math.ceil(rendered.height);
            try {
              const context = canvas.getContext('2d');
              context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
              const render = page.render({ canvasContext: context, viewport: rendered });
              try { await withTimeout(render.promise, 30000, 'PDF page rendering took too long. Try another copy.'); }
              catch (error) { if (render.cancel) render.cancel(); throw error; }
              const ocr = await readOCR(canvas, onProgress, start, end);
              text = ocr.text; lines = ocr.lines; source = 'ocr'; confidences.push(ocr.confidence);
              if (ocr.confidence < 70) warnings.push('Text on page ' + pageNumber + ' was difficult to read. Check its values carefully.');
              if (largeImage) warnings.push('Page ' + pageNumber + ' contains a large image. Its full rendered contents were read with OCR; review the extracted values.');
            } finally { canvas.width = 0; canvas.height = 0; }
          }
          if (!text.trim()) warnings.push('Page ' + pageNumber + ' contained no readable text. Review the original page.');
          pages.push('[Page ' + pageNumber + ']\n' + text);
          tables.push(...tablesFromLines(lines, { source, page: pageNumber }));
        } finally { page.cleanup(); }
        progress(onProgress, 'Read PDF page ' + pageNumber + ' of ' + pdf.numPages, end);
      }
      const result = fromText(pages.join('\n\n'), { tables, confidence: confidences.length ? Math.min(...confidences) : undefined, warnings });
      result.warnings.push('All ' + pdf.numPages + ' PDF pages were read. Confirm that they belong to one bill.');
      return result;
    } finally {
      if (pdf) await pdf.destroy();
      else if (task.destroy) await task.destroy();
    }
  }

  function fileKind(file) {
    const name = String(file && file.name || '').toLowerCase(), type = String(file && file.type || '').toLowerCase().split(';')[0].trim();
    // SVG is active document content, including when its filename claims to be a photo.
    if (/\.svgz?$/.test(name) || /svg/.test(type)) return '';
    if (/^image\//.test(type)) return /^image\/(?:jpe?g|pjpeg|png|webp|gif|bmp|x-ms-bmp)$/.test(type) ? 'image' : '';
    if (/\.(csv|xlsx|xls)$/.test(name) || /csv|spreadsheet|excel/.test(type)) return 'sheet';
    if (type === 'application/pdf' || /\.pdf$/.test(name)) return 'pdf';
    if ((!type || type === 'application/octet-stream') && /\.(png|jpe?g|webp|bmp|gif)$/.test(name)) return 'image';
    return '';
  }

  async function extract(file, options) {
    options = options || {};
    if (!file || typeof file.arrayBuffer !== 'function') throw new Error('Choose a file to upload.');
    if (file.size > LIMITS.maxBytes) throw new Error('The file exceeds the 20 MB limit. Choose a smaller file.');
    if (/\.(?:tiff?|heic|heif)$/i.test(String(file.name || '')) || /^image\/(?:tiff?|x-tiff|heic|heif)(?:;|$)/i.test(String(file.type || ''))) throw new Error('Convert TIFF, HEIC or HEIF to JPG, PNG or PDF before reading this bill.');
    const kind = fileKind(file);
    if (!kind) throw new Error('Choose a raster image (JPG, PNG, WebP, non-animated GIF or BMP), PDF, Excel workbook (.xlsx/.xls), or CSV file.');
    const name = String(file.name || '').toLowerCase(), type = String(file.type || '').toLowerCase();
    const onProgress = options.onProgress;
    progress(onProgress, 'Opening file', 2);
    let result;
    if (/\.csv$/.test(name) || /csv/.test(type)) {
      const rows = parseCSV(await file.text());
      if (rows.reduce((count, row) => count + row.length, 0) > LIMITS.maxCells) throw new Error('The CSV exceeds the 300,000 cell limit. Split it into smaller files.');
      const table = tableFromRows('CSV data', rows, { source: 'spreadsheet' });
      result = fromText(rows.map(row => row.join('\t')).join('\n'), { tables: [table] });
    } else if (/\.(xlsx|xls)$/.test(name) || /spreadsheet|excel/.test(type)) {
      if (!root.XLSX) throw new Error('The spreadsheet reader did not load. Check your connection and reload.');
      const workbook = root.XLSX.read(await file.arrayBuffer(), { type: 'array', raw: true, cellDates: true, cellNF: true });
      result = fromWorkbook(workbook);
    } else if (kind === 'pdf') result = await extractPDF(file, onProgress);
    else if (kind === 'image') {
      const ocr = await readOCR(file, onProgress, 5, 95);
      result = fromText(ocr.text, { tables: tablesFromLines(ocr.lines, { source: 'ocr', page: 1 }), confidence: ocr.confidence,
        warnings: ['Text was read from an image. Confirm every amount before saving.'] });
    } else throw new Error('Choose an image, PDF, Excel workbook (.xlsx/.xls), or CSV file.');
    if (!result.rawText.trim() && !result.tables.some(table => table.rows.some(row => row.some(present)))) throw new Error('No readable data was found. Try a clearer file or enter the details manually.');
    progress(onProgress, 'Ready for review', 100);
    return result;
  }

  return Object.freeze({ extract, fromText, fromWorkbook, parseMoney, normalizeDate, parseCSV, tableFromRows, tablesFromLines, groupLines, itemsFromTables, fileKind, detectBillCategory, BILL_CATEGORIES, LIMITS });
});
