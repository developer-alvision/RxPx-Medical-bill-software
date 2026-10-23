# RxPx-Medical-Bill-Scanner

Bill scanner for RxPx Hospitals. Staff photograph a bill (or upload a PDF or Excel file), an AI reader
(Claude) copies every line and the bill is saved; anything unclear is marked for checking. Bills, medicine
stock and photos are kept in the hospital's Google Sheet and Google Drive, and the dashboard shows revenue,
expenses and charts.

| File | What it is |
|---|---|
| `index.html` | The app: sign in, new or existing bill, camera, dashboard, reports, Excel download. |
| `google-sheet/Code.gs` | The server, inside the Google Sheet: accounts, bills, stock, photos and the AI reader. |
| `SETUP.md` | How to set it up. |
