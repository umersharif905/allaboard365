# Troubleshooting Microsoft / Work Accounts on Windows

When users see **"Your organization has deleted this device"** (error 700003) or **"Device authentication failed"** (50155) when signing in to Teams, Outlook, or Windows, the device still has a cached token for an old or removed device registration. Fixing it requires disconnecting the work account from Windows and re-adding it, and sometimes forcing the device to leave the organization. Creating a **local administrator account** and running **`dsregcmd /leave`** are often the key steps.

---

## 1. Quick workaround: use another device

- **Phone:** Install Outlook and Teams, sign in with the user’s work email + password + MFA. No device token issue on the phone.
- **Browser on any PC:** Go to [outlook.office.com](https://outlook.office.com) and [teams.microsoft.com](https://teams.microsoft.com), sign in with the work account.

---

## 2. Fix the PC so work account works again

### 2.1 Create a local administrator account (required)

The user must have another account that can sign in to the PC **before** disconnecting the work account, or Windows may block the action or ask for “alternate account info.”

1. **While signed in as the work account**, open **Settings** → **Accounts** → **Other users**.
2. **Add someone else** → **I don't have this person's sign-in information** → **Add a user without a Microsoft account**.
3. Enter a **username** (e.g. `username_local`) and **password**. Record them.
4. Under **Other users**, click the new account → **Change account type** → **Administrator** → **OK**.

**If the user forgets the local account password**, reset it:

- **Option A:** **Command Prompt (Run as administrator):**
  ```text
  net user username_local NewPassword
  ```
  Use the exact username shown under Other users (e.g. `mlilley_local` or `Mlilley_local2`).

- **Option B:** **Control Panel** → **User Accounts** → **Manage another account** → select the local account → **Change the password**.

---

### 2.2 Disconnect is grayed out

**Disconnect** is only available when the user is **not** signed in with that work account.

1. **Sign out** of the work account (Start → user icon → Sign out, or **Windows + L** to lock).
2. On the sign-in screen, choose **Other user**.
3. In the **Email** field, enter **`.\username_local`** (e.g. `.\mlilley_local`). The **`.\`** tells Windows it’s a local account.
4. Enter the **password** for that local account and sign in.
5. **Settings** → **Accounts** → **Access work or school** → click the work account → **Disconnect** should now be available. Use it (and enter the local account if Windows asks for alternate account info).

---

### 2.3 “Your device is already connected to your organization”

After disconnecting, adding the work account again can fail with “something went wrong – your device is already connected to your organization.” The device must **leave** the organization first.

**On the PC (signed in as the local admin account):**

1. Open **Command Prompt** as administrator (Search → **cmd** → right‑click → **Run as administrator**).
2. Run:
   ```text
   dsregcmd /leave
   ```
3. **Restart** the PC.
4. Sign in again with the **local account**.
5. **Settings** → **Accounts** → **Access work or school** → **Add account** → sign in with the work email + password + MFA.

**Admin (optional):** In **Microsoft Entra ID** → **Devices**, delete the user’s device if it still appears, so the tenant doesn’t treat it as already registered.

---

## 3. Summary: order of operations

| Step | Action |
|------|--------|
| 1 | Create a local administrator account (Settings → Accounts → Other users). |
| 2 | (If needed) Reset local account password: `net user username_local NewPassword` in elevated Command Prompt. |
| 3 | Sign out of the work account; sign in as the local account (use **`.\username_local`** in the Email field). |
| 4 | Disconnect the work account (Access work or school → work account → Disconnect). |
| 5 | Run **`dsregcmd /leave`** in elevated Command Prompt; restart. |
| 6 | Sign in as the local account again → Access work or school → **Add account** → work email + MFA. |
| 7 | Open Teams/Outlook and sign in with the work account if prompted. |

The combination of **having a local admin account** and running **`dsregcmd /leave`** before re-adding the work account is what resolves the “deleted device” / “already connected” issues in most cases.

---

## 4. Admin-side actions (optional)

- **Revoke sign-in sessions:** Entra ID → Users → user → Sign-in sessions → Revoke.
- **Remove devices:** Entra ID → Devices → delete the user’s device(s) if re-registration is needed.
- **Billing / permission issues** are separate (see other docs); this guide is for device/account sign-in only.
