-- Undo script generated 2026-04-17T20:51:45.303Z
-- DB: allaboard-prod @ allboard-prod.database.windows.net
-- Target email: klong@cig-ok.com
-- AgentId: 47114B7D-72E3-4879-B531-AC879A7DB767
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (0 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = '47114B7D-72E3-4879-B531-AC879A7DB767';
GO
-- No rows to restore for oe.TrainingCompletions
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (3 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = '47114B7D-72E3-4879-B531-AC879A7DB767';
GO
INSERT INTO oe.AgentTrainingLibraryModuleCompletions ([AgentTrainingLibraryModuleCompletionId], [AgentId], [PackageId], [ModuleId], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'07E0250F-041E-4953-BF96-1E26BDCCD89B', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-01', CAST('2026-04-16T17:03:14.443Z' AS datetime2), CAST('2026-04-15T20:47:15.773Z' AS datetime2), CAST('2026-04-16T17:03:14.443Z' AS datetime2)),
(N'023CB4F2-0006-464A-B906-9CF1AD16B936', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-0001', CAST('2026-04-08T15:08:38.583Z' AS datetime2), CAST('2026-04-08T15:08:38.583Z' AS datetime2), CAST('2026-04-08T15:08:38.583Z' AS datetime2)),
(N'043F3E1E-8830-4619-9C9C-D9480EFA9D3F', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-0002', CAST('2026-04-08T15:12:32.240Z' AS datetime2), CAST('2026-04-08T15:12:32.240Z' AS datetime2), CAST('2026-04-08T15:12:32.240Z' AS datetime2));
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (3 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = '47114B7D-72E3-4879-B531-AC879A7DB767';
GO
INSERT INTO oe.AgentTrainingLibraryQuizCompletions ([AgentTrainingLibraryQuizCompletionId], [AgentId], [PackageId], [ModuleId], [StepId], [QuizId], [ScorePercent], [TotalQuestions], [CorrectAnswers], [AttemptCount], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'A4C895CE-894D-467E-AD20-3F6DBE5BD549', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-01', N'step-030', N'quiz-010', 100, 7, 7, 1, CAST('2026-04-15T20:47:17.520Z' AS datetime2), CAST('2026-04-15T20:47:17.520Z' AS datetime2), CAST('2026-04-15T20:47:17.520Z' AS datetime2)),
(N'C42934BC-6545-4699-BDA7-6D2A48442F1A', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-0002', N'step-010', N'quiz-004', 100, 10, 10, 1, CAST('2026-04-08T15:12:34.340Z' AS datetime2), CAST('2026-04-08T15:12:34.340Z' AS datetime2), CAST('2026-04-08T15:12:34.340Z' AS datetime2)),
(N'C074639E-07EE-4484-BF7A-B6E7920B0906', N'47114B7D-72E3-4879-B531-AC879A7DB767', N'pkg-mw-001', N'mod-0001', N'step-007', N'quiz-003', 100, 10, 10, 1, CAST('2026-04-08T15:08:41.373Z' AS datetime2), CAST('2026-04-08T15:08:41.373Z' AS datetime2), CAST('2026-04-08T15:08:41.373Z' AS datetime2));
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (0 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = '47114B7D-72E3-4879-B531-AC879A7DB767';
GO
-- No rows to restore for oe.AgentTrainingPackageCertificateAwards
GO
