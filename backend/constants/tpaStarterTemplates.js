// backend/constants/tpaStarterTemplates.js
// Starter email templates for TPA case forwarding. Bodies use {[...]} merge
// tokens resolved by caseForwardingService.renderTemplate:
//   scalars:         {[member.*]}  {[plan.*]}  {[case.*]}
//   repeating block: {[#bills]} ... {[bill.*]} ... {[/bills]}
//
// Available tokens (see caseForwardingService.buildPreview context):
//   member.FullName, member.DateOfBirth, member.Email, member.Phone
//   plan.Name
//   case.Number, case.Type, case.Subcategory, case.Title, case.Description,
//   case.SubmittedDate, case.Status
//   bill.DateOfService, bill.ProviderName, bill.Description,
//   bill.BilledAmount, bill.AllowedAmount, bill.PaidAmount, bill.Balance
//
// Authored as blank-line-separated paragraphs so the Message Center editor
// imports each section as its own editable text block. Amounts are written
// WITHOUT a "$" immediately before a "{[" token (a literal "${[" would read as
// a JS interpolation); currency is labelled "(USD)". Every line is a
// single-quoted string joined with "\n" — never a backtick template literal.

const BODY = [
  'Hello {[plan.Name]} team,',
  '',
  'Please review and process the following member reimbursement request submitted through ShareWELL. Supporting documentation is attached.',
  '',
  'Member',
  'Name: {[member.FullName]}',
  'Date of birth: {[member.DateOfBirth]}',
  'Email: {[member.Email]}',
  'Phone: {[member.Phone]}',
  'Plan / TPA: {[plan.Name]}',
  '',
  'Case',
  'Reference #: {[case.Number]}',
  'Category: {[case.Type]} / {[case.Subcategory]}',
  'Date submitted: {[case.SubmittedDate]}',
  'Summary: {[case.Title]}',
  '',
  '{[case.Description]}',
  '',
  'Bills',
  '{[#bills]}- {[bill.DateOfService]} | {[bill.ProviderName]} — {[bill.Description]}',
  '   Billed {[bill.BilledAmount]} | Allowed {[bill.AllowedAmount]} | Paid {[bill.PaidAmount]} | Balance {[bill.Balance]} (USD)',
  '{[/bills]}',
  '',
  'Please reply to this email to confirm receipt or with any questions about this request.',
  '',
  'Thank you,',
  'ShareWELL Care Team',
].join('\n');

const SUBJECT = 'Reimbursement request - {[case.Number]} - {[member.FullName]}';

module.exports = {
  arm: { name: 'ARM - Reimbursement Forward', subject: SUBJECT, body: BODY },
  tallTree: { name: 'Tall Tree - Reimbursement Forward', subject: SUBJECT, body: BODY },
};
