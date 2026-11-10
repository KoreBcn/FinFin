# Supabase database setup

The schema keeps each transaction in one fact table. `Month` and `Year` are
omitted because they are derived from `transaction_date`. `Planned/Rea` is
retained as `transaction_status`: it currently contains only `REA`, but it
represents whether a transaction is planned or actual and is not derivable.

## Generate and load the local CSV

From the repository root, run:

```powershell
python db\supabase\generate_seed.py
```

This reads `db\db.csv` locally and writes `db\supabase\seed.sql`. Then run
`schema.sql` followed by `seed.sql` in the Supabase SQL Editor.

The generated seed is repeatable: it uses stable UUIDs and upserts by `id`.
Invalid or repeated IDs in the CSV get deterministic replacement UUIDs, so
no source rows are discarded. The script supports the date formats currently
present in the CSV and strips thousands separators from amounts. Empty comments
are inserted as `NULL`.

Row Level Security is enabled. The schema grants authenticated Supabase users
read/write access to the shared transactions table; anonymous users have no
access. If you need per-user transaction isolation, add an owner column and
replace this shared-access policy with user-scoped policies.

## Configure the frontend

Set `url` and `anonKey` in `docs\supabase-config.js` using the Supabase
project URL and the public anon/publishable key. Never put a `service_role`
key in the browser. The frontend calls Supabase directly; RLS protects the
table and Supabase Auth manages passwords.

Create or invite users in the Supabase Dashboard under Authentication, then
sign in through the app with that user's email and password. Password sign-up
is intentionally not exposed in the frontend.

The app loads data from Supabase after sign-in. Updates, inserts, deletes, and
duplicates also go directly to `public.transactions`; the local Flask CSV API
is no longer used by the browser.
