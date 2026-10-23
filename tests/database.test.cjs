// Real PostgreSQL execution through PGlite; auth/storage schemas below stand in
// for Supabase's platform schemas. This does not test the hosted Storage API.
// Install @electric-sql/pglite, or set PGLITE_MODULE to its module directory.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
let PGlite, pgcrypto;
try {
  const moduleName = process.env.PGLITE_MODULE || '@electric-sql/pglite';
  ({ PGlite } = require(moduleName));
  ({ pgcrypto } = require(path.join(path.dirname(require.resolve(moduleName)), 'contrib', 'pgcrypto.cjs')));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
}

const platformSetup = `
  create role anon;
  create role authenticated;
  create schema auth;
  create schema storage;
  create table auth.users(id uuid primary key);
  create function auth.uid() returns uuid language sql stable as $$
    select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
  $$;
  create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects(id uuid primary key default gen_random_uuid(), bucket_id text references storage.buckets(id), name text not null);
  alter table storage.objects enable row level security;
  create function storage.foldername(p_name text) returns text[] language sql immutable as $$
    select (string_to_array(p_name, '/'))[1:cardinality(string_to_array(p_name, '/')) - 1]
  $$;
  grant usage on schema auth, storage, public to anon, authenticated;
  grant all on storage.objects to anon, authenticated;
`;

