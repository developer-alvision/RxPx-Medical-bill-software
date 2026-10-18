-- RxPx Bills: run this entire file in Supabase Dashboard -> SQL Editor.
-- Safe to rerun: existing bill rows and legacy original documents are kept.
-- New records contain extracted hospital bill data only, in Indian rupees.
-- Supabase is the source of truth; Excel exports are generated from saved rows.
begin;

create extension if not exists pgcrypto;

create table if not exists public.bill_ledgers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (char_length(btrim(name)) between 1 and 120),
  created_at timestamptz not null default now()
);

create unique index if not exists bill_ledgers_one_name_per_user
  on public.bill_ledgers (user_id, lower(btrim(name)));
create unique index if not exists bill_ledgers_id_user_id
  on public.bill_ledgers (id, user_id);

create table if not exists public.bills (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  ledger_id uuid not null references public.bill_ledgers(id) on delete cascade,
  bill_type text not null check (bill_type in ('expense', 'income')),
  vendor text,
  bill_number text,
  bill_date date not null,
  total numeric(14,2) not null check (total > 0),
  items jsonb not null default '[]'::jsonb check (jsonb_typeof(items) = 'array'),
  source_hash text not null check (char_length(source_hash) between 32 and 128),
  original_file_name text,
  storage_path text,
  file_size bigint,
  ocr_text text,
  extraction_confidence smallint check (extraction_confidence between 0 and 100),
  force_uploaded boolean not null default false,
  created_at timestamptz not null default now()
);

-- Flexible columns and source tables preserve bills with any column count.
alter table public.bills
  add column if not exists tables jsonb not null default '[]'::jsonb,
  add column if not exists fields jsonb not null default '[]'::jsonb,
  add column if not exists currency text not null default 'XXX',
  add column if not exists bill_category text not null default 'other',
  add column if not exists extraction_method text,
  add column if not exists ingestion_id uuid not null default gen_random_uuid();

-- Older schemas did not record currency. Mark their existing amounts unknown
-- (ISO XXX) rather than silently labelling them rupees. A missing column gets
-- the historical marker above; existing currency values remain untouched.
alter table public.bills alter column currency set default 'INR';

-- NOT VALID preserves older records while enforcing these rules for new rows.
-- RLS below also hides any legacy bill associated with another user's ledger.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'bills_ledger_owner_fk' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_ledger_owner_fk
      foreign key (ledger_id, user_id) references public.bill_ledgers(id, user_id)
      on delete cascade not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_flexible_data_check' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_flexible_data_check check (
      jsonb_typeof(tables) = 'array' and jsonb_typeof(fields) = 'array'
      and currency ~ '^[A-Z]{3}$'
      and (extraction_method is null or char_length(extraction_method) between 1 and 80)
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_private_storage_path_check' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_private_storage_path_check check (
      storage_path is null or (
        split_part(storage_path, '/', 1) = user_id::text
        and split_part(storage_path, '/', 2) = ledger_id::text
        and cardinality(string_to_array(storage_path, '/')) = 3
        and split_part(storage_path, '/', 3) not in ('', '.', '..')
        and char_length(storage_path) <= 1024
      )
    ) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_inr_only_check' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_inr_only_check
      check (currency = 'INR') not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_data_only_check' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_data_only_check
      check (original_file_name is null and storage_path is null and file_size is null) not valid;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'bills_hospital_category_check' and conrelid = 'public.bills'::regclass) then
    alter table public.bills add constraint bills_hospital_category_check check (
      bill_category in ('pharmacy', 'medical_stock', 'patient', 'discharge',
        'outpatient', 'inpatient', 'laboratory', 'diagnostics', 'procedure',
        'emergency', 'other')
    ) not valid;
  end if;
end;
$$;

create index if not exists bills_user_created_at on public.bills (user_id, created_at desc);
create index if not exists bills_ledger_created_at on public.bills (ledger_id, created_at desc);
create index if not exists bills_user_source_hash on public.bills (user_id, source_hash);
create index if not exists bills_user_normalized_source_hash on public.bills (user_id, lower(source_hash));
create unique index if not exists bills_user_ingestion_id on public.bills (user_id, ingestion_id);

alter table public.bill_ledgers enable row level security;
alter table public.bills enable row level security;

