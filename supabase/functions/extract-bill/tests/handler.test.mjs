// Offline contract/security tests. No credentials, provider calls or package installs.
// Run: node --experimental-vm-modules supabase/functions/extract-bill/tests/handler.test.mjs
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";

const source = await readFile(new URL("../index.ts", import.meta.url), "utf8");
const settings = new Map([
  ["SUPABASE_URL", "https://example.supabase.test"],
  ["SUPABASE_ANON_KEY", "public-test-key"],
  ["OPENAI_API_KEY", "server-secret-test"],
  ["AI_ALLOWED_ORIGINS", "https://bills.example.test,http://localhost:8000"],
]);
let authCalls = 0;
let providerCalls = 0;
let authFailure = false;
let providerStatus = 200;
let providerBody;
let sent;
let simulateAiTimeout = false;
let simulateAuthTimeout = false;
let handler;

function fixture() {
  return {
    vendor: "Test Pharmacy", bill_number: "INV-00007", bill_date: "2026-10-18", bill_category: "pharmacy",
    total: 92, items: [{ description: "Product", quantity: 2, rate: null, amount: 92 }],
    confidence: 83, rawText: "Invoice INV-00007\nTotal INR 92",
    tables: [{ name: "Items", columns: ["Code", "Description", "Batch", "Expiry", "Qty", "Unit", "MRP", "Tax", "Discount", "Amount"], rows: [["00017", "Product", "B04", "05/2027", "2", "TAB", "50.00", "5%", "8.00", "92.00"]] }],
    fields: [{ label: "GSTIN", value: "33TEST0001" }, { label: "Patient Name", value: "Anu" }, { label: "UHID", value: "00017" }, { label: "IP No", value: "IP-0012" }, { label: "Admission Date", value: "17/10/2026 09:35" }, { label: "Discharge Date", value: "18/10/2026 16:00" }], currency: "INR", warnings: [],
  };
}
function completed(bill = fixture()) {
  return { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(bill) }] }] };
}
function reset() {
  authFailure = false; providerStatus = 200; providerBody = completed(); sent = undefined;
  simulateAiTimeout = false; simulateAuthTimeout = false; authCalls = 0; providerCalls = 0;
  settings.set("OPENAI_API_KEY", "server-secret-test");
}
const context = vm.createContext({
  Request, Response, Headers, FormData, File, Uint8Array, TextDecoder, AbortController,
  setTimeout: (fn, ms) => setTimeout(fn, (simulateAiTimeout && ms === 90000) || (simulateAuthTimeout && ms === 10000) ? 2 : ms),
  clearTimeout, btoa,
  Deno: { env: { get: (key) => settings.get(key) }, serve: (fn) => { handler = fn; } },
  fetch: async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    providerCalls++;
    sent = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, "Bearer server-secret-test");
    if (simulateAiTimeout) {
      return await new Promise((_, reject) => options.signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
    }
    return Response.json(providerBody, { status: providerStatus });
  },
});
const supabase = new vm.SyntheticModule(["createClient"], function () {
  this.setExport("createClient", (url, key, options) => {
    assert.equal(url, settings.get("SUPABASE_URL"));
    assert.equal(key, "public-test-key");
    assert.equal(options.auth.persistSession, false);
    return { auth: { getUser: async (jwt) => {
      authCalls++;
      assert.equal(jwt, "signed-user-jwt");
      if (simulateAuthTimeout) return await new Promise(() => {});
      return authFailure ? { data: { user: null }, error: { status: 401 } } : { data: { user: { id: "user-1" } }, error: null };
    } } };
  });
}, { context });
const module = new vm.SourceTextModule(stripTypeScriptTypes(source, { mode: "transform" }), { context });
await module.link((specifier) => {
  assert.equal(specifier, "npm:@supabase/supabase-js@2.118.0");
  return supabase;
});
await module.evaluate();
assert.equal(typeof handler, "function");

