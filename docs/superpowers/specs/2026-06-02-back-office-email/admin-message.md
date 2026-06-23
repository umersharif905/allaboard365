# Message to send to the M365 / Exchange admin

> Copy everything below this line.

---

Hi — I set up an app registration so our Back Office can read and send from the shared mailbox **membersuccess@sharewellpartners.com**. I need an admin to do two quick things (~5 min total).

**App details**
- App (client) ID: `67d927e8-a1c7-49ae-95f0-452e0b66a992`
- Tenant (directory) ID: `dab84bb8-e15a-46f8-a85a-e5f1a95d0200`
- Mailbox: `membersuccess@sharewellpartners.com`

**1) Grant admin consent**
Microsoft Entra admin center → **App registrations** → the app above → **API permissions** →
click **"Grant admin consent for <Org>"** → **Yes**.
The three Microsoft Graph **Application** permissions (`Mail.Read`, `Mail.ReadWrite`, `Mail.Send`)
should turn green ("Granted").

**2) Restrict the app to ONLY that mailbox** (so it can't access any other mailbox)
In Exchange Online PowerShell:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser   # if not already installed
Connect-ExchangeOnline

New-DistributionGroup -Name "BackOfficeMailScope" -Type Security `
  -Members membersuccess@sharewellpartners.com

New-ApplicationAccessPolicy `
  -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992 `
  -PolicyScopeGroupId BackOfficeMailScope `
  -AccessRight RestrictAccess `
  -Description "Restrict Back Office email app to the shared mailbox"

Test-ApplicationAccessPolicy -Identity membersuccess@sharewellpartners.com `
  -AppId 67d927e8-a1c7-49ae-95f0-452e0b66a992
```

The last command should print `AccessCheckResult : Granted`. (The policy can take up to ~1–2 hours
to fully propagate, but that test command checks live.)

That's everything — thanks! Let me know once both are done and I'll take it from there.
