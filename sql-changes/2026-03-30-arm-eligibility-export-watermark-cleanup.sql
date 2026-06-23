/*
  ARM eligibility export — optional DB cleanup (manual run)

  Normal / desired behavior (what you want):
  - Keep the **sent** baseline file (e.g. March 5/6, 110 rows, marked sent).
  - Later “Generate eligibility file” runs are **change-only**: new enrollments, terminations,
    and enrollments with CreatedDate/ModifiedDate after that send — not another full 110-row file.
  - A smaller row count (e.g. ~10) after the baseline can be **correct** if that’s all that
    changed since the last SentAt.

  Option A: remove orphan history only (VendorEligibilityExportFileId IS NULL). Safe cleanup;
  does **not** remove your sent baseline.

  Option C / B: **do not use** if you want to keep the March baseline. They delete sent files
  and force the next export to be a **full** snapshot. Uncomment only when you intentionally
  want to reset the watermark.

  Vendor: ARM. Change @VendorId for another DB/vendor.
*/

DECLARE @VendorId UNIQUEIDENTIFIER = '406B4EEA-F334-4EFC-82D5-89545E55CC01'; -- ARM

-- ---------------------------------------------------------------------------
-- PREVIEW
-- ---------------------------------------------------------------------------
SELECT 'VendorEligibilityExportFile' AS Src, FileId, GeneratedAt, SentAt, RecordCount, FileName
FROM oe.VendorEligibilityExportFile
WHERE VendorId = @VendorId
ORDER BY GeneratedAt DESC;

SELECT 'VendorEligibilityExportHistory' AS Src, SentAt, RecordCount, VendorEligibilityExportFileId, FileName
FROM oe.VendorEligibilityExportHistory
WHERE VendorId = @VendorId
ORDER BY SentAt DESC;

-- ---------------------------------------------------------------------------
-- OPTION A: orphan history only (NULL VendorEligibilityExportFileId). Re-run harmless.
-- ---------------------------------------------------------------------------
-- DELETE FROM oe.VendorEligibilityExportHistory
-- WHERE VendorId = @VendorId AND VendorEligibilityExportFileId IS NULL;

-- ---------------------------------------------------------------------------
-- OPTION C — **Abandons baseline**: deletes **sent** files + linked history only.
-- Next generate = full snapshot. Do **NOT** run if you want to keep March 110-row baseline.
-- ---------------------------------------------------------------------------
-- BEGIN TRANSACTION;
-- DELETE FROM oe.VendorEligibilityExportHistory
-- WHERE VendorEligibilityExportFileId IN (
--     SELECT FileId FROM oe.VendorEligibilityExportFile
--     WHERE VendorId = @VendorId AND SentAt IS NOT NULL
-- );
-- DELETE FROM oe.VendorEligibilityExportFile
-- WHERE VendorId = @VendorId AND SentAt IS NOT NULL;
-- SELECT 'AfterOptionC_Files' AS Src, * FROM oe.VendorEligibilityExportFile WHERE VendorId = @VendorId;
-- SELECT 'AfterOptionC_History' AS Src, * FROM oe.VendorEligibilityExportHistory WHERE VendorId = @VendorId;
-- COMMIT TRANSACTION;

-- ---------------------------------------------------------------------------
-- OPTION B (nuclear): ALL history + ALL files for vendor (including pending).
-- ---------------------------------------------------------------------------
-- BEGIN TRANSACTION;
-- DELETE FROM oe.VendorEligibilityExportHistory WHERE VendorId = @VendorId;
-- DELETE FROM oe.VendorEligibilityExportFile WHERE VendorId = @VendorId;
-- COMMIT TRANSACTION;
