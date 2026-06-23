-- Migration: Create oe.ProposalDocumentProducts table
-- Date: 2026-02-10
-- Description: Add product slots to proposal templates so SysAdmins can assign
--   products/bundles to numbered slots (Product 1, Product 2, etc.).
--   Calculation fields reference a slot number instead of a specific product.

-- Create table if it doesn't exist
IF NOT EXISTS (
    SELECT 1 
    FROM sys.objects 
    WHERE object_id = OBJECT_ID('oe.ProposalDocumentProducts') 
    AND type = 'U'
)
BEGIN
    CREATE TABLE oe.ProposalDocumentProducts (
        ProposalDocumentProductId UNIQUEIDENTIFIER NOT NULL DEFAULT NEWID(),
        ProposalDocumentId UNIQUEIDENTIFIER NOT NULL,
        ProductId UNIQUEIDENTIFIER NOT NULL,
        SlotNumber INT NOT NULL,
        CreatedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        ModifiedDate DATETIME2 NOT NULL DEFAULT GETUTCDATE(),
        
        CONSTRAINT PK_ProposalDocumentProducts PRIMARY KEY (ProposalDocumentProductId),
        CONSTRAINT FK_ProposalDocumentProducts_ProposalDocuments 
            FOREIGN KEY (ProposalDocumentId) REFERENCES oe.ProposalDocuments(ProposalDocumentId),
        CONSTRAINT FK_ProposalDocumentProducts_Products 
            FOREIGN KEY (ProductId) REFERENCES oe.Products(ProductId),
        CONSTRAINT UQ_ProposalDocumentProducts_Slot 
            UNIQUE (ProposalDocumentId, SlotNumber)
    );

    PRINT 'oe.ProposalDocumentProducts table created';
END
ELSE
BEGIN
    PRINT 'oe.ProposalDocumentProducts table already exists';
END
GO

-- Seed: Add MightyWELL CoPay as Slot 1 for "Copay Proposal - Business" template
IF NOT EXISTS (
    SELECT 1 
    FROM oe.ProposalDocumentProducts 
    WHERE ProposalDocumentId = 'A74EA844-ED62-4117-A1FD-813947AB1689'
    AND SlotNumber = 1
)
BEGIN
    INSERT INTO oe.ProposalDocumentProducts 
        (ProposalDocumentProductId, ProposalDocumentId, ProductId, SlotNumber, CreatedDate, ModifiedDate)
    VALUES 
        (NEWID(), 'A74EA844-ED62-4117-A1FD-813947AB1689', '9ABA9433-6BD9-4C3C-A210-6AA56DBBC423', 1, GETUTCDATE(), GETUTCDATE());

    PRINT 'Seeded Slot 1 = MightyWELL CoPay for Copay Proposal - Business template';
END
ELSE
BEGIN
    PRINT 'Slot 1 already exists for Copay Proposal - Business template';
END
GO
