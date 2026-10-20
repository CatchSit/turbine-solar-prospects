# Microsoft 365 setup: let the Turbine CRM read sales mailboxes

**For:** Turbine Energy's IT / Microsoft 365 administrator
**Time needed:** about 20 minutes, plus up to 2 hours for Exchange to apply the changes
**Requested by:** Greg

## What this is for

The Turbine CRM needs to see emails between our sales team and customers, so each customer's emails appear on their CRM record. It needs **read-only** access to these six mailboxes and nothing else:

- info@turbineenergyuk.co.uk
- greg@turbineenergyuk.co.uk
- matty@turbineenergyuk.co.uk
- tim@turbineenergyuk.co.uk
- chris@turbineenergyuk.co.uk
- jackie@turbineenergyuk.co.uk

The CRM never sends, deletes, moves or flags mail. It only reads messages to or from a customer's email address, and it doesn't store the message text.

The method below (Exchange "RBAC for Applications") limits the app to exactly these mailboxes. **Please don't grant tenant-wide Mail.Read in Entra.** That would let the app read every mailbox in the company.

## Step 1: Register the app (Entra admin centre)

1. Go to **entra.microsoft.com → Identity → Applications → App registrations → New registration**.
2. **Name:** `Turbine CRM mail sync`. **Supported account types:** "Accounts in this organizational directory only". Leave **Redirect URI** empty. Click **Register**.
3. On the app's **Overview** page, copy:
   - **Application (client) ID**
   - **Directory (tenant) ID**
4. Go to **Certificates & secrets → Client secrets → New client secret**. Description `CRM mail sync`, expiry **24 months**. Copy the secret's **Value** now (it's only shown once).
5. **API permissions:** leave this alone. Don't add Mail.Read here. Step 3 grants the access instead, limited to the six mailboxes.
6. Go to **Identity → Applications → Enterprise applications**, open **Turbine CRM mail sync**, and copy its **Object ID**. This is a different ID from the ones in step 3. It's the Enterprise application's own Object ID.

## Step 2: Make a group of the six mailboxes (Exchange Online PowerShell)

```powershell
Connect-ExchangeOnline

New-DistributionGroup -Name "CRM Mail Sync" -Type Security `
  -Members info@turbineenergyuk.co.uk, greg@turbineenergyuk.co.uk, matty@turbineenergyuk.co.uk, `
           tim@turbineenergyuk.co.uk, chris@turbineenergyuk.co.uk, jackie@turbineenergyuk.co.uk

# Hide it from the address book so staff don't email it by accident
Set-DistributionGroup "CRM Mail Sync" -HiddenFromAddressListsEnabled $true
```

## Step 3: Give the app read access to that group only

Replace the three placeholders with the IDs from Step 1.

```powershell
New-ServicePrincipal -AppId "<Application (client) ID>" -ObjectId "<Enterprise app Object ID>" -DisplayName "Turbine CRM mail sync"

$dn = (Get-DistributionGroup "CRM Mail Sync").DistinguishedName
New-ManagementScope -Name "CRM Mail Sync mailboxes" -RecipientRestrictionFilter "MemberOfGroup -eq '$dn'"

New-ManagementRoleAssignment -App "<Application (client) ID>" -Role "Application Mail.Read" -CustomResourceScope "CRM Mail Sync mailboxes"
```

## Step 4: Check it

Changes can take **30 minutes to 2 hours** to apply. Then run:

```powershell
# Should show InScope = True
Test-ServicePrincipalAuthorization -Identity "<Application (client) ID>" -Resource info@turbineenergyuk.co.uk

# Pick any mailbox NOT in the group (e.g. an accounts mailbox): should show InScope = False
Test-ServicePrincipalAuthorization -Identity "<Application (client) ID>" -Resource <someone-else>@turbineenergyuk.co.uk
```

## Step 5: Send Greg three values, securely

- Directory (tenant) ID
- Application (client) ID
- Client secret **Value**

Please send the secret through a password manager, or split it across two channels. **Don't put it in a plain email.**

## Later changes

- **A new sales rep:** add their mailbox to the group (`Add-DistributionGroupMember "CRM Mail Sync" -Member <email>`) and tell Greg, so it can be switched on in the CRM.
- **Someone leaves:** remove them from the group.
- **The secret expires after 24 months.** Create a new one before then and send it to Greg the same way.
- **To cut off access completely:** delete the app registration, or run `Remove-ManagementRoleAssignment` on the assignment from Step 3.
