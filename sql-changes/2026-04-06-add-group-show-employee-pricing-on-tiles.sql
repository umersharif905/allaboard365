-- Add ShowEmployeePricingOnTiles toggle to Groups table.
-- When enabled and the group only has product-specific contribution rules,
-- the enrollment wizard shows the employee's after-contribution cost on product tiles.
IF COL_LENGTH('oe.Groups', 'ShowEmployeePricingOnTiles') IS NULL
BEGIN
    ALTER TABLE oe.Groups
        ADD ShowEmployeePricingOnTiles BIT NOT NULL DEFAULT 1;
END

-- Add ShowContributionStrategy toggle to Groups table.
-- When enabled, the enrollment wizard shows a plain-English summary of the
-- employer's contribution strategy so employees understand how their costs are reduced.
IF COL_LENGTH('oe.Groups', 'ShowContributionStrategy') IS NULL
BEGIN
    ALTER TABLE oe.Groups
        ADD ShowContributionStrategy BIT NOT NULL DEFAULT 0;
END