-- Restrictive boundaries are ANDed with every permissive policy, including any
-- broad policy left by an older setup. They apply to PUBLIC as well as members
-- of authenticated, so an old anonymous policy cannot expose these records.
drop policy if exists "Bill ledger account boundary" on public.bill_ledgers;
create policy "Bill ledger account boundary" on public.bill_ledgers
  as restrictive for all to public
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users read only their bill names" on public.bill_ledgers;
create policy "Users read only their bill names" on public.bill_ledgers
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users create only their bill names" on public.bill_ledgers;
create policy "Users create only their bill names" on public.bill_ledgers
  for insert to authenticated with check (user_id = (select auth.uid()));
drop policy if exists "Users change only their bill names" on public.bill_ledgers;
create policy "Users change only their bill names" on public.bill_ledgers
  for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
drop policy if exists "Users delete only their bill names" on public.bill_ledgers;
create policy "Users delete only their bill names" on public.bill_ledgers
  for delete to authenticated using (user_id = (select auth.uid()));

drop policy if exists "Bill account and ledger boundary" on public.bills;
create policy "Bill account and ledger boundary" on public.bills
  as restrictive for all to public
  using (
    user_id = (select auth.uid()) and exists (
      select 1 from public.bill_ledgers l
      where l.id = bills.ledger_id and l.user_id = (select auth.uid())
    )
  )
  with check (
    user_id = (select auth.uid()) and exists (
      select 1 from public.bill_ledgers l
      where l.id = bills.ledger_id and l.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users read only their bills" on public.bills;
create policy "Users read only their bills" on public.bills
  for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "Users delete only their bills" on public.bills;
create policy "Users delete only their bills" on public.bills
  for delete to authenticated using (user_id = (select auth.uid()));

-- Authenticated inserts must use the duplicate/idempotency guard. Restrictive
-- denials also protect projects that retain an older permissive write policy.
drop policy if exists "Bills require guarded insert" on public.bills;
create policy "Bills require guarded insert" on public.bills
  as restrictive for insert to public with check (false);
drop policy if exists "Bills disallow direct update" on public.bills;
create policy "Bills disallow direct update" on public.bills
  as restrictive for update to public using (false) with check (false);

revoke all on public.bill_ledgers, public.bills from public, anon, authenticated;
grant select, insert, delete on public.bill_ledgers to authenticated;
grant update (name) on public.bill_ledgers to authenticated;
grant select, delete on public.bills to authenticated;

-- Remove the old overload so named RPC calls with optional arguments resolve
-- unambiguously. This drops only a function, never bill data.
drop function if exists public.save_bill_with_duplicate_guard(
  uuid, text, text, text, date, numeric, jsonb, text, text, text, bigint,
  text, smallint, boolean
);
drop function if exists public.save_bill_with_duplicate_guard(
  uuid, text, text, text, date, numeric, jsonb, text, text, text, bigint,
  text, smallint, boolean, jsonb, jsonb, text, text, uuid
);

create or replace function public.save_bill_with_duplicate_guard(
  p_ledger_id uuid,
  p_bill_type text,
  p_vendor text,
  p_bill_number text,
  p_bill_date date,
  p_total numeric,
  p_items jsonb,
  p_source_hash text,
  p_original_file_name text,
  p_storage_path text,
  p_file_size bigint,
  p_ocr_text text,
  p_extraction_confidence smallint,
  p_force_duplicate boolean default false,
  p_tables jsonb default '[]'::jsonb,
  p_fields jsonb default '[]'::jsonb,
  p_currency text default 'INR',
  p_extraction_method text default null,
  p_ingestion_id uuid default null,
  p_bill_category text default 'other'
)
returns public.bills
language plpgsql
security definer
set search_path = ''
as $$
declare
  account_id uuid := auth.uid();
  saved_bill public.bills;
  source_hash_value text := lower(btrim(p_source_hash));
  currency_value text := upper(btrim(coalesce(p_currency, 'INR')));
  category_value text := lower(btrim(coalesce(p_bill_category, 'other')));
begin
  if account_id is null then
    raise exception using errcode = '42501', message = 'You must be signed in.';
  end if;

  if currency_value <> 'INR' then
    raise exception using errcode = '22023', message = 'Only Indian rupee (INR) bills can be saved. Foreign amounts are not converted.';
  end if;
  if p_original_file_name is not null or p_storage_path is not null or p_file_size is not null then
    raise exception using errcode = '22023', message = 'Save extracted bill data only. Original files and attachments are not stored.';
  end if;
  if category_value not in ('pharmacy', 'medical_stock', 'patient', 'discharge',
    'outpatient', 'inpatient', 'laboratory', 'diagnostics', 'procedure',
    'emergency', 'other') then
    raise exception using errcode = '22023', message = 'Choose a supported hospital bill category.';
  end if;

  -- Check ownership even for retries: NOT VALID intentionally preserves older
  -- mismatched rows, which must stay inaccessible through this definer RPC.
  -- Lock the owned ledger so deletion cannot race validation and insert.
  perform 1 from public.bill_ledgers
    where id = p_ledger_id and user_id = account_id for key share;
  if not found then
    raise exception using errcode = '42501', message = 'The selected bill name is not available to this account.';
  end if;

  -- A retry after a timeout returns the committed row even when duplicate
  -- override was enabled. Concurrent calls with this token serialize first.
  if p_ingestion_id is not null then
    perform pg_advisory_xact_lock(hashtextextended(account_id::text || ':ingestion:' || p_ingestion_id::text, 0));
    select * into saved_bill from public.bills
      where user_id = account_id and ingestion_id = p_ingestion_id;
    if found then
      if saved_bill.ledger_id is distinct from p_ledger_id
        or lower(saved_bill.source_hash) is distinct from source_hash_value then
        raise exception using errcode = '22023', message = 'This upload token belongs to another document. Select the file again.';
      end if;
      return saved_bill;
    end if;
  end if;

  if p_bill_type is null or p_bill_type not in ('expense', 'income') then
    raise exception using errcode = '22023', message = 'Invalid bill type.';
  end if;
  if p_total is null or not (p_total between 0.01 and 999999999999.99) or p_total <> round(p_total, 2) then
    raise exception using errcode = '22023', message = 'Enter a positive total with at most two decimal places.';
  end if;
  if p_bill_date is null or not isfinite(p_bill_date) then
    raise exception using errcode = '22023', message = 'A valid bill date is required.';
  end if;
  if source_hash_value is null or source_hash_value !~ '^[a-f0-9]{32,128}$' then
    raise exception using errcode = '22023', message = 'A valid document hash is required.';
  end if;
  if p_extraction_confidence is not null and p_extraction_confidence not between 0 and 100 then
    raise exception using errcode = '22023', message = 'Extraction confidence must be between 0 and 100.';
  end if;
  if char_length(coalesce(p_vendor, '')) > 1000 or char_length(coalesce(p_bill_number, '')) > 200
    or char_length(coalesce(p_ocr_text, '')) > 1000000
    or char_length(coalesce(p_extraction_method, '')) > 80 then
    raise exception using errcode = '22023', message = 'The extracted document contains an oversized field.';
  end if;

  -- Keep arbitrary original keys and columns; require structured arrays rather
  -- than accepting malformed scalar JSON or an unbounded payload.
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_tables, '[]'::jsonb)) <> 'array'
    or jsonb_typeof(coalesce(p_fields, '[]'::jsonb)) <> 'array' then
    raise exception using errcode = '22023', message = 'Items, tables and fields must be JSON arrays.';
  end if;
  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 20000
    or jsonb_array_length(coalesce(p_tables, '[]'::jsonb)) > 100
    or jsonb_array_length(coalesce(p_fields, '[]'::jsonb)) > 20000
    or octet_length(coalesce(p_items, '[]'::jsonb)::text)
      + octet_length(coalesce(p_tables, '[]'::jsonb)::text)
      + octet_length(coalesce(p_fields, '[]'::jsonb)::text) > 10485760 then
    raise exception using errcode = '22023', message = 'The extracted document exceeds the supported size.';
  end if;
  if exists (select 1 from jsonb_array_elements(coalesce(p_items, '[]'::jsonb)) value where jsonb_typeof(value) <> 'object')
    or exists (select 1 from jsonb_array_elements(coalesce(p_tables, '[]'::jsonb)) value where jsonb_typeof(value) <> 'object')
    or exists (select 1 from jsonb_array_elements(coalesce(p_fields, '[]'::jsonb)) value where jsonb_typeof(value) <> 'object') then
    raise exception using errcode = '22023', message = 'Each extracted item, table and field must be an object.';
  end if;

  -- Serialize different upload tokens for the same source, closing races
  -- between browser tabs. An explicit duplicate override remains supported.
  perform pg_advisory_xact_lock(hashtextextended(account_id::text || ':source:' || source_hash_value, 0));
  if not coalesce(p_force_duplicate, false) and exists (
    select 1 from public.bills where user_id = account_id and lower(source_hash) = source_hash_value
  ) then
    raise exception using errcode = '23505', message = 'This document is already saved in this account.';
  end if;

  insert into public.bills (
    user_id, ledger_id, bill_type, vendor, bill_number, bill_date, total, items,
    source_hash, original_file_name, storage_path, file_size, ocr_text,
    extraction_confidence, force_uploaded, tables, fields, currency,
    extraction_method, ingestion_id, bill_category
  ) values (
    account_id, p_ledger_id, p_bill_type, nullif(btrim(p_vendor), ''),
    nullif(btrim(p_bill_number), ''), p_bill_date, p_total,
    coalesce(p_items, '[]'::jsonb), source_hash_value, null,
    null, null, p_ocr_text, p_extraction_confidence,
    coalesce(p_force_duplicate, false), coalesce(p_tables, '[]'::jsonb),
    coalesce(p_fields, '[]'::jsonb), currency_value,
    nullif(btrim(p_extraction_method), ''), coalesce(p_ingestion_id, gen_random_uuid()), category_value
  ) returning * into saved_bill;

  return saved_bill;
