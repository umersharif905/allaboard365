-- Undo script generated 2026-04-17T19:42:42.189Z
-- DB: allaboard-testing @ allboard-prod.database.windows.net
-- Target email: darrellartrip724@gmail.com
-- AgentId: 575F5647-0822-463F-B579-0E1D7584885D
SET NOCOUNT ON;
GO

-- Restore oe.TrainingCompletions (0 row(s))
DELETE FROM oe.TrainingCompletions
WHERE AgentId = '575F5647-0822-463F-B579-0E1D7584885D';
GO
-- No rows to restore for oe.TrainingCompletions
GO

-- Restore oe.AgentTrainingLibraryModuleCompletions (6 row(s))
DELETE FROM oe.AgentTrainingLibraryModuleCompletions
WHERE AgentId = '575F5647-0822-463F-B579-0E1D7584885D';
GO
INSERT INTO oe.AgentTrainingLibraryModuleCompletions ([AgentTrainingLibraryModuleCompletionId], [AgentId], [PackageId], [ModuleId], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'72D39746-C7DC-4651-88F9-129D272C5A77', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-02', CAST('2026-04-06T13:36:05.286Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2)),
(N'A0BD4012-2A00-49CB-8E1E-14BA86EF4F2B', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-06', CAST('2026-04-07T01:27:38.396Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2)),
(N'E3CAFB6E-6A97-439A-8F24-298581CC5A1A', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-01', CAST('2026-04-06T13:33:56.760Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2)),
(N'0791B5E7-1D03-4243-A242-3411C4659AB7', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-04', CAST('2026-04-07T00:35:43.043Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2)),
(N'F6671FB8-21E2-46FC-AE28-8D4EE1ED0915', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-03', CAST('2026-04-06T21:19:43.323Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2)),
(N'5E9C132B-A345-4D18-8959-B3DA95AEBDD6', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-05', CAST('2026-04-07T00:42:04.303Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2));
GO

-- Restore oe.AgentTrainingLibraryQuizCompletions (6 row(s))
DELETE FROM oe.AgentTrainingLibraryQuizCompletions
WHERE AgentId = '575F5647-0822-463F-B579-0E1D7584885D';
GO
INSERT INTO oe.AgentTrainingLibraryQuizCompletions ([AgentTrainingLibraryQuizCompletionId], [AgentId], [PackageId], [ModuleId], [StepId], [QuizId], [ScorePercent], [TotalQuestions], [CorrectAnswers], [AttemptCount], [CompletedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'8AA09D50-06D1-4D6F-877D-5F592D2B9179', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-05', N'step-042', N'quiz-014', 100, 8, 8, 1, CAST('2026-04-07T00:42:04.303Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2)),
(N'F36B2126-8CCE-401A-9144-6B2E80D201A2', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-01', N'step-030', N'quiz-010', 100, 7, 7, 1, CAST('2026-04-06T13:33:56.760Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2)),
(N'6B0941AF-1A7A-4BD3-8BEB-78D460AB1D96', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-04', N'step-036', N'quiz-012', 100, 8, 8, 1, CAST('2026-04-07T00:35:43.043Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2)),
(N'0906A873-DFC1-4964-A7DC-8410AF613AE2', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-03', N'step-039', N'quiz-013', 100, 11, 11, 1, CAST('2026-04-06T21:19:43.323Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2)),
(N'9D2F52A2-D6AA-4746-B422-A378F237CD82', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-06', N'step-045', N'quiz-015', 100, 10, 10, 1, CAST('2026-04-07T01:27:38.396Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2)),
(N'331D0436-EAA7-4460-9F11-C64BB098D526', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'mod-02', N'step-033', N'quiz-011', 100, 9, 9, 1, CAST('2026-04-06T13:36:05.286Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2), CAST('2026-04-17T19:25:13.986Z' AS datetime2));
GO

-- Restore oe.AgentTrainingPackageCertificateAwards (1 row(s))
DELETE FROM oe.AgentTrainingPackageCertificateAwards
WHERE AgentId = '575F5647-0822-463F-B579-0E1D7584885D';
GO
INSERT INTO oe.AgentTrainingPackageCertificateAwards ([AgentTrainingPackageCertificateAwardId], [AgentId], [PackageId], [PackageName], [CertificateName], [CertificateDetails], [CertificateImageUrl], [AwardedAt], [CreatedDate], [ModifiedDate])
VALUES
(N'CE2C205F-1B5D-481E-A9CB-FA3F0E927F52', N'575F5647-0822-463F-B579-0E1D7584885D', N'pkg-mw-001', N'MightyWell Agent Qualification Core Package', N'MightyWell Agent Qualification Core Certificate', N'Awarded for achieving a cumulative quiz score of 70% or higher for this package.', N'https://res.cloudinary.com/doi8qjcv6/image/upload/v1775673439/customers/mightywell/cm3_nqvdqs.webp', CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2), CAST('2026-04-17T19:25:13.990Z' AS datetime2));
GO
