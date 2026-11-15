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

## House installments

Run `house_installments.sql` in the Supabase SQL Editor to create or upgrade the
shared installments and House configuration tables. Then insert the matching
references in the SQL Editor, replacing the placeholders with the values from
the local `house-config.json`. Do not commit the completed SQL or publish the
references on GitHub Pages:

```sql
INSERT INTO public.house_config (id, installment_concept, interest_concept)
VALUES (true, 'your exact payment description', 'text in your interest description')
ON CONFLICT (id) DO UPDATE SET
    installment_concept = EXCLUDED.installment_concept,
    interest_concept = EXCLUDED.interest_concept;
```

The references are shared with all authenticated Supabase users, as are the
House installments; anonymous users cannot read them. Authenticated users can
only read the configuration, not modify it through the app. Payment descriptions
match exactly and interest descriptions match by substring; the interest
reference must not be contained in the payment reference.

The upgrade assigns existing entries `Bank installment`
or `Interest / Adjustment` based on their amount. Authenticated users can read,
insert, and delete entries; anonymous access is revoked. Each entry has an entry
date, signed DKK amount, concept, entry type, and database-generated insertion
timestamp. Existing entries are assigned type `regular` on upgrade. Positive
regular amounts represent payments; negative amounts represent interest or
other adjustments. Bank transactions remain in `transactions` and are not
copied into this table.

The initial payment is no longer hardcoded. To add it or another entry with a
custom concept, run an insert once in the SQL Editor, changing the values as
needed. Avoid inserting the same entry twice:

```sql
INSERT INTO public.house_installments (entry_date, amount, concept, entry_type)
VALUES ('2026-01-01', 800000, 'Initial payment', 'initial_payment');
```

If the initial payment already exists, update its `entry_type` to
`initial_payment` instead of inserting it again. Insert loan and setup costs
with type `mortgage_component`. The House view sums the absolute values of
these two types for the mortgage value. Components do not count as direct equity
payments or interest, but the initial payment counts as equity. At least one
mortgage entry is required before House totals can be calculated.

## Portfolio

Run `portfolio.sql` in the Supabase SQL Editor. It creates shared
`portfolio_items` and `portfolio_transactions` tables. Authenticated users
can read both tables, create and update items, and are not isolated from each
other. Anonymous access is revoked. Run the updated `portfolio.sql` again when
upgrading an existing installation. The app adds transactions through an
authenticated database function; direct transaction writes remain unavailable
to authenticated users. The SQL Editor can be used to correct them.

The function copies the selected item's ticker, platform, name and type into
each new transaction. An insert trigger clears saved values for priced items
after a buy or sell, but leaves manually entered crowdlending values intact.
Price refreshes use a valuation version to reject a stale value if a trade was
inserted while the refresh was running. Other clients that write valuations
must use the same version check to avoid overwriting an invalidation.

To migrate the investment CSV, generate a private SQL file locally:

```powershell
python db\supabase\generate_portfolio_seed.py "C:\path\to\transactions.csv" "C:\path\to\private-portfolio-seed.sql"
```

Run the generated SQL in the Supabase SQL Editor after `portfolio.sql`. The
seed creates one item per ticker/platform pair and preserves every source row,
including invalid quantity text. Its transaction IDs are deterministic and
re-running the same seed does not duplicate rows or overwrite existing item
settings. It is a one-off snapshot: editing the source CSV and importing it
again can create additional rows. The generated SQL contains financial data;
keep it private and do not commit it.

Items with positive known net buy/sell quantity and crowdlending items are
initially in scope. Closed or uncertain items are stored out of scope. Change
`is_in_scope` in `portfolio_items` to show or hide an item. Yahoo Finance provides
prices, not owned quantities: the app computes quantities and cash flows from
transactions and stores the latest successfully calculated DKK value on the
item. Out-of-scope items are excluded from display, refresh, and totals.

### Price refresh

Each item's refresh icon calls the authenticated `market-data` Edge Function
for that item. It uses Yahoo Finance's chart endpoint without an API key. Yahoo's
[terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) prohibit
automated data collection without express prior permission; verify you have the
necessary permission before deploying or using it.

Install the Supabase CLI and authenticate, then deploy from the repository root.
Run `supabase init` only if `supabase\config.toml` does not already exist:

```powershell
supabase init
supabase login
supabase link --project-ref <your-project-ref>
supabase functions deploy market-data --use-api
```

Publish the updated frontend and deploy the updated function together. Older
frontends that send separate MIC codes are incompatible with the new function.

Keep the function's default JWT verification enabled. The function additionally
requires an authenticated user and only forwards the supported quote, exchange
rate and daily history requests. Once deployed, signed-in users can refresh
prices from GitHub Pages or the local app. The browser paces its requests, but
this is not a server-side rate limit. Yahoo may throttle or change the endpoint,
and quote availability and delay vary by instrument.

The app sends `portfolio_items.ticker` exactly as stored, without instrument
mappings. Update incompatible tickers in Supabase to the intended Yahoo ticker
and verify the listing and currency; for example, `MELI|XNGS` is not a Yahoo
ticker, but `MELI` is. The old `market_symbol` column is retained in the
database but ignored by the app. Existing transactions remain linked by item ID.
Ticker and platform must remain unique together. Re-running an old CSV seed
after renaming a ticker can recreate the old item, so review the import before
re-running it.

The function sends a minimal user agent without cookies or crumb tokens, and
tries Yahoo's `query2` host once if `query1` returns HTTP 429. If both hosts
still rate-limit requests, wait before retrying; the endpoint may not be usable
from the deployed function. This fallback does not guarantee availability. The
app preserves the last saved value on failure.
The unused legacy local Flask `/api/investments/market-data` endpoint still
uses Twelve Data and its local key file; the app does not call it.

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

The `Import bank transactions` workflow runs Monday through Friday at 05:20 UTC
and is also available for manual runs from the Actions tab. It has read-only repository
permissions, serializes runs, and exposes credentials only to the import step.
The static Pages workflow uploads only `docs/`, not the rest of the repository.

The import script can also be run locally after installing dependencies with
`pip install -r requirements.txt` from `api`. Supply the Enable Banking values
through environment variables; Supabase values can come from the ignored local
config file above or environment variables. The script processes transactions
in memory and does not create raw CSVs, categorized CSVs, or a session file.

It fetches from the stored watermark with a seven-day overlap, stages categorized
rows, and calls a database function that inserts only missing `(source_system,
source_entry_reference)` values. A unique index and `ON CONFLICT DO NOTHING`
make retries safe; existing transaction content is never updated by this
import. The watermark advances only when all account fetches and the import
complete successfully.