test('database enforces account boundaries, guarded saves and retry safety', { skip: !PGlite && 'Install @electric-sql/pglite to execute PostgreSQL tests' }, async (t) => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase-setup.sql'), 'utf8').replace(/^\uFEFF/, '');
  const userA = '11111111-1111-4111-8111-111111111111';
  const userB = '22222222-2222-4222-8222-222222222222';
  const ledgerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ledgerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const ingestion = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const hash = 'a'.repeat(64);
  let first;

  async function asUser(id, fn, role = 'authenticated') {
    await db.exec('set role ' + role);
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [id || '']);
    try { return await fn(); }
    finally { await db.exec('reset role'); }
  }

  async function save(overrides = {}, extras = true) {
    const args = {
      p_ledger_id: ledgerA, p_bill_type: 'expense', p_vendor: 'Clinic',
      p_bill_number: 'I-1', p_bill_date: '2026-10-18', p_total: '42.25',
      p_items: [{ description: 'Medicine', quantity: 1, rate: 42.25, amount: 42.25 }],
      p_source_hash: hash, p_original_file_name: null, p_storage_path: null,
      p_file_size: null, p_ocr_text: '', p_extraction_confidence: 80,
      p_force_duplicate: false,
      ...(extras ? {
        p_tables: [{ columns: ['Description', 'Batch', 'Qty', 'Rate', 'Amount', 'Tax'], rows: [['Medicine', 'B1', 1, 42.25, 42.25, 0]] }],
        p_fields: [{ name: 'Patient', value: 'A' }], p_currency: 'inr',
        p_extraction_method: 'spreadsheet', p_ingestion_id: ingestion,
        p_bill_category: 'pharmacy'
      } : {}),
      ...overrides
    };
    const types = {
      p_ledger_id: 'uuid', p_bill_type: 'text', p_vendor: 'text', p_bill_number: 'text',
      p_bill_date: 'date', p_total: 'numeric', p_items: 'jsonb', p_source_hash: 'text',
      p_original_file_name: 'text', p_storage_path: 'text', p_file_size: 'bigint',
      p_ocr_text: 'text', p_extraction_confidence: 'smallint', p_force_duplicate: 'boolean',
      p_tables: 'jsonb', p_fields: 'jsonb', p_currency: 'text', p_extraction_method: 'text',
      p_ingestion_id: 'uuid', p_bill_category: 'text'
    };
    const params = Object.values(args).map(value => value && typeof value === 'object' ? JSON.stringify(value) : value);
    const call = Object.keys(args).map((name, i) => name + ' := $' + (i + 1) + '::' + types[name]).join(',');
    return (await db.query('select saved.* from public.save_bill_with_duplicate_guard(' + call + ') saved', params)).rows[0];
  }

  try {
    await db.exec(platformSetup);

    await t.test('migration runs and extends fresh schema', async () => {
      await db.exec(migration);
      await db.query('insert into auth.users values ($1), ($2)', [userA, userB]);
      await db.query('insert into public.bill_ledgers(id, user_id, name) values ($1,$2,$3), ($4,$5,$6)', [ledgerA, userA, 'Bills A', ledgerB, userB, 'Bills B']);
      first = await asUser(userA, () => save());
      assert.equal(first.currency, 'INR');
      assert.equal(first.bill_category, 'pharmacy');
      assert.equal(first.original_file_name, null);
      assert.equal(first.storage_path, null);
      assert.equal(first.file_size, null);
      assert.equal(first.tables[0].columns.length, 6);
      assert.equal(first.fields[0].value, 'A');
      assert.equal(Number(first.total), 42.25);
    });

    await t.test('rerunning preserves legacy foreign rows and files and removes old RPC overloads', async () => {
      await db.exec(`
        create function public.save_bill_with_duplicate_guard(uuid,text,text,text,date,numeric,jsonb,text,text,text,bigint,text,smallint,boolean)
          returns public.bills language sql as $$select null::public.bills$$;
        create function public.save_bill_with_duplicate_guard(uuid,text,text,text,date,numeric,jsonb,text,text,text,bigint,text,smallint,boolean,jsonb,jsonb,text,text,uuid)
          returns public.bills language sql as $$select null::public.bills$$;
        alter table public.bills drop constraint bills_inr_only_check;
        alter table public.bills drop constraint bills_data_only_check;
        alter table public.bills drop constraint bills_ledger_owner_fk;
        update storage.buckets set allowed_mime_types = array['image/png'] where id = 'bill-files';
        create policy legacy_unrestricted_bills on public.bills for all to public using (true) with check (true);
        create policy legacy_unrestricted_ledgers on public.bill_ledgers for all to public using (true) with check (true);
        create policy legacy_unrestricted_storage on storage.objects for all to public using (true) with check (true);
        grant all on public.bills, public.bill_ledgers to anon, authenticated;
      `);
      await db.query(`insert into public.bills(user_id,ledger_id,bill_type,vendor,bill_date,total,source_hash,currency,original_file_name,storage_path,file_size)
        values ($1,$2,'expense','Legacy foreign hospital','2025-01-01',50,$3,'USD','original.pdf',$4,1000)`,
        [userA, ledgerA, '0'.repeat(64), userA + '/' + ledgerA + '/original.pdf']);
      await db.query(`insert into public.bills(user_id,ledger_id,bill_type,bill_number,bill_date,total,source_hash,ingestion_id)
        values ($1,$2,'expense','LEGACY-MISMATCH','2025-01-01',1,$3,$4)`,
        [userA, ledgerB, 'ab'.repeat(32), 'ffffffff-ffff-4fff-8fff-ffffffffffff']);
      await db.query("insert into storage.objects(bucket_id,name) values ('bill-files',$1),('bill-files',$2)",
        [userA + '/' + ledgerA + '/original.pdf', userB + '/' + ledgerB + '/original.pdf']);
      await db.exec(migration);
      assert.equal((await db.query('select count(*)::int n from public.bills')).rows[0].n, 3);
      const legacy = (await db.query("select * from public.bills where currency = 'USD'")).rows[0];
      assert.equal(Number(legacy.total), 50);
      assert.equal(legacy.original_file_name, 'original.pdf');
      assert.equal(legacy.storage_path, userA + '/' + ledgerA + '/original.pdf');
      assert.equal((await db.query('select count(*)::int n from storage.objects')).rows[0].n, 2);
      assert.equal((await db.query("select count(*)::int n from pg_proc where proname = 'save_bill_with_duplicate_guard'")).rows[0].n, 1);
      const mime = (await db.query("select allowed_mime_types from storage.buckets where id = 'bill-files'")).rows[0].allowed_mime_types;
      assert.ok(mime.includes('text/csv'));
      assert.ok(mime.includes('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'));
    });

    await t.test('same ingestion token returns the committed row including forced duplicate retries', async () => {
      const before = (await db.query('select count(*)::int n from public.bills')).rows[0].n;
      const retry = await asUser(userA, () => save({ p_force_duplicate: true }));
      assert.equal(retry.id, first.id);
      assert.equal((await db.query('select count(*)::int n from public.bills')).rows[0].n, before);
      await assert.rejects(asUser(userA, () => save({ p_source_hash: 'b'.repeat(64) })), { code: '22023' });
    });

    await t.test('duplicates require override while old optional-argument calls still work', async () => {
      await assert.rejects(asUser(userA, () => save({ p_ingestion_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' })), { code: '23505' });
      const forced = await asUser(userA, () => save({ p_force_duplicate: true }, false));
      assert.notEqual(forced.id, first.id);
      assert.equal(forced.force_uploaded, true);
      assert.equal(forced.bill_category, 'other');
      assert.equal(forced.currency, 'INR');
      assert.deepEqual(forced.tables, []);
    });

    await t.test('accounts cannot see other bills or create rows for another ledger', async () => {
      assert.equal((await asUser(userB, () => db.query('select * from public.bills'))).rows.length, 0);
      assert.equal((await asUser(userB, () => db.query('select * from public.bill_ledgers'))).rows[0].id, ledgerB);
      await assert.rejects(asUser(userB, () => save()), { code: '42501' });
      assert.equal((await asUser(userA, () => db.query("select * from public.bills where bill_number = 'LEGACY-MISMATCH'"))).rows.length, 0);
      await assert.rejects(asUser(userA, () => save({
        p_ledger_id: ledgerB, p_source_hash: 'ab'.repeat(32),
        p_ingestion_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      })), { code: '42501' });
      const own = await asUser(userB, () => save({ p_ledger_id: ledgerB }));
      assert.equal(own.user_id, userB);
      assert.equal(own.source_hash, hash);
      await assert.rejects(asUser(null, () => save(), 'anon'), { code: '42501' });
      await assert.rejects(asUser(null, () => db.query('select * from public.bills'), 'anon'), { code: '42501' });
    });

    await t.test('foreign currencies, attachments, invalid categories and malformed data fail before insert', async () => {
      const token = { p_ingestion_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', p_source_hash: 'e'.repeat(64) };
      for (const patch of [{ p_total: 0 }, { p_total: 'NaN' }, { p_total: '1.001' }, { p_bill_date: 'infinity' }, { p_items: {} }, { p_tables: [1] }, { p_currency: 'RUPEES' }, { p_currency: 'USD' }, { p_currency: 'EUR' }, { p_currency: 'XXX' }, { p_bill_category: 'shopping' }, { p_bill_category: '' }, { p_original_file_name: 'bill.pdf' }, { p_file_size: 1000 }]) {
        await assert.rejects(asUser(userA, () => save({ ...token, ...patch })), { code: '22023' });
      }
      await assert.rejects(asUser(userA, () => save({ ...token, p_storage_path: userB + '/' + ledgerB + '/bill.pdf' })), { code: '22023' });
      await assert.rejects(asUser(userA, () => save({ ...token, p_storage_path: userA + '/' + ledgerA + '/missing.pdf' })), { code: '22023' });
      await assert.rejects(asUser(userA, () => save({ p_storage_path: userA + '/' + ledgerA + '/original.pdf' })), { code: '22023' });
      await assert.rejects(asUser(userA, () => save({ p_currency: 'USD' })), { code: '22023' });
    });

    await t.test('all hospital categories save data without source files', async () => {
      const categories = ['pharmacy', 'medical_stock', 'patient', 'discharge', 'outpatient', 'inpatient', 'laboratory', 'diagnostics', 'procedure', 'emergency', 'other'];
      for (const [index, category] of categories.entries()) {
        const saved = await asUser(userA, () => save({ p_ingestion_id: null, p_source_hash: (index + 16).toString(16).repeat(32), p_bill_category: category }));
        assert.equal(saved.bill_category, category);
        assert.equal(saved.storage_path, null);
      }
    });

    await t.test('table constraints also forbid foreign and attachment inserts by privileged callers', async () => {
      for (const [column, value] of [['currency', 'USD'], ['currency', 'XXX'], ['original_file_name', 'new.pdf'], ['storage_path', userA + '/' + ledgerA + '/new.pdf'], ['file_size', 1000], ['bill_category', 'unknown']]) {
        await assert.rejects(db.query(`insert into public.bills(user_id,ledger_id,bill_type,bill_date,total,source_hash,${column}) values ($1,$2,'expense','2026-10-18',1,$3,$4)`,
          [userA, ledgerA, '9'.repeat(64), value]), { code: '23514' });
      }
    });

    await t.test('restrictive policies defeat legacy broad grants and storage policies', async () => {
      await db.exec('grant insert, update on public.bills to authenticated; grant select on public.bills, public.bill_ledgers to anon');
      await assert.rejects(asUser(userA, () => db.query('insert into public.bills select * from public.bills limit 1')), { code: '42501' });
      assert.equal((await asUser(userA, () => db.query("update public.bills set vendor = 'hacked' returning id"))).rows.length, 0);
      assert.equal((await asUser(null, () => db.query('select * from public.bills'), 'anon')).rows.length, 0);
      const nameA = userA + '/' + ledgerA + '/original.pdf';
      const nameB = userB + '/' + ledgerB + '/original.pdf';
      await assert.rejects(asUser(userA, () => db.query("insert into storage.objects(bucket_id,name) values ('bill-files',$1)", [nameA + '-new'])), { code: '42501' });
      await assert.rejects(asUser(userB, () => db.query("insert into storage.objects(bucket_id,name) values ('bill-files',$1)", [nameB + '-new'])), { code: '42501' });
      assert.deepEqual((await asUser(userA, () => db.query('select name from storage.objects'))).rows.map(row => row.name), [nameA]);
      assert.equal((await asUser(null, () => db.query('select * from storage.objects'), 'anon')).rows.length, 0);
      await assert.rejects(asUser(userA, () => db.query("insert into storage.objects(bucket_id,name) values ('bill-files',$1)", [nameB + '-foreign'])), { code: '42501' });
      await assert.rejects(asUser(userA, () => db.query("insert into storage.objects(bucket_id,name) values ('bill-files',$1)", [userA + '/' + ledgerB + '/wrong-ledger.pdf'])), { code: '42501' });
      assert.equal((await asUser(userA, () => db.query("update storage.objects set name = name || '.changed' returning id"))).rows.length, 0);
      await assert.rejects(asUser(userA, () => save({ p_ingestion_id: null, p_source_hash: 'f'.repeat(64), p_storage_path: nameA })), { code: '22023' });
      assert.equal((await asUser(userA, () => db.query('delete from storage.objects where name = $1 returning id', [nameB]))).rows.length, 0);
      assert.equal((await asUser(userA, () => db.query('delete from storage.objects where name = $1 returning id', [nameA]))).rows.length, 1);
      await db.exec("insert into storage.buckets(id,name,public) values ('public-assets','public-assets',true); insert into storage.objects(bucket_id,name) values ('public-assets','logo.png')");
      assert.equal((await asUser(null, () => db.query("select * from storage.objects where bucket_id = 'public-assets'"), 'anon')).rows.length, 1);
    });
  } finally {
    await db.close();
  }
});

test('migration preserves unknown historical amounts when the old schema has no currency column', { skip: !PGlite && 'Install @electric-sql/pglite to execute PostgreSQL tests' }, async () => {
  const db = new PGlite({ extensions: { pgcrypto } });
  const migration = fs.readFileSync(path.join(__dirname, '..', 'supabase-setup.sql'), 'utf8').replace(/^\uFEFF/, '');
  const userId = '11111111-1111-4111-8111-111111111111';
  const ledgerId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const oldBillId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  try {
    await db.exec(platformSetup);
    // A populated deployment from before currency and flexible-data support.
    await db.exec(`
      create table public.bill_ledgers (
        id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
        name text not null, created_at timestamptz not null default now()
      );
      create table public.bills (
        id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id),
        ledger_id uuid not null references public.bill_ledgers(id), bill_type text not null,
        vendor text, bill_number text, bill_date date not null, total numeric(14,2) not null,
        items jsonb not null default '[]'::jsonb, source_hash text not null,
        original_file_name text, storage_path text, file_size bigint, ocr_text text,
        extraction_confidence smallint, force_uploaded boolean not null default false,
        created_at timestamptz not null default now()
      );
    `);
    await db.query('insert into auth.users values ($1)', [userId]);
    await db.query('insert into public.bill_ledgers(id,user_id,name) values ($1,$2,$3)', [ledgerId, userId, 'Historical bills']);
    await db.query(`insert into public.bills(id,user_id,ledger_id,bill_type,bill_date,total,source_hash)
      values ($1,$2,$3,'expense','2025-01-01',123.45,$4)`, [oldBillId, userId, ledgerId, 'a'.repeat(64)]);

    await db.exec(migration);
    const old = (await db.query('select * from public.bills where id = $1', [oldBillId])).rows[0];
    assert.equal(old.currency, 'XXX');
    assert.equal(Number(old.total), 123.45);
    assert.equal(old.bill_category, 'other');
    assert.equal((await db.query("select column_default from information_schema.columns where table_schema='public' and table_name='bills' and column_name='currency'")).rows[0].column_default, "'INR'::text");

    await db.exec('set role authenticated');
    await db.query("select set_config('request.jwt.claim.sub', $1, false)", [userId]);
    let saved;
    try {
      saved = (await db.query(`select saved.* from public.save_bill_with_duplicate_guard(
        p_ledger_id := $1, p_bill_type := 'expense', p_vendor := 'Hospital',
        p_bill_number := 'NEW-1', p_bill_date := '2026-10-18', p_total := 75,
        p_items := '[]', p_source_hash := $2, p_original_file_name := null,
        p_storage_path := null, p_file_size := null, p_ocr_text := '',
        p_extraction_confidence := 80::smallint
      ) saved`, [ledgerId, 'b'.repeat(64)])).rows[0];
    } finally { await db.exec('reset role'); }
    assert.equal(saved.currency, 'INR');
    assert.equal(Number(saved.total), 75);

    await db.exec(migration);
    const records = (await db.query('select id,currency,total from public.bills')).rows;
    assert.equal(records.length, 2);
    assert.equal(records.find(row => row.id === oldBillId).currency, 'XXX');
    assert.equal(Number(records.find(row => row.id === oldBillId).total), 123.45);
    assert.equal(records.find(row => row.id === saved.id).currency, 'INR');
  } finally { await db.close(); }
});