function upload({ bytes = [255, 216, 255, 0], type = "image/jpeg", name = "bill.jpg", token = true, origin = "https://bills.example.test", duplicate = false, extraHeaders = {} } = {}) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array(bytes)], name, { type }));
  if (duplicate) form.append("file", new File(["extra"], "extra.txt"));
  return new Request("https://example.supabase.test/functions/v1/extract-bill", {
    method: "POST", headers: { ...(origin ? { Origin: origin } : {}), ...(token ? { Authorization: "Bearer signed-user-jwt" } : {}), apikey: "public-test-key", ...extraHeaders }, body: form,
  });
}
async function expectError(request, status, code) {
  const response = await handler(request);
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.code, code);
  assert.equal(typeof body.error, "string");
  assert.equal(JSON.stringify(body).includes("server-secret-test"), false);
  return response;
}

reset();
let response = await handler(new Request("https://example.test", { method: "OPTIONS", headers: { Origin: "https://bills.example.test", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, apikey, content-type" } }));
assert.equal(response.status, 204);
assert.equal(response.headers.get("access-control-allow-origin"), "https://bills.example.test");
assert.equal(authCalls + providerCalls, 0);
await expectError(upload({ origin: "https://hostile.example" }), 403, "origin_not_allowed");
await expectError(upload({ origin: "null" }), 403, "origin_not_allowed");
await expectError(upload({ token: false }), 401, "unauthenticated");
assert.equal(authCalls + providerCalls, 0);
authFailure = true;
await expectError(upload(), 401, "unauthenticated");
assert.equal(providerCalls, 0);

reset();
response = await handler(upload());
assert.equal(response.status, 200);
let result = await response.json();
assert.equal(result.extraction_method, "ai");
assert.deepEqual(result.tables[0], fixture().tables[0]);
assert.equal(result.items[0].rate, null);
assert.equal(result.total, 92);
assert.equal(result.bill_category, "pharmacy");
assert.deepEqual(result.fields, fixture().fields);
assert.equal(sent.store, false);
assert.equal(sent.model, "gpt-4.1-mini");
assert.equal(sent.text.format.strict, true);
assert.equal(sent.input[0].content[1].type, "input_image");
assert.ok(sent.input[0].content[1].image_url.startsWith("data:image/jpeg;base64,"));
assert.equal(JSON.stringify(sent.input).includes('file_id'), false);
assert.deepEqual(sent.text.format.schema.properties.bill_category.enum, ['pharmacy', 'medical_stock', 'patient', 'discharge', 'outpatient', 'inpatient', 'laboratory', 'diagnostics', 'procedure', 'emergency', 'other']);
assert.ok(sent.text.format.schema.required.includes('bill_category'));
assert.match(sent.instructions, /UHID\/MRN/);
assert.match(sent.instructions, /Never silently label foreign amounts INR/);
assert.equal(response.headers.get("cache-control"), "no-store");

response = await handler(upload({ bytes: [37, 80, 68, 70, 45, 49], type: "application/pdf", name: "private-name.pdf" }));
assert.equal(response.status, 200);
assert.equal(sent.input[0].content[1].type, "input_file");
assert.equal(sent.input[0].content[1].filename, "bill.pdf");
assert.ok(sent.input[0].content[1].file_data.startsWith("data:application/pdf;base64,"));
assert.equal(JSON.stringify(sent).includes('private-name.pdf'), false);
assert.equal(JSON.stringify(sent).includes('file_id'), false);

reset();
const uncertain = fixture();
uncertain.total = null; uncertain.currency = ""; uncertain.rawText = "Invoice INV-00007\nTotal 92"; uncertain.bill_date = "2026-02-30";
providerBody = completed(uncertain);
response = await handler(upload());
result = await response.json();
assert.equal(result.total, null);
assert.equal(result.currency, "");
assert.equal(result.bill_date, "");
assert.ok(result.warnings.some((warning) => warning.includes("grand total")));
assert.ok(result.warnings.some((warning) => warning.includes("Currency")));
const foreign = fixture(); foreign.currency = "EUR"; foreign.rawText = "Invoice INV-00007\nTotal EUR 92";
providerBody = completed(foreign);
assert.equal((await (await handler(upload())).json()).currency, "EUR");
const mixed = fixture(); mixed.rawText += "\nForeign subtotal EUR 10";
providerBody = completed(mixed);
const mixedResult = await (await handler(upload())).json();
assert.equal(mixedResult.currency, "");
assert.equal(mixedResult.currencyConflict, true);
assert.ok(mixedResult.warnings.some(warning => /Multiple currencies/.test(warning)));
const ambiguous = fixture(); ambiguous.currency = ''; ambiguous.rawText = 'Invoice\nTotal ¥92';
providerBody = completed(ambiguous);
assert.equal((await (await handler(upload())).json()).currencyConflict, true);
for (const category of sent.text.format.schema.properties.bill_category.enum) {
  const categorized = fixture(); categorized.bill_category = category;
  providerBody = completed(categorized);
  assert.equal((await (await handler(upload())).json()).bill_category, category);
}
const invalidCategory = fixture(); invalidCategory.bill_category = 'general_retail';
providerBody = completed(invalidCategory);
await expectError(upload(), 502, "invalid_ai_result");
const shifted = fixture(); shifted.tables[0].rows[0].pop();
providerBody = completed(shifted);
await expectError(upload(), 502, "invalid_ai_result");

reset();
await expectError(upload({ duplicate: true }), 400, "file_required");
await expectError(upload({ bytes: [80, 75, 3, 4], type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", name: "sheet.xlsx" }), 415, "unsupported_file");
await expectError(upload({ type: "application/pdf" }), 415, "unsupported_file");
await expectError(upload({ extraHeaders: { "Content-Length": String(21 * 1024 * 1024) } }), 413, "file_too_large");
let chunkCount = 0;
const chunk = new Uint8Array(64 * 1024);
await expectError(new Request("https://example.supabase.test/functions/v1/extract-bill", {
  method: "POST", duplex: "half",
  headers: { Authorization: "Bearer signed-user-jwt", "Content-Type": "multipart/form-data; boundary=test", Origin: "https://bills.example.test" },
  body: new ReadableStream({ pull(controller) { if (++chunkCount <= 322) controller.enqueue(chunk); else controller.close(); } }),
}), 413, "file_too_large");
assert.equal(providerCalls, 0);
settings.delete("OPENAI_API_KEY");
await expectError(upload(), 503, "ai_not_configured");
assert.equal(providerCalls, 0);

reset();
providerStatus = 429; providerBody = { secret: "server-secret-test" };
response = await expectError(upload(), 429, "ai_rate_limited");
assert.equal(response.headers.get("retry-after"), "30");
providerStatus = 401;
await expectError(upload(), 503, "ai_not_configured");
providerStatus = 500;
await expectError(upload(), 502, "ai_provider_error");
providerStatus = 200; providerBody = { status: "incomplete", output: [] };
await expectError(upload(), 422, "ai_incomplete");
providerBody = { status: "completed", output: [{ content: [{ type: "refusal", refusal: "sensitive original contents" }] }] };
await expectError(upload(), 422, "ai_refused");
providerBody = { status: "completed", output: [{ content: [{ type: "output_text", text: "malformed" }] }] };
await expectError(upload(), 502, "invalid_ai_result");
simulateAiTimeout = true;
await expectError(upload(), 504, "ai_timeout");
reset();
simulateAuthTimeout = true;
await expectError(upload(), 504, "auth_timeout");
assert.equal(providerCalls, 0);

console.log("PASS: authentication and origin gates; hospital categories and patient fields; exact arbitrary columns; transient inline image/PDF contracts and store:false; nullable values, dates and INR/foreign/mixed currencies; malformed/oversized files; incomplete/refused/invalid output; provider errors and timeout. All provider calls were mocked.");
