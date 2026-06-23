-- Undo script generated 2026-04-20T10:01:44.278Z
-- DB: allaboard-prod @ allboard-prod.database.windows.net
-- Target email: dustinhilldop@gmail.com
-- AgentId: CF01559B-4572-4B5E-BFD4-95AC3097DE35
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (2 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = 'CF01559B-4572-4B5E-BFD4-95AC3097DE35';
GO
INSERT INTO oe.TrainingCompletions ([TrainingCompletionId], [ProductId], [AgentId], [MemberId], [UserId], [AttemptNumber], [ScorePercent], [TotalQuestions], [CorrectAnswers], [CompletedAt], [CreatedDate], [ModifiedDate], [AnswersDetail])
VALUES
(N'BAFBB523-0DE1-4F4C-9085-283F76BC8B48', N'16ACE482-845A-4BC8-9A8F-489CD1D002CE', N'CF01559B-4572-4B5E-BFD4-95AC3097DE35', NULL, N'95FF6731-3683-4EC2-A839-4442DDDB423C', 1, 100, 2, 2, CAST('2026-02-03T22:02:12.360Z' AS datetime2), CAST('2026-02-03T22:02:12.360Z' AS datetime2), CAST('2026-02-03T22:02:12.360Z' AS datetime2), NULL),
(N'28F348FC-0376-4FCE-AADA-A73CD10EA7B9', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'CF01559B-4572-4B5E-BFD4-95AC3097DE35', NULL, N'95FF6731-3683-4EC2-A839-4442DDDB423C', 1, 100, 3, 3, CAST('2026-02-03T22:02:01.593Z' AS datetime2), CAST('2026-02-03T22:02:01.593Z' AS datetime2), CAST('2026-02-03T22:02:01.593Z' AS datetime2), NULL);
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = 'CF01559B-4572-4B5E-BFD4-95AC3097DE35';
GO
-- No rows to restore for oe.AgentTrainingLibraryModuleCompletions
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (0 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = 'CF01559B-4572-4B5E-BFD4-95AC3097DE35';
GO
-- No rows to restore for oe.AgentTrainingLibraryQuizCompletions
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (0 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = 'CF01559B-4572-4B5E-BFD4-95AC3097DE35';
GO
-- No rows to restore for oe.AgentTrainingPackageCertificateAwards
GO
