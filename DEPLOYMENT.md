# Deploy RxPx Hospital Bills

The current `medical bills.html` is the browser-only page: it keeps its data in the browser, `npm run build:production` builds it without Supabase settings, and `dist/` then contains only the page. The Supabase steps below apply to the Supabase version of the page, which loads `app-config.js`.

The frontend is a static website. Supabase supplies authentication, the database, and the optional AI Edge Function. `serve.py` is a local development server, not the production server.

## Current setup

The source has no real Supabase project URL or public key and no deployed website URL. A local preview can show the connection screen; production readiness cannot be confirmed until the live setup below is completed. No credentials are inferred or fabricated.

## 1. Connect the real database

Run `supabase-setup.sql` in the Supabase SQL Editor. Run the entire transaction. It is safe to rerun and preserves older records and attachments. Rows from older schemas with no recorded currency become `XXX` (unknown), and are excluded from rupee totals. New records use INR and cannot attach source files.

Add your public settings to `app-config.js`, or set these build environment variables on your host:

| Variable | Value |
| --- | --- |
| `RXPX_SUPABASE_URL` | Your HTTPS Supabase Project URL, with no extra path |
| `RXPX_SUPABASE_ANON_KEY` | Your public publishable key (`sb_publishable_...`) or legacy anon key |
| `RXPX_AI_EXTRACTION` | Optional `true` or `false`; defaults to the source setting |

Only public browser settings belong here. Build output never reads OpenAI or Supabase service-role environment secrets into the browser configuration. The production check rejects secret/service-role keys used as the browser key. It validates the format, not whether your project exists or the key matches it.

## 2. Build and host the public files

Use Node 22.18 or newer within Node 22. Production building uses only Node built-ins and does not need development packages.

```powershell
npm ci --omit=dev --ignore-scripts
npm run check:deployment
npm run build:production
```

The check intentionally fails while the Supabase settings are blank. Set both public settings before retrying. It also catches missing local scripts, JavaScript syntax errors, and invalid AI configuration.

Publish **only `dist/`**. The build creates `index.html`, retains the old HTML URL as an alias, and includes only the required scripts and public setup instructions. It excludes arbitrary workspace files, backups, tests, server files, original bills, and secrets. Do not publish the project folder itself.

Netlify and Vercel configuration files are included. Their configured production build is `npm run build:production`, with output directory `dist`. Set the public environment variables in the hosting dashboard before deploying. Other static hosts can serve the same directory over HTTPS. This is not an SPA that needs every unknown URL rewritten to HTML.

For an unconfigured local preview only:

```powershell
npm run build
python .\serve.py
```

Open `http://127.0.0.1:5500/`. The preview build permits a blank connection so that the setup screen remains usable. It is not a successful production readiness check.

## 3. Configure login URLs

Once the HTTPS site URL is known, set it as Supabase Auth's **Site URL** and add the exact callback/redirect URLs used for that site to the allowed redirect list. Keep local development redirect URLs only if you need them. Confirm an email account and test sign-in on the deployed origin. Connection settings saved in a browser override the built-in settings; an old project connection can be changed from the sign-in screen.

## 4. Optional AI reader

Browser OCR works without the AI reader. For AI extraction, follow `supabase/functions/extract-bill/README.md` from this project folder. `supabase/config.toml` declares the `extract-bill` entrypoint and keeps JWT verification enabled; the handler also verifies the signed-in user before processing a file or making a paid request.

Set `OPENAI_API_KEY` in **Supabase Edge Function secrets**, and set `AI_ALLOWED_ORIGINS` to the exact deployed HTTPS origin(s), separated by commas, with no trailing slash or path. The default origin list covers local development only. Do not put the API key in frontend files or frontend build variables. Deploy the function with the real project reference, then enable the AI reader. Its upstream calls require model access and billing on that OpenAI account.

Images/PDFs are transmitted inline when AI reading is selected; this application does not persist source files. Provider retention follows the provider account configuration. Browser OCR runs locally and downloads its OCR language model from the network.

## 5. Verify on the deployed site

After setting the real URL and credentials, verify these live behaviors:

1. The root URL, all scripts, and external reader libraries load without 404s or blocked requests. HTTPS is required for mobile camera access and normal browser security APIs.
2. Sign up, confirm email if enabled, sign in, refresh, and sign out. Use two distinct accounts to check that each sees only its own bill names and records.
3. Read a clear bill, review every value and category, save, and verify dashboard totals, all charts, reports, profile, and Excel. Refresh the page and confirm the saved record remains.
4. Repeat with representative real pharmacy, stock, patient, discharge, OP/IP and lab bills. Test blurred/rotated photos and layouts used by your hospital. OCR cannot guarantee perfect extraction, and local synthetic fixtures do not establish real-bill accuracy.
5. Check that a duplicate requires an explicit override, a retried save creates one record, foreign/mixed currencies are blocked, and the Storage dashboard has no new source uploads.
6. If AI is enabled, confirm an authenticated request and allowed-origin preflight work; a signed-out request must not run extraction. Check project/model access and function limits using a representative source.

There is no live environment to run these checks against yet. Local passing tests do not certify live Auth, PostgREST schema reload, Storage backend, hosting, email delivery, concurrent sessions, or upstream API availability.

## Repeat local verification

Install development packages with `npm ci`, then Chromium with `npx playwright install chromium`. Run `npm test`, `npm run test:database`, `npm run test:browser`, `npm run test:ocr`, and `npm run test:ai`. The OCR smoke test uses real CDN libraries and synthetic images/PDFs in memory; it makes no provider API call and writes no images, PDFs, or screenshots.

## Verified reference contracts

Hosting configuration follows [Vercel static configuration](https://vercel.com/docs/project-configuration/vercel-json) and [Netlify file configuration](https://docs.netlify.com/build/configure-builds/file-based-configuration/). Authentication headers follow [Supabase's Edge Function reference](https://supabase.com/docs/guides/functions/auth-headers). Inline AI inputs follow [official OpenAI file-input documentation](https://developers.openai.com/api/docs/guides/file-inputs).

The pinned PDF.js 3.x loader sets `isEvalSupported: false`, the documented mitigation for [Mozilla's PDF.js advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-wgrm-67xf-hhpq). This is a specific mitigation, not a comprehensive security certification or a claim that the old library is current.
