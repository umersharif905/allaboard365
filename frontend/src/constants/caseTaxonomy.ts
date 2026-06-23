// Fallback label maps for the 5 default Case types and their
// subcategories. Used by useCaseTaxonomy() ONLY when a legacy code on a
// ticket no longer maps to an active vendor-scoped row (so the rail/header
// still renders something readable).
//
// The authoritative taxonomy lives in oe.CaseTypes /
// oe.CaseSubcategories per vendor (see useCaseTaxonomy).

export const FALLBACK_TYPE_LABELS: Record<string, string> = {
  reimbursement:         'Reimbursement',
  billing:               'Billing',
  encounter_escalation:  'Encounter Escalation',
  complaint:             'Complaint',
  appeals:               'Appeals',
};

export const FALLBACK_SUBCATEGORY_LABELS: Record<string, string> = {
  oon_copay:              'OON Copay',
  preventative:           'Preventative',
  other:                  'Other',
  provider_invoice:       'Provider Invoice',
  negotiation:            'Negotiation',
  recovery:               'Recovery',
  claims_cob:             'Claims / COB',
  needs_follow_up:        'Needs Follow Up',
  issue_raised:           'Issue Raised',
  routed_to_team:         'Routed to Team',
  service_quality:        'Service Quality',
  process_outcome:        'Process / Outcome',
  privacy:                'Privacy',
  denied_share:           'Denied Share',
  denied_reimbursement:   'Denied Reimbursement',
  amount_dispute:         'Amount Dispute',
  second_level:           '2nd Level',
};