end;
$$;

revoke all on function public.save_bill_with_duplicate_guard(
  uuid, text, text, text, date, numeric, jsonb, text, text, text, bigint,
  text, smallint, boolean, jsonb, jsonb, text, text, uuid, text
) from public, anon, authenticated;
grant execute on function public.save_bill_with_duplicate_guard(
  uuid, text, text, text, date, numeric, jsonb, text, text, text, bigint,
  text, smallint, boolean, jsonb, jsonb, text, text, uuid, text
) to authenticated;

-- Keep the legacy bucket private for owners to read or delete existing files.
-- Restrictive policies below reject every new original and replacement.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'bill-files', 'bill-files', false, 26214400,
  array[
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif',
    'image/gif', 'image/bmp', 'image/tiff', 'application/pdf',
    'text/csv', 'application/csv', 'text/plain',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  ]
)
on conflict (id) do update
set public = false, file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

-- Scope this boundary only to our bucket; unrelated application buckets keep
-- their own policies. Anonymous and cross-account access stay denied even if
-- another permissive storage policy exists in this project.
drop policy if exists "Bill file account and ledger boundary" on storage.objects;
create policy "Bill file account and ledger boundary" on storage.objects
  as restrictive for all to public
  using (
    bucket_id <> 'bill-files' or (
      (storage.foldername(name))[1] = (select auth.uid()::text)
      and cardinality(storage.foldername(name)) = 2
    )
  )
  with check (
    bucket_id <> 'bill-files' or (
      (storage.foldername(name))[1] = (select auth.uid()::text)
      and cardinality(storage.foldername(name)) = 2
    )
  );

