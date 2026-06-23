-- Check for ARM vendor documents
-- This query checks for documents uploaded for the ARM vendor

-- First, find the ARM vendor ID
SELECT 
    VendorId,
    VendorName
FROM oe.Vendors
WHERE VendorName LIKE '%ARM%'
   OR VendorName = 'ARM';

-- Then check for documents for ARM vendor
-- Replace @ARM_VENDOR_ID with the actual VendorId from above query
SELECT 
    f.FileId as DocumentId,
    f.EntityId as VendorId,
    v.VendorName,
    f.FileName,
    f.MimeType as FileType,
    f.FileSize,
    f.Category as DocumentType,
    f.Description,
    f.CreatedDate as UploadedDate,
    f.UploadedBy,
    u.FirstName + ' ' + u.LastName as UploadedByName,
    f.FilePath as Url,
    f.Status
FROM oe.FileUploads f
INNER JOIN oe.Vendors v ON f.EntityId = v.VendorId
LEFT JOIN oe.Users u ON f.UploadedBy = u.UserId
WHERE v.VendorName LIKE '%ARM%'
   OR v.VendorName = 'ARM'
   AND f.UploadType = 'agreements'
   AND f.Status != 'Deleted'
ORDER BY f.CreatedDate DESC;

-- Check all documents for ARM vendor (including deleted)
SELECT 
    f.FileId as DocumentId,
    f.EntityId as VendorId,
    v.VendorName,
    f.FileName,
    f.Category as DocumentType,
    f.Description,
    f.Status,
    f.CreatedDate as UploadedDate,
    f.UploadType
FROM oe.FileUploads f
INNER JOIN oe.Vendors v ON f.EntityId = v.VendorId
WHERE v.VendorName LIKE '%ARM%'
   OR v.VendorName = 'ARM'
ORDER BY f.CreatedDate DESC;
