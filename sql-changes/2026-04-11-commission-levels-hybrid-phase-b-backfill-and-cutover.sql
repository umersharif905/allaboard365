-- Hybrid custom commission levels (Phase B/C helpers)
-- Backfill CommissionLevelId from existing CommissionTierLevel values.
-- Safe to run repeatedly.

IF COL_LENGTH('oe.Agents', 'CommissionLevelId') IS NOT NULL
BEGIN
    UPDATE a
    SET
        a.CommissionLevelId = cl.CommissionLevelId,
        a.ModifiedDate = GETUTCDATE()
    FROM oe.Agents a
    INNER JOIN oe.CommissionLevels cl
        ON cl.TenantId = a.TenantId
       AND cl.IsActive = 1
       AND cl.LegacyTierLevel = a.CommissionTierLevel
    WHERE a.CommissionLevelId IS NULL
      AND a.CommissionTierLevel IS NOT NULL;
END;

IF COL_LENGTH('oe.Agencies', 'CommissionLevelId') IS NOT NULL
BEGIN
    UPDATE a
    SET
        a.CommissionLevelId = cl.CommissionLevelId,
        a.ModifiedDate = GETUTCDATE()
    FROM oe.Agencies a
    INNER JOIN oe.CommissionLevels cl
        ON cl.TenantId = a.TenantId
       AND cl.IsActive = 1
       AND cl.LegacyTierLevel = a.CommissionTierLevel
    WHERE a.CommissionLevelId IS NULL
      AND a.CommissionTierLevel IS NOT NULL;
END;

-- Optional per-tenant cutover:
-- Once a tenant is fully migrated and validated, enable custom-only writes.
-- UPDATE oe.Tenants
-- SET UseCustomCommissionLevelsOnly = 1,
--     ModifiedDate = GETUTCDATE()
-- WHERE TenantId = '<TENANT_ID>';

-- Optional rollback to hybrid writes:
-- UPDATE oe.Tenants
-- SET UseCustomCommissionLevelsOnly = 0,
--     ModifiedDate = GETUTCDATE()
-- WHERE TenantId = '<TENANT_ID>';
