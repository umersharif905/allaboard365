/*
  Add EquivalentTier to GroupContributions for percentage rules.
  When set (EE, ES, EC, EF), employer pays X% of that tier's premium for everyone.
  NULL = current behavior (% of actual premium).
*/

IF COL_LENGTH('oe.GroupContributions', 'EquivalentTier') IS NULL
BEGIN
  ALTER TABLE oe.GroupContributions
    ADD EquivalentTier NVARCHAR(10) NULL;
END
