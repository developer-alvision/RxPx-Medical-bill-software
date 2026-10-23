# Optional AI bill extraction

The application can read Excel/CSV directly and use local OCR without this function. Deploy this function to add layout-aware extraction for hospital-related photographed bills and PDFs with arbitrary columns. It returns a review draft; it never saves a source file, saves a bill, or writes to the database. Source bytes are sent inline to the extraction request, with no persistent file upload or file ID. The application saves only reviewed data and records bills in Indian rupees (INR). Every request needs a valid signed-in Supabase user access token. `auth.getUser(token)` verifies the caller with Supabase Auth before any file is processed or paid API request is made.

## Configure and deploy

1. Install the Supabase CLI and sign in with `supabase login`. Run the following commands from the workspace root, `D:\RxPx Medical Bills`, which contains the `supabase` directory. Replace the project reference with the reference from your Supabase dashboard.
2. In Supabase Dashboard → Edge Functions → Secrets, add `OPENAI_API_KEY` with your own OpenAI API key and `AI_ALLOWED_ORIGINS` with the exact origin(s) serving this application, separated by commas. Example: `https://bills.example.com,http://localhost:8000`. An origin has no path or trailing slash. Do not use `*` or `null`. Keep the API key only in server secrets.
3. Deploy:

```powershell
Set-Location -LiteralPath 'D:\RxPx Medical Bills'
supabase functions deploy extract-bill --project-ref YOUR_PROJECT_REFERENCE
```

`SUPABASE_URL` and the public project key are supplied by Supabase. The function accepts the injected `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, or the `SUPABASE_PUBLISHABLE_KEYS` JSON map. It does not need a service-role key. The included [function configuration](../../config.toml) explicitly sets `verify_jwt = true` and the entrypoint. A publishable key belongs in `apikey`; it cannot replace the signed-in user's token in `Authorization`. The handler additionally checks the actual user with `auth.getUser` so a public project key alone never authorizes extraction. See [Supabase authorization headers](https://supabase.com/docs/guides/functions/auth-headers) and [getUser](https://supabase.com/docs/reference/javascript/auth-getuser).

If copying this function into another Supabase project, keep `[functions.extract-bill]` configured with `verify_jwt = true`. The included configuration covers hosted function deployment. Running a full local Supabase stack also needs the CLI's local project configuration. Follow the workspace [deployment guide](../../../DEPLOYMENT.md) for the application/database setup.

The default model is `gpt-4.1-mini`. Set the optional server secret `OPENAI_BILL_MODEL` to another model that supports image/PDF input and strict structured outputs. OpenAI bills API usage separately; uploading PDFs includes text and page images and can cost more than a single photo. No API call runs until a signed-in user selects AI reading. Review current [model information](https://developers.openai.com/api/docs/models/gpt-4.1-mini) and [file input costs and limits](https://developers.openai.com/api/docs/guides/file-inputs) before enabling it. No fixed price is assumed.

When `AI_ALLOWED_ORIGINS` is absent, only HTTP localhost/127.0.0.1 origins on ports 3000, 5173, 5500, 8000 and 8080 are allowed in browsers. For other ports and production, set the exact origin. Serve the HTML through HTTP; `file://` pages have an opaque `null` origin and are blocked. CLI callers without an Origin header still need a valid user JWT.

## Browser request

Use the same Supabase client as login. Its current session provides the user JWT; the public project key goes in the `apikey` header. `FormData` sets the multipart boundary automatically, so do not set `Content-Type` yourself.

```javascript
const { data: { session }, error } = await db.auth.getSession();
if (error || !session) throw new Error("Sign in first.");
const form = new FormData();
form.append("file", selectedFile);
const response = await fetch(`${supabaseUrl}/functions/v1/extract-bill`, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${session.access_token}`,
    apikey: supabasePublicKey,
  },
  body: form,
});
const extracted = await response.json();
if (!response.ok) throw new Error(extracted.error || "Extraction failed.");
// Display extracted for review. Save only after user correction and confirmation.
```

With supabase-js, `await db.functions.invoke("extract-bill", { body: form })` is also supported while signed in. Configure the application's optional AI reader URL to `https://YOUR_PROJECT_REFERENCE.supabase.co/functions/v1/extract-bill`.

