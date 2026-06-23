-- Undo script generated 2026-04-20T09:48:53.175Z
-- DB: allaboard-prod @ allboard-prod.database.windows.net
-- Target email: wfg.kim.harris@gmail.com
-- AgentId: B4868044-F7D1-4A10-B801-59A9F3429CA2
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (2 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = 'B4868044-F7D1-4A10-B801-59A9F3429CA2';
GO
INSERT INTO oe.TrainingCompletions ([TrainingCompletionId], [ProductId], [AgentId], [MemberId], [UserId], [AttemptNumber], [ScorePercent], [TotalQuestions], [CorrectAnswers], [CompletedAt], [CreatedDate], [ModifiedDate], [AnswersDetail])
VALUES
(N'BACE8DC2-C277-4070-B214-23C060B9F888', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'B4868044-F7D1-4A10-B801-59A9F3429CA2', NULL, N'43C916BA-E6B5-48BB-B6A6-D6C836AC6234', 1, 100, 3, 3, CAST('2026-02-04T21:13:55.416Z' AS datetime2), CAST('2026-02-04T21:13:55.416Z' AS datetime2), CAST('2026-02-04T21:13:55.416Z' AS datetime2), NULL),
(N'D81401C4-5045-486A-B84B-D561158661F0', N'16ACE482-845A-4BC8-9A8F-489CD1D002CE', N'B4868044-F7D1-4A10-B801-59A9F3429CA2', NULL, N'43C916BA-E6B5-48BB-B6A6-D6C836AC6234', 1, 100, 2, 2, CAST('2026-02-04T21:14:09.880Z' AS datetime2), CAST('2026-02-04T21:14:09.880Z' AS datetime2), CAST('2026-02-04T21:14:09.880Z' AS datetime2), NULL);
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = 'B4868044-F7D1-4A10-B801-59A9F3429CA2';
GO
-- No rows to restore for oe.AgentTrainingLibraryModuleCompletions
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = 'B4868044-F7D1-4A10-B801-59A9F3429CA2';
GO
-- No rows to restore for oe.AgentTrainingLibraryQuizCompletions
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (0 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = 'B4868044-F7D1-4A10-B801-59A9F3429CA2';
GO
-- No rows to restore for oe.AgentTrainingPackageCertificateAwards
GO
