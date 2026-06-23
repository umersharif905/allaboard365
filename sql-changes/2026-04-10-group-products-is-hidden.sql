-- Add IsHidden flag to oe.GroupProducts
-- Allows agents to hide products from new enrollments without removing them.
-- Hidden products retain their CustomSettings so existing enrollments are unaffected.

IF COL_LENGTH('oe.GroupProducts', 'IsHidden') IS NULL
BEGIN
  ALTER TABLE oe.GroupProducts
    ADD IsHidden BIT NOT NULL
      CONSTRAINT DF_GroupProducts_IsHidden DEFAULT (0);
END;
