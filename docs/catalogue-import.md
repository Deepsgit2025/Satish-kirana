# Catalogue import

How to prepare the product spreadsheet, and what the importer will and will not accept.

Start from **`catalogue-template.csv`** in this folder. It has the heading row and six example rows covering the cases people get wrong. Delete the examples, keep the heading, add your products.

```bash
npm run catalogue:import -- products.csv --dry-run   # check it, change nothing
npm run catalogue:import -- products.csv             # load the good rows
```

**Run the dry form as often as you like.** It reads the file, checks every row and prints what is wrong, and writes nothing at all — it is safe against the live shop database. Run it while you are still typing rather than at the end: an HSN code that is four digits long is a ten-second fix on the day you enter it and a long afternoon six weeks later.

---

## Columns

Headings must be spelled exactly as below, in any order. The four optional ones may be left out of the file entirely.

| Column | Required | Notes |
|---|---|---|
| `barcode` | yes | The code on the packet. Must not repeat in the file, and must not already be on a product in the system. |
| `name` | yes | Full name, for office screens and reports. |
| `name_hi` | no | Hindi name. Leave blank where you have not got one — it falls back to `name`. |
| `short_name` | yes | **Prints on the receipt.** 30 characters maximum. Write it yourself; it is not shortened automatically. |
| `hsn_code` | yes | Exactly 6 digits. |
| `tax_rate` | yes | Total GST as a percentage: `0`, `5`, `18`, `40`. Not the half. |
| `mrp` | yes | Printed maximum retail price. Greater than zero, at most 2 decimal places. |
| `sale_price` | yes | What you actually charge, **including GST**. May equal MRP but never exceed it. |
| `purchase_price` | no | Supplier cost **excluding GST**. Blank is treated as 0. |
| `unit` | yes | Must match the units master — `Kg`, `Pcs`, `Ltr`, `Gm`, `Ml`, `Box`, `Bag`, `Packet`, `Dozen`, `Bundle`, `Carton`, `Quintal`. Full names work too, and case does not matter. |
| `category` | no | Free text. A category that does not exist yet **is created**, not rejected. |
| `reorder_level` | no | Minimum stock to maintain. Blank is treated as 0. |

There is no column for the internal item code. The system assigns one (`SKU-000001`).

### Two price rules worth reading twice

**`sale_price` is GST-inclusive and `purchase_price` is GST-exclusive.** That is how the two are normally quoted, and it is why they are separate settings rather than one. Enter the retail price as it is on the shelf, and the supplier cost as it is on the invoice before tax.

**`sale_price` may not exceed `mrp`.** Selling above the printed maximum retail price is an offence under the Legal Metrology rules, so a row that does it is rejected rather than imported.

---

## What happens to a bad row

**The file is never abandoned over one row.** A 2,000-row file with 30 problems imports the other 1,970 and prints the 30, each with the line number you see in the spreadsheet's row gutter, the value it objected to, and why:

```
[catalogue] products.csv: 2000 data rows
[catalogue] 1970 imported, 30 rejected

[catalogue] rejected rows — line numbers match the spreadsheet:
[catalogue]   line  column     value          reason
[catalogue]   14    barcode    8901234567890  already used on line 9 of this file
[catalogue]   27    hsn_code   1006           must be exactly 6 digits
[catalogue]   31    unit       Bori           not a unit in the units master
[catalogue]   88    tax_rate   12             no GST slab in force at this rate
```

Every problem in a row is listed, not just the first, so one pass through the spreadsheet fixes the lot. Fix those rows, and re-run the file — the rows that already imported will be rejected the second time as duplicate barcodes, which is the intended behaviour and not an error to worry about. It is usually easier to keep a separate file of just the corrected rows.

## In Hindi

Everything above prints in Hindi too, and the report reads exactly the same way:

```
npm run catalogue:import -- products.csv --dry-run --lang=hi
```

```
[catalogue] products.csv: 2000 पंक्तियाँ
[catalogue] 1970 आयात हुईं, 30 अस्वीकृत

[catalogue] अस्वीकृत पंक्तियाँ — पंक्ति संख्याएँ स्प्रेडशीट से मेल खाती हैं:
[catalogue]   पंक्ति  कॉलम       मान            कारण
[catalogue]   27      hsn_code   1006           ठीक 6 अंकों का होना चाहिए
[catalogue]   31      unit       Bori           इकाई मास्टर में यह इकाई नहीं है
```

Without `--lang` it uses the store's own setting (`app_settings.default_language`), so once that is set to Hindi the plain command prints Hindi.

**Two things stay in English on purpose.** The **column names** are the headings in your own spreadsheet — `hsn_code` has to match what is in the file, so translating it would be pointing at a column that does not exist. And the **values** are whatever you typed. Only the reasons are translated.

---

### Two things that stop the whole file

Both are properties of the file rather than of a row, so there is nothing to report row by row:

- **A missing required heading.** Every row would say the same thing.
- **An unclosed quotation mark.** Everything after it is one enormous field, so nothing can be read truthfully.

---

## Things that trip people up

**A comma inside a name.** `Sunflower Oil, Refined 1 L` splits into two values and the row is rejected for having too many. Wrap the whole value in double quotes: `"Sunflower Oil, Refined 1 L"`. Excel does this for you when you save as CSV.

**12% and 28%.** Both were abolished in the GST 2.0 rationalisation of 22 September 2025. Rows carrying them are rejected on purpose: those goods moved to 5% or 18% depending on what they are, and it is not something the importer can guess. An older spreadsheet will be full of these.

**Four-digit HSN codes.** Common on older supplier invoices. Six digits are required — above ₹5 crore turnover the GST return needs them, and lengthening thousands of codes afterwards is miserable work.

**Trailing blank rows.** Harmless; they are ignored.

**A file saved from Excel on Windows.** Fine as it is — the byte order mark and CRLF line endings are both handled.

---

> The rates and HSN codes in the example rows illustrate the **format**. They are not tax advice, and every code and rate in a real file should be confirmed against your own supplier invoices and your CA before it is loaded.
