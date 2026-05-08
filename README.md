
## To Do Every month

## 1. Ask Anna's extract

python api_call.py — full flow: fetch from bank → save raw → categorize all raw
python api_call.py categorize — categorize only (for when you've manually dropped a raw file and want to re-run without hitting the bank API)

## 2. Pull transactions via API:
cd api
python .\api_call.py
python api/api_call.py categorize
python api/api_call.py categorize --all (not applying last 3 monhts filter)

## 3. Run server 

cd C:\Users\CMIQ\repositories\home_fin\; 
python C:\Users\CMIQ\repositories\home_fin\server.py

## 4. Categorize any uncategorized transactions from the app
## 5. Add missing transactions from different accounts not coming from Danske bank (i.e Revolut / Gross salary transactions)