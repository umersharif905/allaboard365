-- Undo script generated 2026-04-20T10:02:13.324Z
-- DB: allaboard-prod @ allboard-prod.database.windows.net
-- Target email: steveburrisCoaching@gmail.com
-- AgentId: E9AF3D61-C20C-46BC-98D6-256AD27581D1
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (1 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = 'E9AF3D61-C20C-46BC-98D6-256AD27581D1';
GO
INSERT INTO oe.TrainingCompletions ([TrainingCompletionId], [ProductId], [AgentId], [MemberId], [UserId], [AttemptNumber], [ScorePercent], [TotalQuestions], [CorrectAnswers], [CompletedAt], [CreatedDate], [ModifiedDate], [AnswersDetail])
VALUES
(N'9AC754CB-6640-4517-BC98-D52EFB1D5442', N'F165AF93-8268-448D-9DD6-F02FB338EEAE', N'E9AF3D61-C20C-46BC-98D6-256AD27581D1', NULL, N'B16896FB-485C-4A2D-A615-841B87305D7F', 1, 33.33, 3, 1, CAST('2026-02-05T18:17:13.046Z' AS datetime2), CAST('2026-02-05T18:17:13.046Z' AS datetime2), CAST('2026-02-05T18:17:13.046Z' AS datetime2), NULL);
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (1 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = 'E9AF3D61-C20C-46BC-98D6-256AD27581D1';
GO
INSERT INTO oe.AgentTrainingLibraryModuleCompletions ([AgentTrainingLibraryModuleCompletionId], [AgentId], [PackageId], [ModuleId], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'5229AE8C-DEF7-4896-8203-9D00E1F58EA8', N'E9AF3D61-C20C-46BC-98D6-256AD27581D1', N'pkg-mw-001', N'mod-0001', CAST('2026-04-04T13:04:55.720Z' AS datetime2), CAST('2026-04-04T13:04:55.720Z' AS datetime2), CAST('2026-04-04T13:04:55.720Z' AS datetime2));
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (1 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = 'E9AF3D61-C20C-46BC-98D6-256AD27581D1';
GO
INSERT INTO oe.AgentTrainingLibraryQuizCompletions ([AgentTrainingLibraryQuizCompletionId], [AgentId], [PackageId], [ModuleId], [StepId], [QuizId], [ScorePercent], [TotalQuestions], [CorrectAnswers], [AttemptCount], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'FA156168-AD5C-4F8D-BFC4-3267D464F178', N'E9AF3D61-C20C-46BC-98D6-256AD27581D1', N'pkg-mw-001', N'mod-0001', N'step-007', N'quiz-003', 100, 10, 10, 1, CAST('2026-04-04T13:04:58.026Z' AS datetime2), CAST('2026-04-04T13:04:58.026Z' AS datetime2), CAST('2026-04-04T13:04:58.026Z' AS datetime2));
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (0 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = 'E9AF3D61-C20C-46BC-98D6-256AD27581D1';
GO
-- No rows to restore for oe.AgentTrainingPackageCertificateAwards
GO
