  /**
   * Get detailed export data for a specific entity (Agent/Agency)
   * Returns aggregated data for:
   * 1. Summary (Total Revenue, Commission, Payment Count)
   * 2. Payments (Detailed list)
   * 3. Groups (Aggregated by group)
   * 4. Individuals (Aggregated by member)
   * 5. Products (Aggregated by product/tier)
   * 
   * @param {string} entityType - 'Agent' or 'Agency'
   * @param {string} entityId - Entity ID
   * @param {Date} startDate - Start date
   * @param {Date} endDate - End date
   * @param {string} nachaId - Optional NACHA ID filter
   */
  async getExportDetails(entityType, entityId, startDate, endDate, nachaId = null) {
    const pool = await getPool();
    const request = pool.request();
    
    // Set parameters
    request.input('EntityId', sql.UniqueIdentifier, entityId);
    request.input('EntityType', sql.VarChar, entityType);
    
    if (startDate) request.input('StartDate', sql.Date, startDate);
    if (endDate) request.input('EndDate', sql.Date, endDate);
    if (nachaId) request.input('NACHAId', sql.UniqueIdentifier, nachaId);

    // Filter Logic:
    // If NACHAId is provided, filter by that.
    // If not, use date range on oe.Payments (or Commissions created within range).
    // For preview (pre-NACHA), we use date range on payments/commissions that would be eligible.
    // Here we assume we are looking at *payouts*, so we should look at oe.NACHAPaymentDetails if nachaId exists,
    // or calculate based on potential payout if just date range.
    
    // Since this is called from "Preview" or "History", let's handle both.
    // History (NACHAId) is simpler: just query NACHAPaymentDetails + Payments.
    // Preview (Date Range) requires recalculating or querying what *would* be paid.
    // However, the frontend passes preview data derived from `previewPayouts`. 
    // To match that exactly without re-running complex logic, we might need to rely on the fact 
    // that `previewPayouts` already did the heavy lifting. But `previewPayouts` returns aggregated totals.
    // We need granular details here.
    
    // Strategy:
    // 1. If NACHAId provided: Query NACHAPaymentDetails linked to Payments.
    // 2. If Date Range provided: Query Payments within range that *would* be paid to this entity.
    //    For Agents, this means `oe.Commissions` pending for that agent.
    //    For Agencies, `oe.Commissions` pending for that agency.
    
    let baseFilter = '';
    if (nachaId) {
      baseFilter = `
        INNER JOIN oe.NACHAPaymentDetails npd ON p.PaymentId = npd.PaymentId
        WHERE npd.NACHAId = @NACHAId
          AND npd.RecipientEntityType = @EntityType
          AND npd.RecipientEntityId = @EntityId
      `;
    } else {
      // Preview mode - look for pending commissions
      // Note: This logic must match getEligibleCommissions
      // We join to oe.Commissions directly
      baseFilter = `
        INNER JOIN oe.Commissions c ON p.PaymentId = c.PaymentId
        WHERE c.Status = 'Pending'
          AND c.TransactionType IN ('Advance', 'Commission')
          AND (
            (@EntityType = 'Agent' AND c.AgentId = @EntityId)
            OR
            (@EntityType = 'Agency' AND c.AgencyId = @EntityId)
          )
          -- Date range filter on Payment (Revenue) Date or Commission Created Date?
          -- Usually Payouts are based on Payment Date eligibility.
          AND p.PaymentDate >= @StartDate AND p.PaymentDate <= @EndDate
      `;
    }

    // 1. Detailed Payments Query
    const paymentsQuery = `
      SELECT 
        p.PaymentId,
        p.PaymentDate,
        p.Amount as PaymentAmount,
        -- Commission paid/owed to this entity for this payment
        COALESCE(
          (SELECT SUM(Amount) FROM oe.NACHAPaymentDetails WHERE NACHAId = @NACHAId AND PaymentId = p.PaymentId AND RecipientEntityId = @EntityId),
          (SELECT SUM(Amount) FROM oe.Commissions WHERE PaymentId = p.PaymentId AND Status = 'Pending' AND ((@EntityType = 'Agent' AND AgentId = @EntityId) OR (@EntityType = 'Agency' AND AgencyId = @EntityId)))
        ) as CommissionAmount,
        -- Member/Group Info
        u.FirstName + ' ' + u.LastName as MemberName,
        m.MemberId,
        g.Name as GroupName,
        g.GroupId,
        -- Product Info (Primary Product)
        pr.Name as ProductName,
        -- Rule/Commission Type
        cr.RuleName,
        cr.CommissionType,
        m.Tier as MemberTier
      FROM oe.Payments p
      LEFT JOIN oe.Enrollments e ON p.EnrollmentId = e.EnrollmentId
      LEFT JOIN oe.Members m ON e.MemberId = m.MemberId
      LEFT JOIN oe.Users u ON m.UserId = u.UserId
      LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
      LEFT JOIN oe.Products pr ON e.ProductId = pr.ProductId
      LEFT JOIN oe.CommissionRules cr ON e.CommissionRuleId = cr.RuleId -- Approximate rule
      ${baseFilter}
      ORDER BY p.PaymentDate DESC
    `;

    const paymentsResult = await request.query(paymentsQuery);
    const payments = paymentsResult.recordset.map(row => ({
      paymentId: row.PaymentId,
      paymentDate: row.PaymentDate,
      paymentAmount: Number(row.PaymentAmount),
      commissionAmount: Number(row.CommissionAmount),
      memberName: row.MemberName,
      memberId: row.MemberId,
      groupName: row.GroupName,
      groupId: row.GroupId,
      productName: row.ProductName,
      ruleName: row.RuleName,
      commissionType: row.CommissionType,
      memberTier: row.MemberTier
    }));

    // 2. Groups Aggregation
    // Aggregate from the payments list
    const groupsMap = new Map();
    payments.forEach(p => {
      const key = p.groupId || 'INDIVIDUAL';
      const name = p.groupName || 'Individual';
      
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          groupId: key,
          groupName: name,
          householdCount: new Set(), // Set of MemberIds to count unique households/members
          totalPremium: 0,
          totalCommission: 0
        });
      }
      
      const group = groupsMap.get(key);
      group.householdCount.add(p.memberId); // Assuming 1 member = 1 household for simplicity or unique payers
      group.totalPremium += p.paymentAmount;
      group.totalCommission += p.commissionAmount;
    });

    const groups = Array.from(groupsMap.values()).map(g => ({
      ...g,
      householdCount: g.householdCount.size
    }));

    // 3. Individuals Aggregation
    const individualsMap = new Map();
    payments.forEach(p => {
      // Only include if no group (or we can include all, user asked for "Individuals tab similar to groups")
      // Usually "Individuals" implies individual policies, but maybe they want a member-level breakdown regardless of group?
      // Let's do Member Level Breakdown
      const key = p.memberId;
      if (!key) return; 

      if (!individualsMap.has(key)) {
        individualsMap.set(key, {
          memberId: key,
          memberName: p.memberName,
          totalPremium: 0,
          totalCommission: 0
        });
      }
      const ind = individualsMap.get(key);
      ind.totalPremium += p.paymentAmount;
      ind.totalCommission += p.commissionAmount;
    });

    const individuals = Array.from(individualsMap.values());

    // 4. Products Aggregation
    const productsMap = new Map();
    payments.forEach(p => {
      const prodName = p.productName || 'Unknown Product';
      const tier = p.memberTier || 'Standard';
      const key = `${prodName}_${tier}`;

      if (!productsMap.has(key)) {
        productsMap.set(key, {
          productName: prodName,
          tier: tier,
          count: 0,
          totalPremium: 0,
          totalCommission: 0
        });
      }
      const prod = productsMap.get(key);
      prod.count += 1;
      prod.totalPremium += p.paymentAmount;
      prod.totalCommission += p.commissionAmount;
    });

    const products = Array.from(productsMap.values());

    // 5. Summary
    const summary = {
      totalRevenue: payments.reduce((sum, p) => sum + p.paymentAmount, 0),
      totalCommission: payments.reduce((sum, p) => sum + p.commissionAmount, 0),
      paymentCount: payments.length
    };

    return {
      summary,
      payments,
      groups,
      individuals,
      products
    };
  }
