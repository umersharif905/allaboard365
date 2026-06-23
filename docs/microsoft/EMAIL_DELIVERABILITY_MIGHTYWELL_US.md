# Email deliverability for jeremy@mightywell.us (avoiding junk)

Emails going to junk are usually fixed by **sender authentication** (SPF, DKIM, DMARC) for the domain **mightywell.us**. This is done in **DNS** and in **Microsoft 365** (or your mail provider), not by a single Azure CLI command.

**Azure CLI cannot directly “fix” junk.** It can help you **inspect** what your tenant expects for the domain (see below).

---

## 1. What actually fixes deliverability

| What | Where | Purpose |
|------|--------|--------|
| **SPF** | DNS TXT record for mightywell.us | Tells receiving servers which mail servers are allowed to send for @mightywell.us. |
| **DKIM** | DNS CNAME records + M365/Exchange | Signs outgoing mail so receivers can verify it’s really from you. |
| **DMARC** | DNS TXT record | Tells receivers what to do with mail that fails SPF/DKIM (and gives you reports). |

Until these are correct, many receivers will keep putting mail in junk.

---

## 2. See what Microsoft 365 expects (Azure CLI)

If **mightywell.us** is a custom domain in your **Microsoft 365 / Entra** tenant, you can list the DNS records Microsoft expects for **domain verification** and **email** using Graph via `az rest`:

```bash
# Sign in (if not already)
az login

# List verification DNS records for mightywell.us (replace with your domain)
az rest --method GET \
  --url "https://graph.microsoft.com/v1.0/domains/mightywell.us/verificationDnsRecords" \
  --resource "https://graph.microsoft.com"
```

That returns the records you need to add in your DNS host (e.g. GoDaddy, Cloudflare, Azure DNS) so the domain is verified. It does **not** by itself configure SPF/DKIM for email; it’s the first step so you can use the domain.

For **SPF/DKIM/DMARC** you still need to:

- Add the **SPF** TXT record Microsoft recommends (e.g. `v=spf1 include:spf.protection.outlook.com ~all` if you only send via M365).
- In **Microsoft 365 Admin** → **Settings** → **Domains** → **mightywell.us** → **DNS records** (or **Manage DNS**), follow the prompts to add the records they show, including any for **DKIM**.
- Optionally add a **DMARC** TXT record at `_dmarc.mightywell.us` (e.g. `v=DMARC1; p=none; rua=mailto:jeremy@mightywell.us` for reporting only).

---

## 3. Where to configure (no Azure CLI)

- **DNS** (where mightywell.us is hosted): Add the TXT/CNAME records that M365 (or SendGrid, if you send through that) shows for SPF and DKIM.
- **Microsoft 365 Admin Center**: https://admin.microsoft.com → **Settings** → **Domains** → select **mightywell.us** → use “Manage DNS” or “Add record” to see the exact SPF/DKIM records and add them at your DNS host.
- **Exchange / Defender for Office 365**: DKIM for custom domains is enabled in the **Microsoft 365 Defender portal** or **Exchange admin** (email authentication / DKIM), then you add the CNAMEs they give you in DNS.

---

## 4. Quick checklist for jeremy@mightywell.us

1. Confirm **mightywell.us** is added and **verified** in M365 (Domains).
2. Add **SPF** TXT for mightywell.us (include all services that send mail for that domain, e.g. `spf.protection.outlook.com` for M365).
3. **Enable DKIM** for mightywell.us in M365 and add the CNAME records they provide in DNS.
4. (Recommended) Add **DMARC** TXT at `_dmarc.mightywell.us` (start with `p=none` and a `rua` address).
5. Wait 24–48 hours for DNS to propagate; then test by sending to Gmail/Outlook and checking headers (SPF/DKIM should pass).

There is no Azure CLI command that “turns off junk” for your address; fixing SPF/DKIM (and optionally DMARC) is what improves deliverability.
