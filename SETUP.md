# RxPx Hospitals – Bills: setup

## What is in this folder

| File | What it is |
|---|---|
| `index.html` | The whole app: sign in, new / existing bill, camera, dashboard, reports, Excel. |
| `google-sheet/Code.gs` | The app's server. It lives inside your Google Sheet and keeps the accounts, bills, medicine stock and photos (in Google Drive), and runs the AI bill reader (Claude). |

There is no other database. If `SHEET_URL` in `index.html` is empty, the app runs in "try it" mode: bills
stay in that browser only and are read by the basic offline reader, which can misread numbers.

## Set up the Google Sheet (about 10 minutes)

1. Open your Google Sheet → **Extensions → Apps Script**.
2. Delete everything in `Code.gs`, paste everything from `google-sheet/Code.gs`, and click **Save**.
   The `SPREADSHEET_ID` at the top already points to your sheet.
3. **Add your Claude key.** In Apps Script, click **Project Settings** (gear icon) → **Script properties**
   → **Add script property**: name `ANTHROPIC_API_KEY`, value your key from
   <https://console.anthropic.com> → API Keys (add credit under Billing). Keep this key only here:
   never put it in `index.html` and never send it in chat. Optional properties:
   - `SIGNUP_CODE`: a "hospital code" new staff must type to create an account. Recommended, so strangers
     who find the app cannot make accounts and use your Claude credit.
   - `BILL_READER_MODEL`: default `claude-opus-5-5`.
   - `BILL_READER_EFFORT`: default `high` (most careful). Use `medium` if reading feels slow.
4. **Deploy → New deployment** → click the gear → **Web app**. Execute as: **Me**.
   Who has access: **Anyone**. Click **Deploy**.
5. Google asks for permission: **Authorize access** → pick your account. If it says "Google hasn't
   verified this app", click **Advanced → Go to … (unsafe) → Allow**. It is your own script. It asks to
   use this spreadsheet, Google Drive (for bill photos) and outside requests (to reach Claude).
6. Copy the **Web app URL** (it ends with `/exec`) into `index.html`:
   ```js
   SHEET_URL:"https://script.google.com/macros/s/.../exec",
   ```
7. **Host `index.html` on https** (any static host: Netlify, Vercel, GitHub Pages, your own server).
   Phone cameras need https.
8. **Check it:** create an account, add a bill and look at the sheet. Then create a second account and
   confirm it sees no bills.

**Changing the script later:** paste the new code, then Deploy → Manage deployments → pencil icon →
Version: **New version** → Deploy. The web app URL stays the same.

## What the sheet looks like

Nothing is written to your sheet until the first bill is saved. Headings come from the bills themselves:
a heading is added the first time a bill has a value for it, so a lab bill adds no Batch or Expiry
columns, and the first medicine bill adds them.

| Tab | What it holds |
|---|---|
| **Bills** | One row per bill: when it was added and by whom, bill name, kind of bill, revenue or expense, bill number, bill date, tax, discount, total, and anything to check. The empty first tab is renamed to Bills. |
| **Items** | One row per item on every bill: item, batch, expiry, quantity, free, MRP, rate, amount. |
| **Summary** | Revenue, expenses and balance: all time, by kind of bill, and by month. |
| **app users, app sessions, app names, app bills, app medicines** | Hidden tabs where the app keeps its own records (accounts, sign-ins, full bill details, stock). Please don't edit them. |

Bill photos and PDFs are kept in a private Google Drive folder called **RxPx bill photos**.

The last two columns of Bills and Items, **Bill ID** and **Account**, let the app find a bill's rows when it
is corrected or deleted. If rows are changed by hand by mistake, **Profile → Rebuild my rows in the Google
Sheet** writes them again from the app's records (Google Sheets also keeps File → Version history).

## Accounts

- Each account sees only its own bills in the app. The visible tabs show everyone's bills, with the
  Account column showing whose bill it is.
- Passwords are stored only as salted hashes in the hidden **app users** tab.
- **Forgot password:** there is no email reset. The admin opens the hidden tabs (View → Hidden sheets),
  deletes that person's row in **app users**, and the person creates the account again with the **same
  email**. Their bills come back with it.
- **Remove someone's access:** delete their row in **app users**. They are signed out at once.

## How a bill is read

1. Staff pick **New bill** (type the name on the bill) or **Existing bill** (choose a saved name).
   Existing bill can be used once the first bill is saved.
2. They tap **Take Photo**, **Choose from Gallery**, **Upload PDF** or **Upload Excel or CSV**
   (up to 25 MB), then **Submit**.
3. If the exact same photo or file was saved before, or the bill number matches a saved bill, the app
   stops with **Already saved** and adds nothing. **Open the saved bill** shows the one already there;
   **Upload anyway** saves it on purpose, for a real second copy.
4. The AI reader copies every printed value: bill number, date, items with batch, expiry, quantity,
   free quantity, MRP, rate and amount, tax, discount and total. Anything it could not read clearly is
   marked **Please check** instead of being guessed.
5. When the kind of bill is clear, the bill is saved straight away. When it is not, the app first asks
   **What kind of bill is this?**
6. On saving, in one step: revenue or expenses go up, medicine stock goes up (purchase) or down (sale),
   the dashboard shows **Last bill saved** with the amount, and the bill's rows are written to the
   Bills, Items and Summary tabs. The Excel download includes it too.
7. **Check what was read** opens the bill with its photo, who added it, and the date and time.
   **Edit details** corrects any value; the totals, stock and sheet rows follow the correction.

If the AI reader is not set up or not reachable, the app uses the basic offline reader, which can misread
numbers, and the **Last bill saved** card says so. Spreadsheets are always read directly.

## Limits and running costs

- Saving needs an internet connection. If it fails, the reading screen says why, and **Try again**
  saves the bill that was already read, without reading it again.
- One reading can take up to about 5 minutes (Google's limit is 6). Most bills take 20 to 60 seconds.
  For very long bills, upload fewer pages at a time or set `BILL_READER_EFFORT` to `medium`.
- Google's free limits are generous for one hospital: 20,000 Claude calls a day from the script, and a
  spreadsheet holds up to 10 million cells (years of bills).
- Claude: one request per bill. With the default model and effort, expect very roughly
  US$0.05–0.20 (₹4–17) per bill page. Long multi-page bills cost more; `medium` effort costs less.

## Bills from the old version

The old version kept all bills in one place in the browser, so every login saw the same bills. They are not
shown to anyone automatically. Signed in to the right account, open **Profile → Move them into my
account** to move them into the Google Sheet. Bills without a type are left out.

## Settings in `index.html`

At the top of the app script (`const CFG`): `HOSPITAL_NAME`, `CURRENCY`, `EXPIRY_WARNING_DAYS`,
`LOW_STOCK_LIMIT`, `SHEET_URL`, `SHEET_LINK` (the address of the sheet, for the "Open the Google Sheet"
buttons).
