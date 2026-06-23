/*
  Add MustBeSoldWithProductIds to tenant product subscriptions.
  When set, this product cannot be purchased alone; at least one of the listed products must also be selected.
  Stored as JSON array of ProductId GUIDs, e.g. ["guid1","guid2"].
*/

IF COL_LENGTH('oe.TenantProductSubscriptions', 'MustBeSoldWithProductIds') IS NULL
BEGIN
  ALTER TABLE oe.TenantProductSubscriptions
    ADD MustBeSoldWithProductIds NVARCHAR(MAX) NULL;
END
