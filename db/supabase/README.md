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

## Import new Enable Banking transactions

Run `schema.sql` first if the base `transactions` table has not been created.
Then run `transaction_import.sql` in the Supabase SQL Editor. The import
migration adds nullable source-reference columns without changing existing
transaction UUIDs or backfilling existing rows. It also adds `inserted_at`,
which is set by the database for new rows; existing rows remain `NULL`. Its
initial watermark starts at the first day of the month when the migration is
applied.

Create `api\supabase-config.json` with the project URL and server-only
service-role key. This file is ignored by Git. Never put the service-role key
in `docs\supabase-config.js` or commit it:

```json
{
  "url": "https://<project-ref>.supabase.co",
  "service_role_key": "<service-role-key>"
}
```

The importer also accepts `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`
environment variables, which take precedence over the config file.

## GitHub Actions setup

In the repository's **Settings → Secrets and variables → Actions**, add these
repository variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Supabase project URL |
| `ENABLEBANKING_APP_ID` | Enable Banking application ID |
| `ENABLEBANKING_BASE_URL` | Enable Banking API URL; optional, defaults to `https://api.enablebanking.com` |

Add these repository secrets:

| Secret | Value |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; never use the browser anon key |
| `ENABLEBANKING_CERTIFICATE_PEM` | Full PEM certificate/private-key contents required by the Enable Banking SDK |
| `ENABLEBANKING_ACCOUNT_UIDS` | JSON array of authorized account UIDs, e.g. `["uid-1","uid-2"]` |

Enter the PEM contents directly as a GitHub secret; do not commit a PEM file or
put secret values in workflow YAML. Copy the account UIDs from an existing
authorized Enable Banking account configuration (for example, the `accounts`
array in the ignored local `api/session.json`) into the JSON-array secret. The
SDK uses the account UIDs for requests; the saved session ID is not required.
This importer does not perform interactive bank consent. If access is revoked,
complete the bank's authorization process separately and update the account
UID secret as needed.

The `Import bank transactions` workflow runs daily at 05:20 UTC and is also
available for manual runs from the Actions tab. It has read-only repository
permissions, serializes runs, and exposes credentials only to the import step.
The static Pages workflow uploads only `docs/`, not the rest of the repository.

The import script can also be run locally after installing dependencies with
`pip install -r requirements.txt` from `api`. Supply the Enable Banking values
through environment variables; Supabase values can come from the ignored local
config file above or environment variables. The script processes transactions
in memory and does not create raw CSVs, categorized CSVs, or a session file.

It fetches from the stored watermark with a two-day overlap, stages categorized
rows, and calls a database function that inserts only missing `(source_system,
source_entry_reference)` values. A unique index and `ON CONFLICT DO NOTHING`
make retries safe; existing transaction content is never updated by this
import. The watermark advances only when all account fetches and the import
complete successfully.
