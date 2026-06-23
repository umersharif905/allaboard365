-- ============================================================================
-- COLLIER: Terminate Ayden and Tyler enrollments (parent James has no ARM enrollment)
-- "If parent isn't active then neither should children be"
-- ============================================================================
-- Members (for reference):
--   James Collier (Primary) - MemberId 08D6FA49-E26B-43DF-B8D3-9319BDDE7124 - no ARM enrollments
--   Ayden Collier (Child)   - MemberId 0DAC87D7-9213-40C0-8EA5-97C012AD1603
--   Tyler Collier (Child)   - MemberId 68BFB453-37CA-46BD-A755-22CB9B4A5546
-- ============================================================================

PRINT 'Terminating COLLIER dependents (Ayden, Tyler) enrollments by EnrollmentId...';

-- Ayden Collier enrollments (Vision, Dental - ARM)
UPDATE oe.Enrollments
SET Status = 'Terminated', TerminationDate = GETUTCDATE()
WHERE EnrollmentId IN (
    '5F42409D-CE4D-4D34-8790-F5BEC0DD920D',  -- Ayden, MightyWELL Vision (arm)
    '19BC32CA-BFD1-453A-8F90-E259E90478BB'   -- Ayden, MightyWELL Dental (arm)
);

PRINT 'Ayden enrollments terminated: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

-- Tyler Collier enrollments (Vision, Dental - ARM)
UPDATE oe.Enrollments
SET Status = 'Terminated', TerminationDate = GETUTCDATE()
WHERE EnrollmentId IN (
    'E52E74BF-80EC-4C6C-84E4-ED23C93B6521',  -- Tyler, MightyWELL Vision (arm)
    'B8FE4A9B-1A0D-4424-97DC-BE7279170B9B'   -- Tyler, MightyWELL Dental (arm)
);

PRINT 'Tyler enrollments terminated: ' + CAST(@@ROWCOUNT AS NVARCHAR(10));

PRINT 'Done. Ayden and Tyler COLLIER enrollments set to Terminated.';

-- ============================================================================
-- Optional: hard DELETE (uncomment only if you really want to remove rows)
-- ============================================================================
/*
DELETE FROM oe.Enrollments
WHERE EnrollmentId IN (
    '5F42409D-CE4D-4D34-8790-F5BEC0DD920D',
    '19BC32CA-BFD1-453A-8F90-E259E90478BB',
    'E52E74BF-80EC-4C6C-84E4-ED23C93B6521',
    'B8FE4A9B-1A0D-4424-97DC-BE7279170B9B'
);
*/