-- Only authenticated policies read our private ledger table. Applying this
-- subquery to anon would deny their unrelated public buckets at grant checking.
drop policy if exists "Bill files require an owned ledger" on storage.objects;
create policy "Bill files require an owned ledger" on storage.objects
  as restrictive for all to authenticated
  using (
    bucket_id <> 'bill-files' or exists (select 1 from public.bill_ledgers l
      where l.id::text = (storage.foldername(objects.name))[2] and l.user_id = (select auth.uid()))
  )
  with check (
    bucket_id <> 'bill-files' or exists (select 1 from public.bill_ledgers l
      where l.id::text = (storage.foldername(objects.name))[2] and l.user_id = (select auth.uid()))
  );

drop policy if exists "Bill originals cannot be overwritten" on storage.objects;
create policy "Bill originals cannot be overwritten" on storage.objects
  as restrictive for update to public
  using (bucket_id <> 'bill-files') with check (bucket_id <> 'bill-files');

drop policy if exists "Users read their private bill files" on storage.objects;
create policy "Users read their private bill files" on storage.objects
  for select to authenticated using (
    bucket_id = 'bill-files' and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
drop policy if exists "Users upload their private bill files" on storage.objects;
drop policy if exists "Bill originals cannot be uploaded" on storage.objects;
create policy "Bill originals cannot be uploaded" on storage.objects
  as restrictive for insert to public with check (bucket_id <> 'bill-files');
drop policy if exists "Users delete their private bill files" on storage.objects;
create policy "Users delete their private bill files" on storage.objects
  for delete to authenticated using (
    bucket_id = 'bill-files' and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

-- PostgREST picks up the extended RPC and new JSONB columns immediately.
notify pgrst, 'reload schema';
commit;
