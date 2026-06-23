-- Auto-create Group enrollment link templates for groups that don't have one.
-- Each group should have exactly one Group-type template for the simplified enrollment flow.

INSERT INTO oe.EnrollmentLinkTemplates (
  TemplateId, TemplateName, TemplateType, TenantId, AgentId, GroupId,
  LinkMetaData, IsActive, CreatedDate, ModifiedDate, CreatedBy, ModifiedBy
)
SELECT
  NEWID(),
  g.Name + ' Group Enrollment',
  'Group',
  g.TenantId,
  g.AgentId,
  g.GroupId,
  '{"household":{"collectSSN":true,"collectDOB":true,"collectGender":true,"collectAddress":true,"collectPhone":true}}',
  1,
  GETDATE(),
  GETDATE(),
  a.UserId,
  a.UserId
FROM oe.Groups g
INNER JOIN oe.Agents a ON g.AgentId = a.AgentId
WHERE g.Status = 'Active'
  AND NOT EXISTS (
    SELECT 1 FROM oe.EnrollmentLinkTemplates elt
    WHERE elt.GroupId = g.GroupId
      AND elt.TemplateType = 'Group'
      AND elt.IsActive = 1
  );
