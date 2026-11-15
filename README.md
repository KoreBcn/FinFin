
## Bank transaction import

The GitHub Actions workflow imports transactions on weekdays and can also be
started manually from the Actions tab. It fetches from the Supabase watermark
with a seven-day overlap, categorizes transactions in memory, and sends them
directly to Supabase without creating local transaction or session files. Configure its
GitHub variables and secrets as described in
[db/supabase/README.md](db/supabase/README.md).

The footer shows the latest `inserted_at` in the transactions table, in the
browser's local time. It includes manual entries and is not the time of the
last Enable Banking run; a run that adds no transactions does not change it.
The value is read on sign-in and after transaction changes.

## Investments

Sign in and open **Investments** to load portfolio items and transactions from
Supabase. See [db/supabase/README.md](db/supabase/README.md) for the schema and
one-off CSV migration. Items are identified by ticker and platform. Only items
marked in scope are displayed and refreshed. Use **+** to create an item or
the row's edit button to change its ticker, name, type or platform. Its quantity
is unknown until it has transactions. Changing a priced item's ticker or
changing its type clears its saved value and quote; refresh a priced item afterwards.
For price refreshes, the ticker must be its exact Yahoo Finance ticker, such as
`NOVO-B.CO` or `IEMM.AS`.
Crowdlending values can be entered manually and are saved in Supabase.
Previously saved browser-only crowdlending values remain a local fallback until
the value is saved again.

Within Portfolio, choose **Transactions** to search transactions by ticker,
browse pages, and add, edit, duplicate or delete transactions for existing
items (including out-of-scope items). Select the information button next to
the ticker to see the name, platform, type and currencies. Enter fees and dividend cash flows with
their signs and total cost in DKK. Adding, editing, duplicating or deleting a
buy or sell clears affected priced items' saved values until their next price
refresh; manually entered crowdlending values are retained. Run the updated
portfolio SQL before using this feature.

Deploy the `market-data` Supabase Edge Function as described in
[db/supabase/README.md](db/supabase/README.md). When you select the refresh
icon to the right of an item's return, the signed-in app calls the function for
that item. It retrieves Yahoo Finance chart data without a Twelve Data key.
This works from GitHub Pages as well as the local app. Yahoo receives requested
symbols, but not the CSV, quantities, or balances. Requests are paced across
item refreshes to about eight per minute. This chart endpoint is not a guaranteed
public API and may be delayed, rate-limited, or change without notice. Yahoo's
[terms](https://legal.yahoo.com/us/en/yahoo/terms/otos/index.html) prohibit
automated data collection without express prior permission; verify you have the
necessary permission before deploying or using it. The ticker is sent as stored,
with no instrument mappings or separate market symbol override. A
successful quote saves the price, currency and available quote time for display
on future loads. A successful currency conversion also updates the saved DKK
value, using the quantity calculated from transactions. If conversion fails,
the new price is saved but the previous DKK value remains and may be stale.
Other refresh failures retain the previous saved quote and value. Price history
and percentage changes are not persisted. Only crowdlending current values can be
entered manually.

Select a portfolio column heading to sort ascending or descending; on small
screens, use the sort controls above the portfolio. Unavailable values stay
last. Price sorting compares the displayed numeric prices without converting
currencies.

The CSV's `Total Cost`, `Fees`, and dividends are treated as DKK. Buy and sell
quantities are netted; missing or invalid quantities are shown as unknown.
Crowdlending quantities are not meaningful, so their values must be entered
manually. Actions other than Buy, Sell, Dividend and Dividend Tax do not change
quantities or cash flows, though their fees are included. Verify these positions
before relying on totals. Existing tickers
such as `MELI|XNGS` must be changed to the intended Yahoo listing
(for example `MELI`) before they can be priced. Check the listing and currency
before updating. See the portfolio instructions in
[db/supabase/README.md](db/supabase/README.md) for migration cautions.
Net P/L is the current value plus buy and sell cash flows, fees, and dividends;
it is not realized/unrealized tax-lot accounting. The portfolio size sums valued
in-scope positions. Use **Show closed positions** in Overview to display
out-of-scope items. Total P/L excludes positions on the OPS Capital and KuCoin platforms.
It includes other out-of-scope positions, treating their current value as zero,
regardless of stored value or calculated quantity.
Unvalued in-scope positions are excluded and reported.
Percent changes compare the
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
contributing entries; use **Installments** to view the table and **Graph** to return to the chart.

## 3. Run server 

cd C:\Users\CMIQ\repositories\home_fin\;
python C:\Users\CMIQ\repositories\home_fin\server.py

## 4. Categorize any uncategorized transactions from the app
## 5. Add missing transactions from different accounts not coming from Danske bank (i.e Revolut / Gross salary transactions)

f0b43aab-606b-498b-a536-b493ab9fc94d,Rejsekort,REA,👨 Carlos,23/04/26,April,2026,-677,,Carlos,false
6c91eed2-808f-4fd0-955e-cd74c842cec1,Psicologist,REA,👨 Carlos,30/04/26,April,2026,-372,,Carlos,false
4af0ebc4-87a5-44cd-a71e-21014ec2a1da,Health,REA,👨 Carlos,23/04/26,April,2026,-183,Massage from gross,Carlos,false
d5ed6cdc-353a-428a-894e-4005a7c6d6da,Phone,REA,👨 Carlos,23/04/26,April,2026,-175,Phone from gross,Carlos,false