-- One-off: set John Nadasdy's Health license (was Inactive) to Active.
-- Agent: johnnadasdy71@gmail.com | AgentId DA339BD9-FB2D-425E-89EB-B3FBF2136F1F
-- LicenseId 4504EC0A-AB06-4749-9A47-1B4545ACB688 | LicenseType Health | State CO
--
-- Prefer targeting LicenseId. Remove the AND clauses below if you use only LicenseId.

UPDATE oe.AgentLicenses
SET
    Status = N'Active',
    ModifiedDate = SYSUTCDATETIME()
WHERE LicenseId = '4504EC0A-AB06-4749-9A47-1B4545ACB688'
  AND AgentId = 'DA339BD9-FB2D-425E-89EB-B3FBF2136F1F'
  AND LicenseType = N'Health'
  AND StateCode = N'CO';

-- Optional: verify (expect 1 row if the update matched)
-- SELECT LicenseId, LicenseType, StateCode, Status, EffectiveDate, ExpirationDate
-- FROM oe.AgentLicenses
-- WHERE AgentId = 'DA339BD9-FB2D-425E-89EB-B3FBF2136F1F'
-- ORDER BY LicenseType, StateCode;
