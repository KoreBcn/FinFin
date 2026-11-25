# Supabase database setup

The schema keeps each transaction in one fact table. `Month` and `Year` are
omitted because they are derived from `transaction_date`. `Planned/Rea` is
retained as `transaction_status`: it currently contains only `REA`, but it
represents whether a transaction is planned or actual and is not derivable.

## Moving HomeFin into the Meal Plan project

Changing GitHub secrets alone does not move the database. The browser reads
`docs\supabase-config.js` directly, while the bank import and scheduled price
refresh use separate GitHub Actions settings. The two apps will also share
Supabase Auth and project resources.

The shared-project access model is **all Meal Plan household members can access
all HomeFin data**. Other authenticated users must not have access. Removing a
user from `public.household_members` removes their HomeFin access too. The
service-role key bypasses RLS and must remain private. The `market-data` Edge
Function requires a signed-in user but is not restricted to household members;
it does not read HomeFin data.

Do not point the frontend or either workflow at the target until the following
steps have succeeded. These steps require administrative access to both
projects; no database or Auth users are migrated by a code deployment.

1. Back up both projects privately and test the backups. Pause both HomeFin
   scheduled workflows, close the app for all users, and prevent other HomeFin
   writes until cutover and validation are complete. Keep the old project
   intact for rollback.
2. Inspect the live target database for name conflicts, including HomeFin
   tables, functions, indexes and triggers. **Stop if any exist** until their
   owners and compatibility are understood. The checked-in Meal Plan schema
   uses different table names, but it may not reflect the live database. Never
   run Meal Plan's destructive `supabase-import.sql` as part of this migration.
   Compare the live HomeFin schema with the local scripts before applying
   them; do not assume an old generated CSV seed represents current data.
3. Ensure Meal Plan's `public.is_shared_meal_plan_member()` function and
   `public.household_members` table exist. Add the intended HomeFin users to the
   Meal Plan household using the existing Meal Plan administration process.
   Users sign in with their **Meal Plan project's** credentials; HomeFin Auth
   accounts and passwords are not automatically copied. The scheduled refresh
   account must also be a household member, which grants it Meal Plan access.
4. On the target, install the matching HomeFin schema and functions: the base
   `schema.sql` and `category_rules.sql`, followed by `transaction_import.sql`,
   `house_installments.sql`, and this repository's `portfolio.sql`. The first
   two files are ignored local files, so verify they match the live source;
   they are not available in a fresh checkout. Do not load CSV seed data.
   Run `shared_project_access.sql` before importing any HomeFin data: it adds
   restrictive RLS policies to all six user-facing tables. The current
   `portfolio.sql` also checks membership inside its security-definer write
   functions, which bypass RLS, and protects its two tables itself.
   Do not replace these functions with older versions. Review other existing
   grants and security-definer functions in the live projects before import:
   permissive or privileged access outside these scripts can bypass RLS.
5. Copy current data from the **live HomeFin database**, preserving every
   column and ID, not from the old CSVs. Include `transactions`,
   `category_rules`, `house_config`, `house_installments`, `portfolio_items`,
   `portfolio_transactions`, and `transaction_import_state`. In particular,
   preserve transaction source references and the import watermark to avoid
   duplicate imports or missed history. Do not copy in-flight
   `transaction_import_stage` rows. The setup scripts may have inserted
   initial category rules and an import watermark; on a verified fresh target,
   remove only those initialization rows before restoring the source rows.
   Preserve portfolio item values and valuation versions: inserting portfolio
   transactions normally fires an invalidation trigger. If using a database
   owner to restore a dump, disable only user triggers on
   `public.portfolio_transactions` for the restore and re-enable them in the
   **same transaction**; leave foreign-key triggers enabled. Roll back the
   transaction on any failure. Confirm trigger state and compare row counts,
   IDs, balances, saved valuations and the watermark with the source.
6. Deploy `market-data` to the Meal Plan project using the CLI instructions
   below, explicitly linking the **target** project. Check first that the
   target does not already have an unrelated function with that name.
7. Test access before cutover: a household member can read and modify each
   intended HomeFin area, including portfolio transaction RPCs; a signed-in
   non-member cannot read or write the tables or call those RPCs. Also test
   anonymous access and confirm Meal Plan still works. Test with actual
   non-member credentials, not the service-role key.
8. For cutover, replace the URL and **public** publishable/anon key in
   `docs\supabase-config.js` with the Meal Plan project's values and deploy
   Pages. In HomeFin's GitHub Actions settings, update the `SUPABASE_URL` and
   `SUPABASE_ANON_KEY` variables, the `SUPABASE_SERVICE_ROLE_KEY` secret, and
   the refresh email/password secrets to the target project's values. Update
   the ignored local `api\supabase-config.json` as well if using the local
   importer; environment variables take precedence. Do not change the Enable
   Banking credentials unless they themselves need updating.
