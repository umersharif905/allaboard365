-- Undo script generated 2026-04-20T09:46:48.381Z
-- DB: allaboard-prod @ allboard-prod.database.windows.net
-- Target email: julie@lotuslegacypartners.com
-- AgentId: 57BB002E-FF54-42D0-8971-2C97F50A2220
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (4 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = '57BB002E-FF54-42D0-8971-2C97F50A2220';
GO
INSERT INTO oe.TrainingCompletions ([TrainingCompletionId], [ProductId], [AgentId], [MemberId], [UserId], [AttemptNumber], [ScorePercent], [TotalQuestions], [CorrectAnswers], [CompletedAt], [CreatedDate], [ModifiedDate], [AnswersDetail])
VALUES
(N'BC97C8A3-62DF-4BAA-AFE1-19D2C5AC7104', N'16ACE482-845A-4BC8-9A8F-489CD1D002CE', N'57BB002E-FF54-42D0-8971-2C97F50A2220', NULL, N'1D7C4D62-6104-492A-B2C0-7E5D2F6044EA', 1, 100, 2, 2, CAST('2026-02-05T16:38:14.500Z' AS datetime2), CAST('2026-02-05T16:38:14.500Z' AS datetime2), CAST('2026-02-05T16:38:14.500Z' AS datetime2), NULL),
(N'E8B5DDB3-1ADF-4F6E-B821-38CCF8347E78', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'57BB002E-FF54-42D0-8971-2C97F50A2220', NULL, N'1D7C4D62-6104-492A-B2C0-7E5D2F6044EA', 1, 33.33, 3, 1, CAST('2026-02-05T16:37:33.870Z' AS datetime2), CAST('2026-02-05T16:37:33.870Z' AS datetime2), CAST('2026-02-05T16:37:33.870Z' AS datetime2), NULL),
(N'C8A1BDBE-90E8-4D6F-9F66-5C4BB6FC163D', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'57BB002E-FF54-42D0-8971-2C97F50A2220', NULL, N'1D7C4D62-6104-492A-B2C0-7E5D2F6044EA', 3, 100, 3, 3, CAST('2026-02-05T16:38:31.010Z' AS datetime2), CAST('2026-02-05T16:38:31.010Z' AS datetime2), CAST('2026-02-05T16:38:31.010Z' AS datetime2), NULL),
(N'42AF133F-16F4-4AF5-88BF-600DE75DEAD5', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'57BB002E-FF54-42D0-8971-2C97F50A2220', NULL, N'1D7C4D62-6104-492A-B2C0-7E5D2F6044EA', 2, 100, 3, 3, CAST('2026-02-05T16:38:01.100Z' AS datetime2), CAST('2026-02-05T16:38:01.100Z' AS datetime2), CAST('2026-02-05T16:38:01.100Z' AS datetime2), NULL);
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = '57BB002E-FF54-42D0-8971-2C97F50A2220';
GO
-- No rows to restore for oe.AgentTrainingLibraryModuleCompletions
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = '57BB002E-FF54-42D0-8971-2C97F50A2220';
GO
-- No rows to restore for oe.AgentTrainingLibraryQuizCompletions
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (0 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = '57BB002E-FF54-42D0-8971-2C97F50A2220';
GO
-- No rows to restore for oe.AgentTrainingPackageCertificateAwards
GO
