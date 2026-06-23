-- Adds tenant-controlled flag: when enabled, agents may see payout amounts for all commission levels
-- (their level is highlighted in the agent product UI).

IF NOT EXISTS (
  SELECT 1
  FROM sys.columns
  WHERE object_id = OBJECT_ID(N'oe.CommissionGroups')
    AND name = N'AgentsCanViewOtherCommissionLevels'
)
BEGIN
  ALTER TABLE oe.CommissionGroups ADD AgentsCanViewOtherCommissionLevels BIT NOT NULL
    CONSTRAINT DF_CommissionGroups_AgentsCanViewOtherCommissionLevels DEFAULT (0);
END
GO
