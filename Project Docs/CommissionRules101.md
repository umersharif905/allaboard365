Open-Enroll Commission Rules & Tier Structure Summary
Overview
• Commission model supports flat, percentage, split, tier-based, and advancements.
• Rules apply to agents, agencies, associates, FMOs/IMOs, and other distribution tiers.
• System resolves final payouts into Commission Logs for full auditability.
• Commission rules must be locked with an effect date before considered active.  Termination date is not required.  If there’s no termination date the rule will remain active until a termination date is applied. 
• Commission rules cannot be modified once they are locked.  To modify a commission rule it must be terminated and a new rule created
• Terminated commission rules will be archived for audit purposes
Commission Types
• Flat Amount: Fixed dollar amount per enrollment or payment.
• Percentage-Based: Percentage of premium or defined base.
• Split Commissions: Shared commissions between multiple agents; however, all split arrangements require a standard primary-agent commission rule to be defined first, and the split is applied only to that primary-agent portion.
• Tier-Based Commissions: Multi-level override structure using Tier Levels.
• Override Commissions: Fixed or percentage-based amounts paid to designated partners, owners, or entities independent of tier-level logic. Overrides are added on top of standard commissions and may include multiple beneficiaries (e.g., two agency partners each receiving a $5 override per commission event).  Overriders are processed prior to any other commission rule. 
• Advances: Upfront commission with chargeback logic.
TierLevel Structure
• Tier -1: Associate (Referral Partner) — entry-level referral commission.
• Tier 0: Agent (Writing Agent) — primary producer earning base commission.
• Tier 1: Agency — override for managing agent downline.
• Tier 2: GA (General Agency) — regional override layer.
• Tier 3: MGA (Master General Agency) — senior regional override tier.
• Tier 4: IMO (Independent Marketing Org) — national distribution tier.
• Tier 5: FMO (Field Marketing Org) — top distribution tier.
• Tier 6+: Enterprise/Carrier — used for platform fees or carrier rev share.
Example Payout Scenario
• Associate (Tier -1): 10%
• Agent (Tier 0): 60%
• Agency (Tier 1): 30%
• Total = 100% and fully supported by existing hierarchy logic.
Commission Rule Behavior
• Writing Agent receives Tier 0 payout; Associate receives Tier -1 payout.
• Agency and other tiers receive override percentages based on TierLevel.
• Splits apply after override calculation.
• Advances generate upfront commission + future earned schedule.
• Chargebacks reverse unearned advanced commissions.
Payment Timing
• Commission payment schedule is 1st and 15th.  Tenants can process their NACHA files as often as they like but Commission Payment on ACH transactions are currently held for 10 days.
• Delayed/Hold: Commission payments are released after 10-day hold.
• Residual: Life of the premium, ongoing commissions.
Validation Rules
• Splits must equal 100%.
• Tier rules cannot conflict with higher-priority rules.
• Expired rules do not apply.
• Chargebacks apply automatically when cancellations occur and refunds are applied and approved.

Processing Rules
• Overrides get processed first
•	All Products Agent specific rules example (Commission is $100)
o	Overrides of (Tom = $5, Cathy = $4, Agency = 2$, MW = $20)
o	Remaining commission = $69
o	Commission Rule (All products 100%)
	Agent receives $69
•	All Product Tier based rule example (Commission is $100)
o	Overrides of (Tom = $5, Cathy = $4, Mike = 2$)
o	Remaining commission = $89
o	Commission Rule (All products Tier 0 = 70%, Tier 1 = 20%, Tier 2 = 10%)
	Agent receives $62.30
	Agency receives $17.80
	GA receives $0
	MGA receives $0
	FMO receives $0
	IMO receives $0
	Enterprise (MW) receives $8.90
• Commission rules process next based on priority
• If there are conflicting priority rules process them in this order until 100% of the commission is allocated.  (If there are conflicting priority rules all commissions for the agent(s) will be put on hold until the conflict is resolved)
• If there are commissions that are not allocated route them to the Tenant Owner (e.g. MightyWELL) 
• If and agent has an assigned all products commission rule the system will always prioritize that rule over all other rules for all sales from that agent.

