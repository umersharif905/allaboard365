# NACHA File Format Summary

A NACHA file is a structured ASCII text file used to transmit ACH (Automated Clearing House) transactions. Each line (record) is **94 characters long** and follows a strict structure.

---

## File Structure Overview

| Record | Type | Purpose | Example Count |
|---------|-------|----------|----------------|
| 1 | File Header | Identifies destination, origin, and creation info | 1 per file |
| 5 | Batch Header | Identifies batch and company info | 1+ |
| 6 | Entry Detail | Represents each transaction (credit/debit) | Many |
| 7 | Addenda | Optional additional transaction info | Optional |
| 8 | Batch Control | Totals for a batch | 1 per batch |
| 9 | File Control | Totals for the entire file | 1 per file |

---

## 1 Record — File Header

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'1'` |
| 2–3 | 2 | Priority Code = `'01'` |
| 5–13 | 9 | Immediate Destination (Routing Number) |
| 14–23 | 10 | Immediate Origin (Company ID or Routing) |
| 24–29 | 6 | File Creation Date (YYMMDD) |
| 30–33 | 4 | File Creation Time (HHMM) |
| 34 | 1 | File ID Modifier (A–Z) |
| 35–37 | 3 | Record Size = `'094'` |
| 38–39 | 2 | Blocking Factor = `'10'` |
| 40 | 1 | Format Code = `'1'` |
| 41–63 | 23 | Immediate Destination Name |
| 64–86 | 23 | Immediate Origin Name |
| 87–94 | 8 | Reference Code (optional) |

---

## 5 Record — Batch Header

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'5'` |
| 2–4 | 3 | Service Class Code |
| 5–20 | 16 | Company Name |
| 21–40 | 20 | Company Discretionary Data |
| 41–50 | 10 | Company Identification |
| 51–53 | 3 | Standard Entry Class (SEC) Code |
| 54–63 | 10 | Company Entry Description |
| 64–69 | 6 | Descriptive Date |
| 70–75 | 6 | Effective Entry Date (YYMMDD) |
| 79 | 1 | Originator Status Code = `'1'` |
| 80–87 | 8 | Originating DFI ID |
| 88–94 | 7 | Batch Number |

---

## 6 Record — Entry Detail

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'6'` |
| 2–3 | 2 | Transaction Code |
| 4–11 | 8 | Receiving DFI (Routing Number) |
| 12 | 1 | Check Digit |
| 13–29 | 17 | DFI Account Number |
| 30–39 | 10 | Amount (in cents, zero-filled) |
| 40–54 | 15 | Individual ID Number |
| 55–76 | 22 | Individual Name |
| 79 | 1 | Addenda Indicator (0 = none, 1 = addenda follows) |
| 80–94 | 15 | Trace Number |

---

## 7 Record — Addenda (Optional)

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'7'` |
| 2–3 | 2 | Addenda Type Code = `'05'` |
| 4–83 | 80 | Payment details (ANSI X12, TXP, etc.) |
| 84–87 | 4 | Addenda Sequence Number |
| 88–94 | 7 | Entry Detail Sequence Number |

---

## 8 Record — Batch Control

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'8'` |
| 2–4 | 3 | Service Class Code |
| 5–10 | 6 | Entry/Addenda Count |
| 11–20 | 10 | Entry Hash |
| 21–32 | 12 | Total Debit Amount |
| 33–44 | 12 | Total Credit Amount |
| 45–54 | 10 | Company Identification |
| 80–87 | 8 | Originating DFI ID |
| 88–94 | 7 | Batch Number |

---

## 9 Record — File Control

| Position | Length | Description |
|-----------|---------|-------------|
| 1 | 1 | Record Type Code = `'9'` |
| 2–7 | 6 | Batch Count |
| 8–13 | 6 | Block Count |
| 14–21 | 8 | Entry/Addenda Count |
| 22–31 | 10 | Entry Hash |
| 32–43 | 12 | Total Debit Amount |
| 44–55 | 12 | Total Credit Amount |
| 56–94 | 39 | Reserved (blanks) |

---

## Common Transaction Codes

| Code | Meaning |
|------|----------|
| 22 | Checking (DDA) Credit |
| 23 | Checking Credit Prenote |
| 27 | Checking Debit |
| 28 | Checking Debit Prenote |
| 32 | Savings Credit |
| 37 | Savings Debit |
| 42 | General Ledger Credit |

---

## Standard Entry Class (SEC) Codes

| Authorization Method | SEC Code | Description |
|------------------------|-----------|-------------|
| Signed by individual | PPD | Personal pre-authorized debit/credit |
| Signed by company | CCD | Corporate credit/debit |
| Internet | WEB | Internet authorization (consumer debit only) |
| Recorded phone call | TEL | Telephone authorization |
| Check at POS | POP | Point-of-Purchase check conversion |
| Check by mail | ARC | Accounts Receivable check conversion |

---

## Important Rules

- Each record must be **exactly 94 characters long**.
- Monetary fields are **zero-filled**, right-justified, no decimal point.
- Text fields are **left-justified**, space-filled.
- SEC Code must match authorization method.
- Each batch starts with a `5` record and ends with an `8` record.
- File begins with a `1` and ends with a `9` record.
- Non-compliance can result in **fines up to $10,000 per transaction**.

---

## Implementation Notes for OpenEnroll

### Configuration Needed
- **Immediate Destination**: Bank routing number (from environment variable)
- **Immediate Origin**: Company ID (from environment variable)
- **Originating DFI ID**: Bank routing number (from environment variable)
- **Company Identification**: EIN/TIN (from environment variable or tenant settings)

### File Generation
- Use PPD (Prearranged Payment and Deposit) SEC code for commission payouts
- Transaction codes: 22 (Checking Credit) or 32 (Savings Credit)
- Trace number format: OriginatingDFI + Sequence (15 digits total)
- Entry hash: Sum of first 8 digits of all receiving DFI routing numbers

### Validation
- Ensure each record is exactly 94 characters
- Validate routing numbers are 9 digits
- Validate amounts are positive integers (cents)
- Validate dates are in YYMMDD format
- Validate account numbers don't exceed 17 characters


