/* Browser regression checks with all auth, storage, database and CDN APIs mocked.
 * Source files exist only as in-memory Files; no images, PDFs or screenshots are written.
 * Run: node tests/app.test.cjs
 * Optional: PLAYWRIGHT_PACKAGE points to an installed playwright/playwright-core package.
 * Optional: REAL_CHART=1 fetches the pinned Chart.js script into memory for canvas checks.
 */
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const crypto = require('node:crypto');
let playwright;
for (const candidate of [process.env.PLAYWRIGHT_PACKAGE, 'playwright', 'playwright-core', 'E:/Rubicorn/node_modules/playwright'].filter(Boolean)) {
  try { playwright = require(candidate); break; } catch (_) {}
}
if (!playwright) throw new Error('Install Playwright or set PLAYWRIGHT_PACKAGE to its installed package directory.');

function installMocks(options = {}) {
  const user = id => ({ id, email:id + '@example.test', created_at:'2026-10-01T00:00:00Z', user_metadata:{ full_name:'Account ' + id } });
  const data = {};
  for (const id of ['A','B']) data[id] = {
    bill_ledgers:[{id:'ledger-' + id,user_id:id,name:'Private ledger ' + id,created_at:'2026-10-01T00:00:00Z'}],
    bills:[{id:'bill-' + id,user_id:id,ledger_id:'ledger-' + id,bill_type:'income',bill_date:'2026-10-18',currency:'INR',total:id === 'A' ? 100 : 900,created_at:'2026-10-18T00:00:00Z',items:[],tables:[],fields:[]}],
  };
  const mock = window.__mock = {
    session:null, callbacks:[], data, holdReads:[], pending:[], uploads:[], removals:[], storageCalls:[], revokedUrls:[], rpcCalls:[], committed:{}, holdRpc:false, rpcPending:[],
    failReads:false, failAfterCommit:false, networkErrorOnce:false, rpcDuplicateOnce:false, stored:new Set(), exports:[], authCalls:[], signupAutoSession:false, holdAuth:false, authPending:[], holdSignout:false, signoutPending:[],
    emit(id) { this.session = id ? {user:user(id),access_token:'token-' + id} : null; this.callbacks.forEach(fn => fn(id ? 'SIGNED_IN' : 'SIGNED_OUT',this.session)); },
    release(id) { const ready = this.pending.filter(item => item.id === id); this.pending = this.pending.filter(item => item.id !== id); ready.forEach(item => item.resolve(item.payload)); },
    makeBill(args) {
      return {id:'saved-' + args.p_ingestion_id,user_id:this.session.user.id,ledger_id:args.p_ledger_id,bill_type:args.p_bill_type,bill_category:args.p_bill_category,vendor:args.p_vendor,bill_number:args.p_bill_number,bill_date:args.p_bill_date,total:args.p_total,currency:args.p_currency,items:args.p_items,tables:args.p_tables,fields:args.p_fields,storage_path:args.p_storage_path,original_file_name:args.p_original_file_name,file_size:args.p_file_size,source_hash:args.p_source_hash,created_at:'2026-10-18T01:00:00Z',extraction_method:args.p_extraction_method};
    },
  };
  const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
  URL.revokeObjectURL = value => { mock.revokedUrls.push(value); nativeRevokeObjectURL(value); };
  class Query {
    constructor(table) { this.table = table; this.filters = {}; this.start = 0; this.end = 499; }
    select() { return this; } eq(key,value) { this.filters[key] = value; return this; }
    order() { return this; } range(start,end) { this.start = start; this.end = end; return this; }
    limit(value) { this.end = value-1; return this; } delete() { this.deleting = true; return this; }
    insert(values) { this.inserting = values; return this; } single() { this.isSingle = true; return this; }
    then(resolve,reject) {
      const id = this.filters.user_id || mock.session?.user.id;
      let rows = (mock.data[id]?.[this.table] || []).filter(row => Object.entries(this.filters).every(([key,value]) => row[key] === value));
      if (this.inserting) {
        const duplicate = rows.some(row=>row.name.toLowerCase() === this.inserting.name.toLowerCase());
        const created = {...this.inserting,id:'created-ledger-' + id,created_at:'2026-10-18T01:00:00Z'};
        if (!duplicate && !mock.failReads) mock.data[id][this.table].push(created);
        return Promise.resolve({data:duplicate ? null : created,error:mock.failReads ? {message:'Refresh unavailable'} : duplicate ? {code:'23505',message:'Name already exists'} : null}).then(resolve,reject);
      }
      if (this.deleting && !mock.failReads) mock.data[id][this.table] = mock.data[id][this.table].filter(row=>!rows.includes(row));
      const payload = {data:rows.slice(this.start,this.end+1),error:mock.failReads ? {message:'Refresh unavailable'} : null};
      const promise = mock.holdReads.includes(id) ? new Promise(done => mock.pending.push({id,resolve:done,payload})) : Promise.resolve(payload);
      return promise.then(resolve,reject);
    }
  }
  mock.db = {
    from(table) { return new Query(table); },
    auth:{
      onAuthStateChange(fn) { mock.callbacks.push(fn); return {data:{subscription:{unsubscribe(){}}}}; },
      async getSession() { return {data:{session:mock.session},error:null}; },
      async signInWithPassword(values) { mock.authCalls.push({method:'signin',email:values.email}); mock.emit(values.email.toLowerCase().startsWith('b@') ? 'B' : 'A'); const response = {data:{session:mock.session},error:null}; if (mock.holdAuth) await new Promise(resolve=>mock.authPending.push(resolve)); return response; },
      async signUp(values) { mock.authCalls.push({method:'signup',email:values.email,name:values.options.data.full_name}); if (mock.signupAutoSession) mock.emit('B'); return {data:{session:mock.signupAutoSession ? mock.session : null},error:null}; },
      async signOut(options) { mock.authCalls.push({method:'signout',scope:options.scope}); if (mock.holdSignout) await new Promise(resolve=>mock.signoutPending.push(resolve)); mock.emit(null); return {error:null}; },
    },
    storage:{from(bucket) { mock.storageCalls.push(bucket); return {
      async upload(storagePath,source,options) { mock.uploads.push({path:storagePath,user:mock.session?.user.id,size:source.size,type:source.type,contentType:options.contentType}); if(mock.stored.has(storagePath)) return {error:{statusCode:'409',message:'Already exists'}}; mock.stored.add(storagePath); return {data:{path:storagePath},error:null}; },
      async remove(paths) { mock.removals.push(paths); return {error:null}; },
      async createSignedUrl(storagePath) { return {data:{signedUrl:'https://signed.example.test/' + storagePath},error:null}; },
    }; }},
    async rpc(name,args) {
      mock.rpcCalls.push(structuredClone(args));
      if (mock.rpcDuplicateOnce) { mock.rpcDuplicateOnce=false; return {data:null,error:{code:'23505',message:'Document already exists'}}; }
      let saved = mock.committed[args.p_ingestion_id];
      if (!saved) { saved = mock.makeBill(args); mock.committed[args.p_ingestion_id] = saved; mock.data[saved.user_id].bills.push(saved); }
      if(mock.failAfterCommit) mock.failReads = true;
      if(mock.networkErrorOnce) { mock.networkErrorOnce = false; return {error:{message:'Connection lost after commit'},data:null}; }
      const response = {data:saved,error:null};
      if(mock.holdRpc) return await new Promise(resolve => mock.rpcPending.push(() => resolve(response)));
      return response;
    },
  };
  window.__XLSX = {
    utils:{book_new:() => ({SheetNames:[],Sheets:{}}),aoa_to_sheet:rows => ({rows:structuredClone(rows)}),encode_range:() => 'A1:Z100',book_append_sheet(book,sheet,name) { book.SheetNames.push(name); book.Sheets[name] = sheet; }},
    writeFile(book,name) { mock.exports.push({book,name}); },
  };
  if (!options.noConnection) localStorage.setItem('rxpx.connection.v1',JSON.stringify({supabaseUrl:'https://example.supabase.test',supabaseAnonKey:'sb_publishable_browser_test_key'}));
}