## Response and limits

- `POST` accepts exactly one nonempty `file` field: PDF, JPEG, PNG, WebP or non-animated GIF, up to 20 MiB. It checks file signatures and MIME type. Excel/CSV remain handled locally. Request body streaming is capped, even without `Content-Length`.
- Success returns `{ vendor, bill_number, bill_date, bill_category, total, items, confidence, rawText, tables, fields, currency, warnings, extraction_method: "ai" }`, with `currencyConflict: true` when mixed or ambiguous currency is identified.
- `bill_category` is one of `pharmacy`, `medical_stock`, `patient`, `discharge`, `outpatient`, `inpatient`, `laboratory`, `diagnostics`, `procedure`, `emergency`, `other`. Classification follows the overall document purpose; the review screen allows corrections.
- `tables` contains `{ name, columns: string[], rows: string[][] }`. Every original column is preserved, including unfamiliar tax, batch or expiry columns. All cells are strings, preserving printed formats and leading zeros. Each row must match its column count.
- `items` is a normalized copy with `description` and nullable numeric `quantity`, `rate`, `amount`. Arbitrary columns remain in `tables`. Unknown standardized numbers are `null`; unknown text is `""`. The total is never silently added up or inferred. `bill_date` is an unambiguous ISO date or `""`. `currency` retains the detected ISO code, including foreign currency, or `""` when unknown. A bill with no printed currency is reviewed as INR in this application. Explicit foreign currency, multiple currencies or ambiguous currency must be rejected by the INR-only save flow; extraction never converts money or relabels it as INR.
- `fields` preserves additional printed label/value pairs, including patient name, UHID/MRN, IP/OP numbers, doctor, ward/bed, admission/discharge dates, GST, batch and expiry. Leading zeros and printed dates remain intact. Unfamiliar fields and table columns are retained. `confidence` is a model estimate from 0 to 100, not a calibrated accuracy guarantee. Review the original document before saving.
- Auth times out after 10 seconds, request upload after 15 seconds, and the model request after 90 seconds. Output is capped at 16,000 tokens; incomplete model output produces an error instead of returning truncated data. Split long PDFs if needed.
- Errors return `{ error, code }` with an appropriate HTTP status. `401` means sign in again; `403 origin_not_allowed` means configure the serving origin; `413` means a smaller file is required; `415` means unsupported format; `422 ai_incomplete` means split or retry; `429` means rate/quota limits; `503 ai_not_configured` means server secrets/access need attention; `504` means retry or use local reading.

The function uses the [OpenAI Responses API](https://developers.openai.com/api/reference/resources/responses/methods/create), [vision inputs](https://developers.openai.com/api/docs/guides/images-vision), and [strict structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses). Requests set `store: false`. No bill text, files, JWTs, API keys, provider payloads or user identifiers are logged by this handler; upstream errors are never forwarded verbatim. Selected documents are transmitted to OpenAI when the user chooses AI reading. Data retention is governed by your OpenAI account configuration and agreements; `store: false` disables response storage but does not by itself promise zero data retention. See [OpenAI data controls](https://developers.openai.com/api/docs/guides/your-data).

Use your API project's usage/budget controls for spending limits. This endpoint authenticates users but does not implement durable per-user billing quotas; add that server-side policy before a broad public launch if needed.

## Local validation

The handler uses a pinned `@supabase/supabase-js@2.118.0` dependency and otherwise relies on the Deno runtime and native Fetch API. Type-check it with `deno check --no-lock supabase/functions/extract-bill/index.ts`. Offline mocked contract/security checks need Node.js 22.18 or later and make no network requests:

```powershell
node --experimental-vm-modules supabase/functions/extract-bill/tests/handler.test.mjs
```

These checks exercise auth/origin denial, transient inline image/PDF input with `store: false`, hospital categories and patient fields, arbitrary ten-column tables, nullable totals, invalid dates, foreign/mixed/ambiguous currency handling, file signature and upload limits (including streamed requests without `Content-Length`), provider refusal/incomplete output/error handling, and auth/model timeouts. A live extraction test requires your deployed function, a signed-in user and the server API key; these credentials are not included in the source.
