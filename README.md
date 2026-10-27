# RxPx Hospital Bills

> **Current page:** `medical bills.html` is the browser-only version of RxPx. It keeps bills, stock and sign-in accounts in the browser it is opened in (IndexedDB) and does not use Supabase. The Supabase files below (`medical-bills.js`, `bill-extraction.js`, `bill-export.js`, `app-config.js`, `supabase/`) are not loaded by this page. Checks for this page: `npm test` (bill reader) and `npm run test:page` (browser flows).
>
> **Photos on this page:** after a photo is chosen it opens in a small editor. An orange frame is put on the bill's corners by itself; drag a dot to fix a corner (a magnifier shows under the finger), use **Turn left** / **Turn right**, **Fit to bill** or **Whole photo**. The bill inside the frame is flattened and straightened before it is read, and that flattened copy is kept with the saved bill. Text outside the frame (the table, other papers) is never read.
>
> **Camera and gallery:** some in-app viewers (the Claude app's built-in viewer, for one) never open the camera or the file picker, and a web page cannot change that. When a tap on an option opens nothing on a phone, the upload screen says so in plain words, remembers it for three days, and offers **Type the details myself** (works in any viewer) and **Copy link for Chrome**, where all four buttons work. **No bill photo? Type the details myself** is also under the four options. A hosted copy can set `OPEN_URL` in `CFG` to the address people should paste into Chrome; without it the page's own address is used.
>
> **Saved bills:** bills and stock are kept in the browser of the device and are shared by everyone who signs in on it, so each login shows the same bills. **Profile → Saved bills** removes bills that look like copies of another (the first saved is kept and the stock they changed is put back) or deletes everything on the device to start fresh. The dashboard says when it finds copies. The bottom of Profile shows when this copy of the app was last updated.

Read hospital bills, review extracted values, and save **data only** to each signed-in account's Supabase database. Source images, PDFs, Excel workbooks, and CSV files are used temporarily for extraction and are **not saved**. The app uses **Indian rupees (₹ / INR) only**.

## Start locally

From this folder in PowerShell:

```powershell
python .\serve.py
```

Open **http://127.0.0.1:5500**. This server exposes only the application files. Browser libraries and local OCR language files require an internet connection.

## Connect or update the database

1. Run **supabase-setup.sql** in your Supabase project's SQL Editor. Rerun it for an existing installation to add hospital categories and enforce data-only, INR-only saves. The migration preserves existing records and attachments; it does not convert historical foreign amounts or delete files.
2. Enter the Project URL and public publishable/anon key on the connection screen, or fill in **app-config.js**. Never put a service-role key or an OpenAI API key in browser files.
3. Configure Supabase Auth's Site URL and allowed redirect URLs for this app. Create an account, confirm the email if enabled, and sign in.

Only public connection settings are stored in this browser. Bill records and extracted data are saved to the authenticated database. Source bytes, file names, and file sizes are not included in new saved bill records. A one-way file hash supports duplicate detection without retaining the file. Temporary previews and file references are cleared after saving, removal, or sign-out.

The SQL blocks new attachments through both the bill-save function and direct writes to the legacy `bill-files` storage bucket, including installations with older permissive policies. Existing private attachments remain preserved in storage; the app displays saved bill data. Deleting a legacy bill also attempts to remove its old attachment.

Project credentials are not included. The migration has been tested locally and still needs to be applied to the live project.

For hosting, run `npm run build:production` after supplying the public settings and publish only `dist/`. The production preflight blocks blank connection settings. See [DEPLOYMENT.md](DEPLOYMENT.md) for the complete setup, verification steps, and limits. Netlify and Vercel configurations are included.

## Bill flow

- Create or choose a bill name to group related records.
- Use the camera, gallery, or file picker, then choose **Read bill**. Supported sources: images, PDF, XLSX, XLS, and CSV, up to 20 MB; browser PDF reading supports up to 30 pages.
- Review the **bill category**: pharmacy, medical stock / supplies, patient, discharge, OP / outpatient, IP / inpatient, laboratory, diagnostics / scans, procedure / surgery, emergency, or other hospital bill.
- Confirm revenue / patient payment or expense / purchase, printed total in rupees, date, hospital / pharmacy / supplier, and bill number. Category detection is a suggestion; you can correct it.
- Review extracted tables and patient / hospital fields, including printed UHID / OP / IP numbers, doctor, admission / discharge dates, GST, batch, and expiry. All readable columns and extra values are preserved. No absent medical details are invented.
- Save the reviewed data to update the dashboard, charts, reports, and profile. No source-file upload occurs. Foreign or mixed currencies cannot be saved as INR. A source with no currency marker defaults to this rupee workspace; confirm the amount against the bill.
- Exact file duplicates are blocked unless you explicitly override. A lost save response retries the same ingestion ID to prevent creating a second record.

Dashboard totals, bill lists, and Excel exports include INR records only. Historical foreign and unknown-currency records are preserved in the database and excluded from rupee totals. No currency conversion occurs.

**Local OCR is approximate.** Clear images work best. Use the optional AI reader for complex layouts, or **Enter details manually** when extraction fails. Review all printed values before saving. The **Use item total** action is an explicit convenience; account for taxes and discounts before confirming it. Zero line values and blank cells are preserved; bill totals must be positive.

## Optional AI reader

Deploy **supabase/functions/extract-bill/index.ts** using [the AI reader instructions](supabase/functions/extract-bill/README.md). Add `OPENAI_API_KEY` only to Supabase server secrets. Keep JWT verification enabled and configure serving origins.

Enable **Use the AI reader** on the bill screen, or set `aiExtraction: true` in app-config.js. Selected images and PDFs are transmitted to the AI reader and its provider for extraction. The handler uses inline file input, requests `store: false`, and does not call a file-upload API or write source files, bills, or extracted values to storage. Provider retention is governed by provider account settings and agreements; this does not promise zero provider retention. Browser extraction remains available without AI.

No live provider extraction has been verified because no deployed function or API key was supplied.

## Excel reports and earlier data

**Reports & Excel → Download Excel** creates a workbook from saved INR data with hospital categories, summaries, line items, patient / hospital fields, and separate worksheets for extracted tables. Original spreadsheet cells are extracted values, not an archived file. Formula-like extracted strings remain literal text. Excel download is an explicit export; the application does not automatically save reports or source files.

An earlier HTML implementation is preserved in **.rxpx-backups/medical-bills-before-fix.html**. Shared legacy browser records are not automatically assigned to an account because ownership cannot be established. Existing Supabase bill records are preserved.

## Verification

```powershell
node --check .\medical-bills.js
node --test .\tests\extraction.test.cjs .\tests\export.test.cjs
node --experimental-vm-modules .\supabase\functions\extract-bill\tests\handler.test.mjs
node --test .\tests\database.test.cjs
node .\tests\app.test.cjs
node .\tests\ocr-browser.test.cjs
node --test .\tests\deployment.test.cjs
```

Export round-trip checks use `RXPX_XLSX_MODULE` or an installed `xlsx`. Database checks use `PGLITE_MODULE` or an installed `@electric-sql/pglite`. Browser checks use `PLAYWRIGHT_PACKAGE` or installed Playwright and Chromium. Browser tests mock external services and cover data-only saves, INR totals, category review, source-preview cleanup, duplicate retries, and account isolation. Tests do not save bill images, PDFs, or screenshots.