async function run() {
  const workspace = path.resolve(__dirname,'..');
  let chartScript = '';
  if (process.env.REAL_CHART === '1') {
    const html = await fs.readFile(path.join(workspace,'medical bills.html'),'utf8');
    const chartUrl = html.match(/<script src="([^"]+\/chart\.umd(?:\.min)?\.js)"/)[1];
    const response = await fetch(chartUrl);
    assert.equal(response.status,200,'The pinned Chart.js URL must be available');
    chartScript = await response.text();
  }
  const server = http.createServer(async (request,response) => {
    const name = decodeURIComponent(new URL(request.url,'http://localhost').pathname).slice(1) || 'medical bills.html';
    if (path.basename(name) !== name) { response.writeHead(404); response.end(); return; }
    try {
      const content = await fs.readFile(path.join(workspace,name));
      response.setHeader('Content-Type',name.endsWith('.js') ? 'application/javascript; charset=utf-8' : 'text/html; charset=utf-8'); response.end(content);
    } catch (_) { response.writeHead(404); response.end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const url = 'http://127.0.0.1:' + server.address().port;
  const browser = await playwright.chromium.launch({headless:true});
  const failures = [];
  async function page(options = {}) {
    const current = await browser.newPage({timezoneId:options.timezone || 'Asia/Kolkata'});
    current.on('pageerror',error => failures.push(error.message));
    await current.addInitScript(installMocks,options);
    await current.route('**/*',route => {
      if(options.noExtraction && route.request().url().endsWith('/bill-extraction.js')) return route.fulfill({status:200,contentType:'application/javascript',body:''});
      if(route.request().url().startsWith(url)) return route.continue();
      const target = route.request().url();
      return route.fulfill({status:200,contentType:'application/javascript',body:target.includes('supabase-js') ? options.noSupabase ? '' : 'window.supabase={createClient:()=>window.__mock.db};' : target.includes('xlsx') ? options.noXlsx ? '' : 'window.XLSX=window.__XLSX;' : target.includes('chart.umd') ? chartScript ? chartScript+';Chart.defaults.animation=false;' : '' : ''});
    });
    await current.goto(url + '/medical%20bills.html');
    await current.waitForFunction(expected => state.view === expected,options.noConnection || options.noSupabase ? 'setup' : 'auth');
    return current;
  }
  async function login(current,id='A') {
    await current.evaluate(id => __mock.emit(id),id);
    await current.waitForFunction(id => state.user?.id === id && state.view === 'choose',id);
  }
  async function closePage(current) {
    assert.deepEqual(await current.evaluate(() => ({storage:__mock.storageCalls,uploads:__mock.uploads,removals:__mock.removals})),{storage:[],uploads:[],removals:[]},'Source files must never enter Supabase Storage');
    await current.close();
  }
  async function prepare(current) {
    await current.evaluate(() => {
      state.activeLedger = 'ledger-A';
      const file = new File([new Uint8Array([137,80,78,71])],'bill.png',{type:'image/png'});
      state.file = {source:file,name:file.name,type:file.type,size:file.size,preview:URL.createObjectURL(file),hash:'f'.repeat(64),ingestionId:crypto.randomUUID()};
      state.parsed = Object.assign(freshDraft(),{billType:'income',billCategory:'pharmacy',vendor:'Private vendor A',billNumber:'INV-0001',billDate:'2026-10-18',total:'250',currency:'INR',items:[{description:'Sample',quantity:0,rate:25,amount:0}],tables:[{name:'Ten columns',columns:Array.from({length:10},(_,i) => 'Column '+i),rows:Array.from({length:55},(_,r) => Array.from({length:10},(_,c) => r===0 && c===0 ? '00017' : r + ':' + c)),sourceRows:[['original','values']],sourceRange:'A1:J56'}],fields:[{label:'GSTIN',value:'00001234'},{label:'Patient name',value:'Patient A'},{label:'UHID',value:'000019'}]});
      state.view='review'; render();
    });
    await current.locator('input[name=reviewed]').check();
  }
  try {
    // Setup and unavailable dependencies explain the recovery action without crashing.
    const setup = await page({noConnection:true});
    assert.match(await setup.locator('#app').innerText(),/Connect Supabase/);
    await closePage(setup);
    const missingAuth = await page({noSupabase:true});
    assert.match(await missingAuth.locator('#app').innerText(),/Sign-in library did not load/);
    await closePage(missingAuth);
    const missingReader = await page({noExtraction:true}); await login(missingReader);
    await missingReader.locator('[data-act="existingLedger"]').click();
    await missingReader.locator('[data-act="useLedger"][data-id="ledger-A"]').click();
    await missingReader.locator('#fileInput').setInputFiles({name:'bill.png',mimeType:'image/png',buffer:Buffer.from([137,80,78,71])});
    assert.match(await missingReader.locator('#app').innerText(),/bill reader did not load/i);
    assert.equal(await missingReader.evaluate(()=>state.file),null);
    await closePage(missingReader);
    const missingExcel = await page({noXlsx:true}); await login(missingExcel);
    await missingExcel.locator('[data-act="route"][data-view="reports"]').click();
    await missingExcel.locator('[data-act="downloadExcel"]').click();
    assert.match(await missingExcel.locator('#toast').innerText(),/Excel library is unavailable/);
    await closePage(missingExcel);

    // Submit actual auth forms, follow the confirmation branch, and explicitly sign out.
    const auth = await page();
    await auth.locator('[data-act="signupTab"]').click();
    await auth.locator('input[name="name"]').fill('New User');
    await auth.locator('input[name="email"]').fill('new@example.test');
    await auth.locator('input[name="password"]').fill('test-password-123');
    await auth.locator('input[name="confirmPassword"]').fill('test-password-123');
    await auth.locator('form[data-form="auth"] button[type="submit"]').click();
    await auth.waitForFunction(() => state.authMode==='signin' && !state.busy);
    assert.match(await auth.locator('#app').innerText(),/Check your email/);
    assert.deepEqual(await auth.evaluate(() => __mock.authCalls[0]),{method:'signup',email:'new@example.test',name:'New User'});
    await auth.locator('input[name="email"]').fill('a@example.test');
    await auth.locator('input[name="password"]').fill('test-password-123');
    await auth.locator('form[data-form="auth"] button[type="submit"]').click();
    await auth.waitForFunction(() => state.user?.id==='A' && state.view==='choose' && !state.busy);
    assert.deepEqual(await auth.evaluate(() => __mock.authCalls[1]),{method:'signin',email:'a@example.test'});
    await prepare(auth);
    await auth.evaluate(() => { state.rawText='Private extracted text A'; toast('Private saved bill A'); });
    await auth.locator('[data-act="logout"]').click();
    await auth.waitForFunction(() => state.view==='auth' && !state.user);
    assert.deepEqual(await auth.evaluate(() => ({user:state.user,bills:state.bills,ledgers:state.ledgers,file:state.file,text:state.rawText,vendor:state.parsed.vendor,toastVisible:document.querySelector('#toast').classList.contains('show'),out:__mock.authCalls.find(call=>call.method==='signout')})),{user:null,bills:[],ledgers:[],file:null,text:'',vendor:'',toastVisible:false,out:{method:'signout',scope:'local'}});
    await auth.locator('input[name="email"]').fill('b@example.test');
    await auth.locator('input[name="password"]').fill('test-password-123');
    await auth.locator('form[data-form="auth"] button[type="submit"]').click();
    await auth.waitForFunction(() => state.user?.id==='B' && state.view==='choose' && !state.busy);
    assert.deepEqual(await auth.evaluate(() => state.bills.map(bill=>bill.id)),['bill-B']);
    await closePage(auth);

    const signup = await page();
    await signup.evaluate(() => { __mock.signupAutoSession=true; __mock.data.B={bill_ledgers:[],bills:[]}; });
    await signup.locator('[data-act="signupTab"]').click();
    await signup.locator('input[name="name"]').fill('First User');
    await signup.locator('input[name="email"]').fill('first@example.test');
    await signup.locator('input[name="password"]').fill('test-password-123');
    await signup.locator('input[name="confirmPassword"]').fill('test-password-123');
    await signup.locator('form[data-form="auth"] button[type="submit"]').click();
    await signup.waitForFunction(() => state.user?.id==='B' && state.view==='new-ledger' && !state.busy);
    await signup.locator('input[name="ledgerName"]').fill('Ward stock');
    await signup.locator('form[data-form="newLedger"] button[type="submit"]').click();
    await signup.waitForFunction(() => state.view==='upload' && !state.busy);
    assert.deepEqual(await signup.evaluate(()=>({name:activeLedger().name,count:state.ledgers.length})),{name:'Ward stock',count:1});
    await closePage(signup);

    // Completing an old sign-in request cannot unlock a later pending save.
    const authRace = await page();
    await authRace.evaluate(() => { __mock.holdAuth=true; const original=handleAuth; handleAuth=form=>(window.__auditAuth=original(form)); });
    await authRace.locator('input[name="email"]').fill('a@example.test');
    await authRace.locator('input[name="password"]').fill('test-password-123');
    await authRace.locator('form[data-form="auth"] button[type="submit"]').click();
    await authRace.waitForFunction(()=>state.view==='choose' && __mock.authPending.length===1);
    await prepare(authRace);
    await authRace.evaluate(()=>{ __mock.holdRpc=true; window.__auditSave=saveBill(document.querySelector('#reviewForm')); });
    await authRace.waitForFunction(()=>__mock.rpcPending.length===1);
    await authRace.evaluate(async()=>{ __mock.authPending.shift()(); await window.__auditAuth; });
    assert.equal(await authRace.evaluate(()=>state.busy),true,'An old auth completion must not unlock a pending save');
    await authRace.evaluate(async()=>{ __mock.rpcPending.shift()(); await window.__auditSave; });
    assert.equal(await authRace.evaluate(()=>totals().income),350);
    await closePage(authRace);

    // Sign-out clears source previews and prevents another sign-in until it completes.
    const logout = await page(); await login(logout); await prepare(logout);
    const popupEvent = logout.waitForEvent('popup');
    await logout.locator('[data-act="viewSelectedFile"]').click();
    const sourcePopup = await popupEvent;
    const openedPreview = await logout.evaluate(()=>Array.from(sourcePreviews)[0].url);
    await logout.evaluate(()=>{ __mock.holdSignout=true; });
    await logout.locator('[data-act="logout"]').click();
    await logout.waitForFunction(()=>state.view==='auth' && __mock.signoutPending.length===1);
    assert.equal(sourcePopup.isClosed(),true,'Signing out must close temporary source preview tabs');
    assert.ok(await logout.evaluate(url=>__mock.revokedUrls.includes(url),openedPreview));
    assert.equal(await logout.locator('form[data-form="auth"] button[type="submit"]').isDisabled(),true);
    await logout.evaluate(async()=>{ await handleAuth(document.querySelector('form[data-form="auth"]')); });
    assert.equal(await logout.evaluate(()=>__mock.authCalls.filter(call=>call.method==='signin').length),0);
    await logout.evaluate(()=>__mock.signoutPending.shift()());
    await logout.waitForFunction(()=>!state.busy);
    await closePage(logout);

    // Database failures are visible on profile/detail views and retries clear them.
    const recovery = await page();
    await recovery.evaluate(()=>{ __mock.failReads=true; __mock.emit('A'); });
    await recovery.waitForFunction(()=>state.view==='load-error');
    assert.match(await recovery.locator('#app').innerText(),/Could not load your bills/);
    await recovery.evaluate(()=>{ __mock.failReads=false; });
    await recovery.locator('[data-act="reloadAccount"]').click();
    await recovery.waitForFunction(()=>state.view==='choose');
    await recovery.locator('[data-act="route"][data-view="profile"]').click();
    await recovery.evaluate(async()=>{ __mock.failReads=true; await refreshAccount(); });
    assert.match(await recovery.locator('#app').innerText(),/Refresh unavailable/);
    await recovery.evaluate(async()=>{ __mock.failReads=false; await refreshAccount(); });
    assert.doesNotMatch(await recovery.locator('#app').innerText(),/Refresh unavailable/);
    await recovery.locator('[data-act="route"][data-view="dashboard"]').click();
    if (!chartScript) { await recovery.waitForFunction(()=>document.querySelector('.chart-wrap').innerText.includes('Charts could not load')); }
    await recovery.locator('[data-act="openBill"][data-id="bill-A"]').click();
    recovery.on('dialog',dialog=>dialog.accept());
    await recovery.evaluate(async()=>{ __mock.failReads=true; await deleteBill('bill-A'); });
    assert.match(await recovery.locator('#app').innerText(),/Could not delete the bill/);
    await recovery.evaluate(async()=>{ __mock.failReads=false; await deleteBill('bill-A'); });
    assert.equal(await recovery.evaluate(()=>state.view),'dashboard');
    assert.deepEqual(await recovery.evaluate(()=>totals()),{income:0,expense:0});
    assert.doesNotMatch(await recovery.locator('#app').innerText(),/Could not delete the bill/);
    await closePage(recovery);

    // A real CSV File crosses selection, SHA-256, explicit read, review and save.
    const csv = [
      'Vendor: CSV Supplies,,,,,,,,,', 'Invoice No: CSV-001,,,,,,,,,', 'Bill date: 18/10/2026,,,,,,,,,',
      'SKU,Description,Qty,Rate,Amount,Tax,Batch,Expiry,Category,Notes',
      '0007,Product A,2,100,200,GST 5%,B007,10/2027,Medicine,Original text',
      'Grand Total: INR 200,,,,,,,,,',
    ].join('\n');
    const csvPage = await page(); await login(csvPage);
    await csvPage.locator('[data-act="existingLedger"]').click();
    await csvPage.locator('[data-act="useLedger"][data-id="ledger-A"]').click();
    const sourcePicker = await csvPage.locator('#fileInput').elementHandle();
    await sourcePicker.setInputFiles({name:'arbitrary-columns.csv',mimeType:'application/octet-stream',buffer:Buffer.from(csv)});
    await csvPage.waitForFunction(() => state.file?.hash.length===64 && !state.busy);
    assert.equal(await sourcePicker.evaluate(input=>input.value),'','The selected input must release its source file immediately');
    await sourcePicker.dispose();
    let csvState = await csvPage.evaluate(() => ({view:state.view,type:state.file.type,hash:state.file.hash,text:state.rawText,tables:state.parsed.tables,uploads:__mock.uploads.length,rpcs:__mock.rpcCalls.length}));
    assert.equal(csvState.view,'upload'); assert.equal(csvState.type,'text/csv'); assert.equal(csvState.hash,crypto.createHash('sha256').update(csv).digest('hex')); assert.equal(csvState.text,''); assert.deepEqual(csvState.tables,[]); assert.equal(csvState.uploads+csvState.rpcs,0);
    await csvPage.locator('[data-act="scanAgain"]').click();
    await csvPage.waitForFunction(() => state.view==='review' && !state.busy);
    csvState = await csvPage.evaluate(() => ({tables:state.parsed.tables,method:state.parsed.extractionMethod,text:state.rawText}));
    assert.equal(csvState.method,'spreadsheet');
    const csvTable = csvState.tables.find(table=>table.columns.includes('SKU'));
    assert.ok(csvTable,'CSV column headings must be preserved'); assert.equal(csvTable.columns.length,10); assert.equal(csvTable.rows[0][0],'0007'); assert.equal(csvTable.rows[0][6],'B007'); assert.equal(csvTable.rows[0][9],'Original text'); assert.ok(csvTable.sourceRows.some(row=>row[0]==='0007'));
    await csvPage.locator('input[name="total"]').fill('200');
    await csvPage.locator('input[name="billDate"]').fill('2026-10-18');
    assert.equal(await csvPage.locator('input[name="currency"],select[name="currency"],[data-currency]').count(),0,'Rupees must be fixed, with no editable currency control');
    await csvPage.locator('select[name="billType"]').selectOption('income');
    const categories = await csvPage.locator('select[name="billCategory"] option').evaluateAll(options => options.map(option => option.value));
    assert.deepEqual(categories,['pharmacy','medical_stock','patient','discharge','outpatient','inpatient','laboratory','diagnostics','procedure','emergency','other']);
    await csvPage.locator('select[name="billCategory"]').selectOption('medical_stock');
    await csvPage.locator('input[name="reviewed"]').check();
    await csvPage.locator('#reviewForm button[type="submit"]').click();
    await csvPage.waitForFunction(() => state.view==='dashboard' && !state.busy);
    csvState = await csvPage.evaluate(() => ({total:totals().income,saved:__mock.rpcCalls[0],file:state.file,text:state.rawText,draft:state.parsed}));
    assert.equal(csvState.total,300); assert.equal(csvState.saved.p_tables.find(table=>table.columns.includes('SKU')).rows[0][0],'0007');
    assert.equal(csvState.saved.p_bill_category,'medical_stock'); assert.equal(csvState.saved.p_currency,'INR');
    assert.equal(csvState.saved.p_storage_path,null); assert.equal(csvState.saved.p_original_file_name,null); assert.equal(csvState.saved.p_file_size,null);
    assert.equal(csvState.file,null); assert.equal(csvState.text,''); assert.equal(csvState.draft.vendor,'');
    await csvPage.locator('[data-act="chooseBill"]').click();
    await csvPage.locator('[data-act="existingLedger"]').click();
    await csvPage.locator('[data-act="useLedger"][data-id="ledger-A"]').click();
    assert.deepEqual(await csvPage.locator('input[type="file"]').evaluateAll(inputs=>inputs.map(input=>input.files.length)),[0,0,0],'Source pickers must be empty after saving');
    await closePage(csvPage);

    // Wide source tables scroll internally while the mobile page fits the screen.
    const mobile = await page(); await mobile.setViewportSize({width:390,height:844}); await login(mobile);
    for (const view of ['dashboard','profile']) {
      await mobile.locator('[data-act="route"][data-view="'+view+'"]').click();
      await mobile.waitForTimeout(20);
      assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth),view+' must fit a 390px viewport');
    }
    await prepare(mobile);
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth<=window.innerWidth),'review must fit a 390px viewport');
    assert.ok(await mobile.locator('.item-table-wrap').first().evaluate(node=>node.scrollWidth>node.clientWidth),'wide review table must scroll internally');
    await closePage(mobile);

    // Resolve A's old requests only after B's workspace has rendered.
    const race = await page();
    await race.evaluate(() => { __mock.holdReads=['A']; __mock.emit('A'); });
    await race.waitForFunction(() => __mock.pending.length === 2);
    await login(race,'B');
    await race.evaluate(() => __mock.release('A'));
    await race.waitForTimeout(30);
    assert.deepEqual(await race.evaluate(() => ({user:state.user.id,ledgers:state.ledgers.map(l=>l.id),bills:state.bills.map(b=>b.id)})),{user:'B',ledgers:['ledger-B'],bills:['bill-B']});
    assert.equal((await race.locator('#app').innerText()).includes('Private ledger A'),false);
    await closePage(race);

    // Edits across table pages survive the save; a failing refresh cannot undo it.
    const save = await page(); await login(save); await prepare(save);
    await save.locator('[data-table-cell="0:0:1"]').fill('Corrected on page one');
    await save.locator('[data-act="tablePage"][data-page="1"]').click();
    await save.locator('[data-table-cell="0:51:2"]').fill('Corrected on page two');
    const savedPreview = await save.evaluate(() => { __mock.failAfterCommit=true; state.rawText='Patient A discharge record'; return state.file.preview; });
    await save.locator('#reviewForm button[type="submit"]').click();
    await save.waitForFunction(() => state.view === 'dashboard' && !state.busy);
    let result = await save.evaluate(() => ({view:state.view,total:totals().income,busy:state.busy,file:state.file,text:state.rawText,draft:state.parsed,revoked:__mock.revokedUrls,warning:state.syncWarning,payload:__mock.rpcCalls[0],removals:__mock.removals.length}));
    assert.equal(result.view,'dashboard'); assert.equal(result.total,350); assert.equal(result.busy,false); assert.equal(result.file,null); assert.match(result.warning,/saved successfully/); assert.equal(result.removals,0);
    assert.equal(result.payload.p_tables[0].rows.length,55); assert.equal(result.payload.p_tables[0].columns.length,10);
    assert.equal(result.payload.p_tables[0].rows[0][0],'00017'); assert.equal(result.payload.p_tables[0].rows[0][1],'Corrected on page one'); assert.equal(result.payload.p_tables[0].rows[51][2],'Corrected on page two'); assert.equal(result.payload.p_fields[0].value,'00001234');
    assert.deepEqual(result.payload.p_tables[0].sourceRows,[['original','values']]);
    assert.equal(result.payload.p_bill_category,'pharmacy'); assert.equal(result.payload.p_currency,'INR');
    assert.equal(result.payload.p_storage_path,null); assert.equal(result.payload.p_original_file_name,null); assert.equal(result.payload.p_file_size,null);
    assert.equal(result.payload.p_fields[1].value,'Patient A'); assert.equal(result.payload.p_fields[2].value,'000019');
    assert.equal(result.text,''); assert.equal(result.draft.vendor,''); assert.ok(result.revoked.includes(savedPreview),'Source preview URL must be revoked after saving');
    assert.equal(await save.evaluate(() => typeof window.BillExport),'object','HTML must include bill-export.js');
    await save.evaluate(() => downloadExcel());
    const exported = await save.evaluate(() => __mock.exports[0].book);
    const tableSheet = Object.values(exported.Sheets).find(sheet => sheet.rows[0]?.[0] === 'Column 0');
    assert.equal(tableSheet.rows.length,56); assert.equal(tableSheet.rows[1][0],'00017'); assert.equal(tableSheet.rows[52][2],'Corrected on page two');
    await closePage(save);

    // A connection loss after commit retries the identical data-only ingestion ID.
    const retry = await page(); await login(retry); await prepare(retry);
    await retry.evaluate(() => { __mock.networkErrorOnce=true; return saveBill(document.querySelector('#reviewForm')); });
    assert.equal(await retry.evaluate(() => state.view),'review');
    await retry.evaluate(() => saveBill(document.querySelector('#reviewForm')));
    result = await retry.evaluate(() => ({view:state.view,total:totals().income,ids:__mock.rpcCalls.map(call=>call.p_ingestion_id),hashes:__mock.rpcCalls.map(call=>call.p_source_hash),calls:__mock.rpcCalls,committed:Object.keys(__mock.committed).length}));
    assert.equal(result.view,'dashboard'); assert.equal(result.total,350); assert.equal(result.committed,1); assert.equal(result.ids.length,2); assert.equal(result.ids[0],result.ids[1]); assert.deepEqual(result.hashes,['f'.repeat(64),'f'.repeat(64)]);
    for (const call of result.calls) { assert.equal(call.p_storage_path,null); assert.equal(call.p_original_file_name,null); assert.equal(call.p_file_size,null); assert.equal(call.p_currency,'INR'); }
    await closePage(retry);

    // A save finishing after an account switch must never enter B's state.
    const saveRace = await page(); await login(saveRace); await prepare(saveRace);
    await saveRace.evaluate(() => { __mock.holdRpc=true; window.__pendingSave=saveBill(document.querySelector('#reviewForm')); });
    await saveRace.waitForFunction(() => __mock.rpcPending.length===1);
    await login(saveRace,'B');
    await saveRace.evaluate(async () => { __mock.rpcPending.shift()(); await window.__pendingSave; });
    assert.deepEqual(await saveRace.evaluate(() => ({user:state.user.id,bills:state.bills.map(b=>b.id),file:state.file,busy:state.busy,total:totals().income})),{user:'B',bills:['bill-B'],file:null,busy:false,total:900});
    await closePage(saveRace);

    // A duplicate discovered by the database requires a deliberate audited override.
    const duplicate = await page(); await login(duplicate); await prepare(duplicate);
    await duplicate.evaluate(()=>{ __mock.rpcDuplicateOnce=true; __mock.data.A.bills[0].source_hash='f'.repeat(64); });
    await duplicate.evaluate(()=>saveBill(document.querySelector('#reviewForm')));
    assert.equal(await duplicate.evaluate(()=>state.view),'review');
    assert.match(await duplicate.locator('#app').innerText(),/This document is already saved/);
    assert.equal(await duplicate.locator('input[name="forceDuplicate"]').count(),1);
    await duplicate.evaluate(()=>saveBill(document.querySelector('#reviewForm')));
    assert.equal(await duplicate.evaluate(()=>__mock.rpcCalls.length),1,'A discovered duplicate must not retry until the override is checked');
    await duplicate.locator('input[name="forceDuplicate"]').check();
    await duplicate.evaluate(()=>saveBill(document.querySelector('#reviewForm')));
    assert.equal(await duplicate.evaluate(()=>state.view),'dashboard');
    assert.deepEqual(await duplicate.evaluate(()=>__mock.rpcCalls.map(call=>call.p_force_duplicate)),[false,true]);
    await closePage(duplicate);

    // Extraction completing after sign-out cannot restore private state.
    const scanLogout = await page(); await login(scanLogout); await prepare(scanLogout);
    await scanLogout.evaluate(()=>{
      window.BillExtraction={...window.BillExtraction,extract:()=>new Promise(resolve=>window.__finishExtraction=resolve)};
      state.useAI=false; state.view='upload'; render(); window.__auditScan=scanSelectedFile();
    });
    await scanLogout.waitForFunction(()=>state.busy && typeof window.__finishExtraction==='function');
    await scanLogout.locator('[data-act="logout"]').click();
    await scanLogout.waitForFunction(()=>state.view==='auth' && !state.busy);
    await scanLogout.evaluate(async()=>{ __finishExtraction({vendor:'Old patient',rawText:'Private patient text',tables:[],items:[],fields:[],currency:'INR'}); await __auditScan; });
    assert.deepEqual(await scanLogout.evaluate(()=>({view:state.view,user:state.user,file:state.file,vendor:state.parsed.vendor,text:state.rawText})),{view:'auth',user:null,file:null,vendor:'',text:''});
    await closePage(scanLogout);

    // Manual corrections cannot hide a foreign amount inside a rupee draft.
    const manualForeign = await page(); await login(manualForeign); await prepare(manualForeign);
    await manualForeign.locator('input[name="total"]').fill('$250');
    await manualForeign.evaluate(() => saveBill(document.querySelector('#reviewForm')));
    result = await manualForeign.evaluate(() => ({view:state.view,total:state.parsed.total,file:!!state.file,calls:__mock.rpcCalls.length,message:state.message}));
    assert.equal(result.view,'review'); assert.equal(result.total,'$250'); assert.equal(result.file,true); assert.equal(result.calls,0); assert.match(JSON.stringify(result.message),/INR|rupee/i);
    await manualForeign.locator('input[name="total"]').fill('250');
    await manualForeign.locator('input[name="itemRate"]').fill('USD 10');
    await manualForeign.evaluate(() => saveBill(document.querySelector('#reviewForm')));
    result = await manualForeign.evaluate(() => ({view:state.view,rate:state.parsed.items[0].rate,file:!!state.file,calls:__mock.rpcCalls.length,message:state.message}));
    assert.equal(result.view,'review'); assert.equal(result.rate,'USD 10'); assert.equal(result.file,true); assert.equal(result.calls,0); assert.match(JSON.stringify(result.message),/INR|rupee/i);
    await manualForeign.locator('input[name="itemRate"]').fill('25');
    await manualForeign.locator('input[name="itemAmount"]').fill('not a number');
    await manualForeign.evaluate(()=>saveBill(document.querySelector('#reviewForm')));
    assert.match(await manualForeign.locator('#app').innerText(),/Check the line item numbers/);
    assert.equal(await manualForeign.evaluate(()=>state.parsed.items[0].amount),'not a number');
    assert.equal(await manualForeign.evaluate(()=>__mock.rpcCalls.length),0);
    await closePage(manualForeign);

    // Actual Chart.js instances render the saved totals and are destroyed on navigation.
    if (chartScript) {
      const charts = await page();
      await charts.evaluate(()=>__mock.data.A.bills.push({id:'expense-A',user_id:'A',ledger_id:'ledger-A',bill_type:'expense',bill_category:'medical_stock',bill_date:'2026-10-18',currency:'INR',total:40,created_at:'2026-10-18T01:00:00Z',items:[],tables:[],fields:[]}));
      await login(charts);
      await charts.locator('[data-act="route"][data-view="dashboard"]').click();
      await charts.waitForFunction(()=>state.charts.length===3 && state.charts.every(chart=>chart.width>0 && chart.height>0));
      result = await charts.evaluate(()=>({version:Chart.version,types:state.charts.map(chart=>chart.config.type),bar:state.charts[0].data.datasets[0].data,expense:state.charts[1].data.datasets[0].data,trend:state.charts[2].data.datasets.map(set=>set.data),tooltip:state.charts[0].options.plugins.tooltip.callbacks.label({dataset:{},raw:40}),drawn:Array.from(document.querySelector('#moneyChart').getContext('2d').getImageData(0,0,20,20).data).some(value=>value>0)}));
      assert.equal(result.version,'4.5.0'); assert.deepEqual(result.types,['bar','doughnut','line']); assert.deepEqual(result.bar,[100,40,60]); assert.deepEqual(result.expense,[40]); assert.deepEqual(result.trend,[[100],[40]]); assert.match(result.tooltip,/₹40/);
      assert.equal(await charts.locator('#moneyChart').evaluate(canvas=>Array.from(canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height).data).some((value,index)=>index%4===3 && value>0)),true,'The real chart canvas must contain rendered pixels');
      await prepare(charts);
      assert.equal(await charts.evaluate(()=>Object.keys(Chart.instances).length),0,'Review must destroy the previous dashboard charts');
      await charts.locator('#reviewForm button[type="submit"]').click();
      await charts.waitForFunction(()=>state.view==='dashboard' && !state.busy && state.charts.length===3);
      assert.deepEqual(await charts.evaluate(()=>state.charts[0].data.datasets[0].data),[350,40,310]);
      await charts.locator('[data-act="route"][data-view="profile"]').click();
      assert.equal(await charts.evaluate(()=>Object.keys(Chart.instances).length),0);
      assert.match(await charts.locator('#app').innerText(),/₹350\.00/); assert.match(await charts.locator('#app').innerText(),/₹40\.00/);
      await charts.locator('[data-act="route"][data-view="reports"]').click();
      assert.match(await charts.locator('#app').innerText(),/₹310\.00/);
      await closePage(charts);
    }

    // Printed dates are calendar dates; timestamps and export names use client time.
    const dates = await page({timezone:'America/Los_Angeles'}); await login(dates);
    result = await dates.evaluate(()=>({date:dateText('2026-10-18',false),timestamp:dateText('2026-10-18T01:00:00Z',true),local:localDate(new Date('2026-10-18T01:00:00Z'))}));
    assert.match(result.date,/18 Oct 2026/); assert.match(result.timestamp,/17 Oct 2026/); assert.equal(result.local,'2026-10-17');
    await closePage(dates);

    // Existing foreign records never enter rupee totals, reports or downloaded data.
    const rupees = await page();
    await rupees.evaluate(() => {
      __mock.data.A.bills.push(
        {id:'foreign-usd',user_id:'A',ledger_id:'ledger-A',bill_type:'income',vendor:'Foreign dollars',bill_date:'2026-10-18',currency:'USD',total:70000,items:[],tables:[],fields:[]},
        {id:'foreign-eur',user_id:'A',ledger_id:'ledger-A',bill_type:'expense',vendor:'Foreign euros',bill_date:'2026-10-18',currency:'EUR',total:80000,items:[],tables:[],fields:[]}
      );
    });
    await login(rupees);
    for (const view of ['dashboard','reports','profile']) {
      await rupees.locator('[data-act="route"][data-view="'+view+'"]').click();
      assert.equal(await rupees.locator('[data-currency],input[name="currency"],select[name="currency"]').count(),0,'The '+view+' must have a fixed rupee currency');
      const text = await rupees.locator('#app').innerText();
      assert.match(text,/₹/); assert.doesNotMatch(text,/Foreign dollars|Foreign euros|70,000|80,000/);
    }
    result = await rupees.evaluate(() => ({totals:totals(),ledger:ledgerStats('ledger-A'),shown:shownBills().map(bill=>bill.id)}));
    assert.deepEqual(result.totals,{income:100,expense:0}); assert.equal(result.ledger.count,1); assert.equal(result.ledger.income,100); assert.equal(result.ledger.expense,0); assert.deepEqual(result.shown,['bill-A']);
    await rupees.evaluate(() => downloadExcel());
    const rupeeExport = await rupees.evaluate(() => __mock.exports[0].book);
    assert.ok(JSON.stringify(rupeeExport).includes('bill-A')); assert.doesNotMatch(JSON.stringify(rupeeExport),/foreign-usd|foreign-eur|Foreign dollars|Foreign euros/);
    await closePage(rupees);

    // Browser adapter uses the signed-in JWT and preserves the function's bare result.
    const ai = await page(); await login(ai); await prepare(ai);
    let aiRequest;
    await ai.route('https://example.supabase.test/functions/v1/extract-bill',async route => {
      aiRequest = {headers:route.request().headers(),body:route.request().postData()};
      return route.fulfill({status:200,contentType:'application/json',headers:{'Access-Control-Allow-Origin':url},body:JSON.stringify({vendor:'Foreign vendor',bill_number:'AI-001',bill_category:'discharge',bill_date:'2026-10-18',total:123.45,currency:'EUR',confidence:79,rawText:'Original AI document text',tables:[{name:'Arbitrary columns',columns:['Code','Batch','VAT','Extra','Total'],rows:[['0005','BX1','5%','kept','123.45']]}],items:[],fields:[{label:'Tax ID',value:'000009'},{label:'Patient name',value:'Patient AI'}],warnings:['Verify VAT manually'],extraction_method:'ai'})});
    });
    await ai.evaluate(async () => { state.useAI=true; state.view='upload'; render(); await scanSelectedFile(); });
    result = await ai.evaluate(() => ({view:state.view,draft:state.parsed,text:state.rawText}));
    assert.equal(result.view,'review'); assert.equal(result.draft.currency,'EUR'); assert.equal(result.draft.total,'123.45'); assert.equal(result.draft.extractionMethod,'ai'); assert.equal(result.draft.tables[0].rows[0][0],'0005'); assert.equal(result.draft.fields[0].value,'000009'); assert.equal(result.text,'Original AI document text');
    assert.equal(await ai.locator('select[name="billCategory"]').inputValue(),'discharge');
    assert.equal(await ai.locator('[data-field-value="1"]').inputValue(),'Patient AI');
    assert.equal(aiRequest.headers.authorization,'Bearer token-A'); assert.equal(aiRequest.headers.apikey,'sb_publishable_browser_test_key'); assert.match(aiRequest.headers['content-type'],/^multipart\/form-data; boundary=/); assert.match(aiRequest.body,/name="file"/);
    assert.equal(await ai.locator('input[name="currency"],select[name="currency"]').count(),0);
    await ai.locator('input[name="reviewed"]').check();
    await ai.evaluate(() => saveBill(document.querySelector('#reviewForm')));
    result = await ai.evaluate(() => ({view:state.view,currency:state.parsed.currency,calls:__mock.rpcCalls.length,message:state.message}));
    assert.equal(result.view,'review'); assert.equal(result.currency,'EUR','A foreign total must never be relabeled as rupees'); assert.equal(result.calls,0); assert.match(JSON.stringify(result.message),/INR|rupee/i);
    await ai.evaluate(() => { state.parsed.currency='INR'; state.parsed.currencyConflict=true; state.reviewed=true; render(); });
    await ai.evaluate(() => saveBill(document.querySelector('#reviewForm')));
    assert.equal(await ai.evaluate(() => __mock.rpcCalls.length),0,'An extraction with conflicting currencies must remain blocked');
    await closePage(ai);

    const first = await page();
    await first.evaluate(() => { __mock.data.B={bill_ledgers:[],bills:[]}; __mock.emit('B'); });
    await first.waitForFunction(() => state.view==='new-ledger');
    assert.equal(await first.evaluate(() => state.ledgers.length),0);
    await closePage(first);
    assert.deepEqual(failures,[]);
    console.log('PASS: authentication and account isolation; in-memory CSV selection, hospital categories and fields; data-only INR saves without Storage calls; source and preview cleanup; mobile layout; paginated column edits; committed-save recovery and idempotent retry; INR reports/export; foreign-currency blocking; authenticated AI adapter. All external APIs mocked; no source files or screenshots written.');
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
}
run().catch(error => { console.error(error); process.exitCode=1; });
