-- Purpose: tag generated submission PDFs vs user uploads on oe.PublicFormSubmissionFiles
IF NOT EXISTS (
    SELECT 1 FROM sys.columns
    WHERE object_id = OBJECT_ID('oe.PublicFormSubmissionFiles') AND name = 'FilePurpose'
)
BEGIN
    ALTER TABLE [oe].[PublicFormSubmissionFiles] ADD [FilePurpose] NVARCHAR(30) NULL;
    EXEC sys.sp_addextendedproperty
        @name = N'MS_Description',
        @value = N'attachment = user upload; submission_pdf = server-generated form record PDF',
        @level0type = N'SCHEMA', @level0name = N'oe',
        @level1type = N'TABLE',  @level1name = N'PublicFormSubmissionFiles',
        @level2type = N'COLUMN', @level2name = N'FilePurpose';
END
GO