9. Sign in again, test reads and a reversible write in each app, run each
   HomeFin workflow manually and inspect the results, then re-enable schedules.
   Verify all clients use the target before retiring the old project. If
   rolling back after writes have reached the target, first reconcile those
   writes back to the old project; simply reverting configuration loses them.

For example, with PostgreSQL client tools compatible with both servers, set up
private libpq connection services named `homefin-source` and `mealplan-target`
and a private password file. Set `HOMEFIN_EXPORT` to a private SQL file path,
then, after stopping writes and verifying the target schema:

```powershell
pg_dump --dbname="service=homefin-source" --data-only --column-inserts `
  --table=public.transactions --table=public.category_rules `
  --table=public.house_config --table=public.house_installments `
  --table=public.portfolio_items --table=public.portfolio_transactions `
  --table=public.transaction_import_state --file="$env:HOMEFIN_EXPORT"
```

After confirming the target tables are fresh and removing only the initialization
rows mentioned above, restore with a database owner. `--single-transaction`
and `ON_ERROR_STOP` roll back the trigger change and imported rows together if
the restore fails:

```powershell
psql --dbname="service=mealplan-target" --single-transaction --set=ON_ERROR_STOP=1 `
  --command="ALTER TABLE public.portfolio_transactions DISABLE TRIGGER USER" `
  --file="$env:HOMEFIN_EXPORT" `
  --command="ALTER TABLE public.portfolio_transactions ENABLE TRIGGER USER"
