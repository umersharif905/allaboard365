-- Migration: Add Product Questionnaires and Member Health Metrics
-- Date: 2026-03-25
-- Purpose: Support product-level questionnaires and height/weight collection

-- 1. Add ProductQuestionnaires JSON column to Products table
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Products') AND name = 'ProductQuestionnaires'
)
BEGIN
  ALTER TABLE oe.Products ADD ProductQuestionnaires NVARCHAR(MAX) NULL;
  PRINT 'Added ProductQuestionnaires to oe.Products';
END
GO

-- 2. Add Height and Weight columns to Members table
IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Members') AND name = 'Height'
)
BEGIN
  ALTER TABLE oe.Members ADD Height INT NULL;
  PRINT 'Added Height (inches) to oe.Members';
END
GO

IF NOT EXISTS (
  SELECT 1 FROM sys.columns
  WHERE object_id = OBJECT_ID('oe.Members') AND name = 'Weight'
)
BEGIN
  ALTER TABLE oe.Members ADD Weight INT NULL;
  PRINT 'Added Weight (pounds) to oe.Members';
END
GO
