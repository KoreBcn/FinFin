
## Bank transaction import

The GitHub Actions workflow imports transactions on weekdays and can also be
started manually from the Actions tab. It fetches from the Supabase watermark
with a seven-day overlap, categorizes transactions in memory, and sends them
directly to Supabase without creating local transaction or session files. Configure its
GitHub variables and secrets as described in
[db/supabase/README.md](db/supabase/README.md).

## Investments

Sign in and open **Investments** to load portfolio items and transactions from
Supabase. See [db/supabase/README.md](db/supabase/README.md) for the schema and
one-off CSV migration. Items are identified by ticker and platform. Only items
marked in scope are displayed and included in totals and price refreshes.
Use the **+** button to create an item; its quantity is unknown until it has
transactions. The optional market symbol uses `SYMBOL` or `SYMBOL|MIC`.
Crowdlending values can be entered manually and are saved in Supabase.
Previously saved browser-only crowdlending values remain a local fallback until
the value is saved again.

Set the [Twelve Data](https://twelvedata.com/) key as the Supabase Edge Function
secret `TWELVE_DATA_API_KEY` and deploy the `market-data` function as described
in [db/supabase/README.md](db/supabase/README.md). When you select the refresh
icon next to an item, the signed-in app calls the function for that item; the
key never reaches the browser. This works from GitHub Pages as well as the
local app. Twelve Data receives requested symbols and the key, but not the
CSV, quantities, or balances. Requests are paced across item refreshes to
about eight per minute; each quote, exchange rate, and price history consumes
API credits. Availability, delay, and exchange access
depend on the provider and your plan. Verified mappings are built in; items
without a verified or manually specified market symbol remain unpriced. A
successful quote and currency conversion updates the saved DKK value, using
the quantity calculated from transactions. Failed refreshes leave the last
saved value intact; it may be stale. Only crowdlending current values can be
entered manually.

The CSV's `Total Cost`, `Fees`, and dividends are treated as DKK. Buy and sell
quantities are netted; missing or invalid quantities are shown as unknown.
Crowdlending quantities are not meaningful, so their values must be entered
manually. Non-trade actions are flagged, not
interpreted. Verify these positions before relying on totals. Novo is displayed
as `NOVO-B:XCSE` but quoted as Twelve Data's `NOVO.B` on `XCSE`. The iShares
UCITS ETF uses its `IEMM` listing rather than the different US-listed `EEM` ETF.
Net P/L is the current value plus buy and sell cash flows, fees, and dividends;
it is not realized/unrealized tax-lot accounting. Percent changes compare the
latest quote with the last daily close at least 7, 30, or 90 calendar days ago.
Hover or focus the Today percentage to see those changes; select the information
icon beside a position for its platform and cash flows. Portfolio percentages
use only positions with known DKK values.

### House

The House subtab uses the already-loaded Supabase transactions and reads its
transaction references from Supabase after sign-in. Configure them as described
in [db/supabase/README.md](db/supabase/README.md); do not publish account
identifiers in the static site. Payment descriptions are matched exactly, while
interest descriptions can contain the configured text; matching ignores case
and surrounding whitespace. Actual matching bank outflows count as payments,
with inflows as refunds. Interest transactions retain their signed amounts as
adjustments. Planned transactions are excluded, regardless of the dashboard
filters. The House view works on GitHub Pages and the local app.

The house value starts at 6,100,000 DKK and can be changed in whole kroner. Run
`db\supabase\house_installments.sql` in the Supabase SQL Editor before using
this view, including when upgrading an existing installments table. Use the +
button to add entries: positive amounts are labeled `Bank installment` and
negative amounts `Interest / Adjustment`. Custom concepts, including an initial
payment, can be inserted directly in Supabase as described in
[db/supabase/README.md](db/supabase/README.md). Entries include an insertion
timestamp. Avoid manually entering a payment already included from bank
transactions, as both entries would be counted. Only the house value is
temporary and cleared on sign-out or reload. Mortgage value is the sum of the
absolute amounts of entries marked as initial payment or mortgage components.
Mortgage components are excluded from direct equity payments and total interest;
the initial payment still counts toward equity. Total interest is the signed sum
of matching bank interest (including refunds) and negative regular saved entries,
even if a saved adjustment is not actually interest. Equity includes bank
principal installments and refunds, and regular saved entries and initial payments
across every page, plus the change in house value from the mortgage value.
Changing mortgage components therefore changes the equity baseline. Negative
manual adjustments reduce equity; bank interest transactions do not affect equity or debt.
Debt is the house value minus equity; this is an estimate, not the
actual mortgage balance. Hover or focus the house to see the amounts. When
equity is outside the house value, the diagram is capped and a warning appears
while the calculated amounts and percentages remain unchanged. The default history
chart groups all equity-affecting entries by month, carrying balances through
months without payments. It uses today's house and mortgage values throughout,
not historical valuations. The cumulative interest line is hidden by default;
select **Interest** in the chart legend to show positive interest costs on the
same scale. Refunds reduce that total. Hover over a month to see its
contributing entries; use **Show installments** to view the table.

## 3. Run server 

cd C:\Users\CMIQ\repositories\home_fin\;
python C:\Users\CMIQ\repositories\home_fin\server.py

## 4. Categorize any uncategorized transactions from the app
## 5. Add missing transactions from different accounts not coming from Danske bank (i.e Revolut / Gross salary transactions)

f0b43aab-606b-498b-a536-b493ab9fc94d,Rejsekort,REA,👨 Carlos,23/04/26,April,2026,-677,,Carlos,false
6c91eed2-808f-4fd0-955e-cd74c842cec1,Psicologist,REA,👨 Carlos,30/04/26,April,2026,-372,,Carlos,false
4af0ebc4-87a5-44cd-a71e-21014ec2a1da,Health,REA,👨 Carlos,23/04/26,April,2026,-183,Massage from gross,Carlos,false
d5ed6cdc-353a-428a-894e-4005a7c6d6da,Phone,REA,👨 Carlos,23/04/26,April,2026,-175,Phone from gross,Carlos,false