```

Do not put connection passwords on the command line, upload the export as a
GitHub artifact, or restore a full database dump into Meal Plan. Securely
remove the private export when it is no longer needed. Both apps share the
target's free-tier quotas.

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

Row Level Security is enabled. The base schema grants authenticated Supabase
users read/write access to the shared transactions table; anonymous users have
no access. For the Meal Plan shared project, run `shared_project_access.sql`
before loading data to further restrict access to household members.

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

The base policies share the references and House installments with authenticated
Supabase users; `shared_project_access.sql` restricts them to Meal Plan household
members. Anonymous users cannot read them. Authorized users can
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

Run `portfolio.sql` in the Supabase SQL Editor after setting up Meal Plan
household membership. It creates shared
`portfolio_items` and `portfolio_transactions` tables. The migration adds
nullable saved market price, currency and quote-time columns to existing items;
previously fetched quotes must be refreshed once to populate them. Household members
can read both tables, create and update items, and are not isolated from each
other. Other users cannot access the portfolio. Run the updated `portfolio.sql` again when
upgrading an existing installation. The app adds, edits, duplicates and deletes
transactions through authenticated database functions; direct transaction
writes remain unavailable to authenticated users.
If a transaction action reports that a function is missing from the schema
cache, run the complete `portfolio.sql`, not just the column alterations, and
reload the portfolio. If the function still is not found after the script
finishes, request a schema cache reload with `NOTIFY pgrst, 'reload schema';`.

The function copies the selected item's ticker, platform, name and type into
each new transaction. An edit preserves these historical fields unless the
selected item changes. Transaction triggers clear saved values for affected
priced items when a buy or sell is added, edited or deleted, but leave manually
entered crowdlending values intact. Transaction revisions reject stale edits,
duplicates and deletes. Price refreshes use a valuation version to reject
stale values when transactions change during a refresh. Other clients that
write valuations must use the same version check to avoid overwriting an
invalidation.

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
initially open (`is_closed = false`). Closed or uncertain items are stored closed. Change
`is_closed` in `portfolio_items` to change whether an item is treated as open.
`is_in_scope` (editable in the item dialog, default true) decides whether an item counts
toward total P/L. If you have an older database, run the migration block in `portfolio.sql`:
it renames the old `is_in_scope` to `is_closed` (inverting it) and sets the new `is_in_scope`
to false for OPS Capital, KuCoin and Ethereum.
The Overview button can show or hide closed items. Yahoo Finance provides
prices, not owned quantities: the app computes quantities and cash flows from
transactions and stores the latest successfully calculated DKK value on the
item. The latest market price, currency and quote time are saved on the item and
restored on load. A trade invalidates the DKK value, not the price. Closed items are excluded from price refresh and portfolio
size, but their cash flows and fees contribute to total P/L with a current value
of zero, unless the item is not in scope. Ensure closed items are actually closed. Item edits increment the
valuation version; ticker changes and all type changes clear the saved quote,
and ticker changes for priced items and all type changes also clear the saved
value so stale price refreshes cannot overwrite it.

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

### Scheduled portfolio refresh

The `Refresh portfolio prices` GitHub Actions workflow runs at 00:00
Europe/Copenhagen on weekdays, including daylight-saving changes, and supports
manual runs. GitHub may delay scheduled runs, and the workflow must exist on
the default branch for the schedule to run. Use it only with the necessary
permission from Yahoo.

In **Settings → Secrets and variables → Actions**, configure the existing
`SUPABASE_URL` repository variable and add:

| Kind | Name | Value |
| --- | --- | --- |
| Variable | `SUPABASE_ANON_KEY` | Supabase project anon/publishable key |
| Secret | `SUPABASE_REFRESH_EMAIL` | Email for a dedicated Supabase Auth user |
| Secret | `SUPABASE_REFRESH_PASSWORD` | Password for that user |

The user must be able to sign in with email and password without interactive MFA
and must have the portfolio access required by the existing RLS policies and
the `market-data` Edge Function. Do not use a service-role key for this workflow
or commit the account password. Run the workflow manually after configuring it
and inspect the Actions log; a failed item makes the job fail.

If sign-in fails after moving projects, verify the refresh account's credentials
against the target project's Auth users. The same email in another project does
not imply the same password. Resetting that account's password also affects
anyone who uses it to sign in to Meal Plan.

The workflow requests only open, non-crowdlending quotes and any necessary
DKK exchange rates through the existing Edge Function. The function uses a
browser-like user agent, but requests originate from Supabase, not a browser.
The workflow spaces requests at least eight seconds apart and caches duplicate
quotes and currency rates within the run; concurrent browser refreshes are not
coordinated. The provider can still rate-limit requests. A rate-limit response
stops the run; other item failures are reported while remaining items continue.
Historical price changes are not persisted and are not requested by the workflow.
Optimistic valuation-version checks prevent stale quantity-based values from
overwriting changes made while it runs.

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
| `ENABLEBANKING_ANNA_APP_ID` | Optional second Enable Banking application ID; all fetched rows are assigned to Anna |

Add these repository secrets:

| Secret | Value |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service-role key; never use the browser anon key |
| `ENABLEBANKING_CERTIFICATE_PEM` | Full PEM certificate/private-key contents required by the Enable Banking SDK |
| `ENABLEBANKING_ACCOUNT_UIDS` | JSON array of authorized account UIDs, e.g. `["uid-1","uid-2"]` |
| `ENABLEBANKING_ANNA_CERTIFICATE_PEM` | Certificate/private-key contents for the optional Anna profile |
| `ENABLEBANKING_ANNA_ACCOUNT_UIDS` | JSON array of account UIDs for the optional Anna profile |

Enter the PEM contents directly as a GitHub secret; do not commit a PEM file or
put secret values in workflow YAML. Copy the account UIDs from an existing
authorized Enable Banking account configuration (for example, the `accounts`
array in the ignored local `api/session.json`) into the JSON-array secret. The
SDK uses the account UIDs for requests; the saved session ID is not required.
This importer does not perform interactive bank consent. If access is revoked,
complete the bank's authorization process separately and update the account
UID secret as needed.

The Anna profile is enabled only when at least one of its non-base-URL
credentials is present. If enabled, its app ID, certificate, and account UID
secret are all required. Its transactions use the primary categorization rules,
are assigned to account `anna`, and use category `👩 Anna` except for recognized
income, which retains `💰 Income`. Unmatched transactions use subcategory
`⚠️ Review`. This applies to newly imported transactions; previously imported
transactions are not recategorized.

Each workflow failure reports the profile and account index without exposing
account UIDs or API response bodies. An `HTTP 404` on a transaction fetch
normally means the configured account UID is stale or does not belong to that
Enable Banking application. Re-authorize that profile and replace its account
UID secret, then rerun the workflow. A successful profile is not committed when
another profile fails, so the next run refetches the same date range.

The `Import bank transactions` workflow runs Monday through Friday at 05:20 UTC
and is also available for manual runs from the Actions tab. It has read-only repository
permissions, serializes runs, and exposes credentials only to the import step.
The static Pages workflow uploads only `docs/`, not the rest of the repository.

### Authorize the Anna profile from the CLI

Use the local helper to connect Anna's bank. The redirect URL must already be
registered for the Anna Enable Banking application. Pass credentials through
environment variables and keep the PEM in an ignored local file:

```powershell
$env:ENABLEBANKING_ANNA_APP_ID = "<Anna application ID>"
$env:ENABLEBANKING_ANNA_REDIRECT_URL = "<registered redirect URL>"
python api\authorize_anna.py --certificate-file "C:\private\anna.pem"
```

The helper opens the bank authorization page, lets you select a Danish bank,
and asks for the final redirected URL or its `code` parameter. It writes
`api\anna-session.json`, which is ignored by Git. Copy the JSON `accounts` array
to the `ENABLEBANKING_ANNA_ACCOUNT_UIDS` GitHub secret; do not commit it.

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
