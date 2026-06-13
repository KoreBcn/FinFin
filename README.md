
## To Do Every month

## 1. Ask Anna's extract

python api_call.py — full flow: fetch from bank → save raw → categorize all raw
python api_call.py categorize — categorize only (for when you've manually dropped a raw file and want to re-run without hitting the bank API)

## 2. Pull transactions via API:
cd api
python .\api_call.py
python api/api_call.py categorize
python api/api_call.py categorize --all (not applying last 3 monhts filter)
python api_call.py categorize --file 20260601_anna_raw.csv

## 3. Run server 

cd C:\Users\CMIQ\repositories\home_fin\;
python C:\Users\CMIQ\repositories\home_fin\server.py

## 4. Categorize any uncategorized transactions from the app
## 5. Add missing transactions from different accounts not coming from Danske bank (i.e Revolut / Gross salary transactions)

f0b43aab-606b-498b-a536-b493ab9fc94d,Rejsekort,REA,👨 Carlos,23/04/26,April,2026,-677,,Carlos,false
6c91eed2-808f-4fd0-955e-cd74c842cec1,Psicologist,REA,👨 Carlos,30/04/26,April,2026,-372,,Carlos,false
4af0ebc4-87a5-44cd-a71e-21014ec2a1da,Misc,REA,👨 Carlos,23/04/26,April,2026,-183,Massage from gross,Carlos,false
d5ed6cdc-353a-428a-894e-4005a7c6d6da,Phone,REA,👨 Carlos,23/04/26,April,2026,-175,Phone from gross,Carlos,false