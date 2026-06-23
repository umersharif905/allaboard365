-- Per-product JSON for member portal "Medical Needs Requests" links (category + form/custom URLs).
IF COL_LENGTH('oe.Products', 'MedicalNeedsLinksConfig') IS NULL
BEGIN
    ALTER TABLE oe.Products ADD MedicalNeedsLinksConfig NVARCHAR(MAX) NULL;
END
GO
