-- Allow duplicate SortOrder across inactive levels while enforcing
-- uniqueness for active levels only.

IF EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_CommissionLevels_Tenant_SortOrder'
      AND object_id = OBJECT_ID('oe.CommissionLevels')
)
BEGIN
    DROP INDEX UX_CommissionLevels_Tenant_SortOrder ON oe.CommissionLevels;
END;

IF NOT EXISTS (
    SELECT 1
    FROM sys.indexes
    WHERE name = 'UX_CommissionLevels_Tenant_SortOrder_Active'
      AND object_id = OBJECT_ID('oe.CommissionLevels')
)
BEGIN
    CREATE UNIQUE NONCLUSTERED INDEX UX_CommissionLevels_Tenant_SortOrder_Active
        ON oe.CommissionLevels (TenantId, SortOrder)
        WHERE IsActive = 1;
END;
