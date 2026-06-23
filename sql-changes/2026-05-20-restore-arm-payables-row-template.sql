-- Restore ARM vendor payables export to Mightywell aggregated format (Health/Dental/Vision per member).
-- Prod had a per-product PayablesRowTemplate saved from admin UI "Default payables format" (wrong preset).
-- NULL = use backend getDefaultPayablesTemplate() which matches ARM_payables_YYYYMMDD.csv.

UPDATE oe.Vendors
SET PayablesRowTemplate = NULL
WHERE VendorId = '406B4EEA-F334-4EFC-82D5-89545E55CC01'
  AND VendorName = N'ARM';

-- Optional: set explicitly instead of NULL:
-- UPDATE oe.Vendors SET PayablesRowTemplate = N'{MemberID:Member ID},{FirstName:First Name},{LastName:Last Name},{State:State},{GroupName:Group Name},{Health:Health},{Dental:Dental},{Vision:Vision},{AllApplicableProducts:AllApplicableProducts},{VendorNetRate:Vendor Amount},{EffectiveDate:Effective Date},{PaidThroughStart:Paid Through Start},{PaidThroughEnd:Paid Through End},{AgentName:Agent Name}'
-- WHERE VendorId = '406B4EEA-F334-4EFC-82D5-89545E55CC01';
