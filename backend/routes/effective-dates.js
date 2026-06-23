// backend/routes/effective-dates.js
const express = require('express');
const sql = require('mssql');
const { getPool } = require('../config/database');
const { getHouseholdCohortByMemberId } = require('../services/householdCohort.service');

const router = express.Router();

// GET /api/effective-dates - Get available effective dates for any scenario
// 
// BUSINESS LOGIC EXPLANATION:
// • If memberId provided: Determine if group or individual enrollment based on member's group
// • Group enrollments: Only 1st of month dates within 90 days, use group's EnrollmentWaitingPeriod
// • Individual enrollments: Any date within 90 days, BUT if ANY product requires 1st of month, restrict to 1st of month only
// • UI: Calendar for flexible dates, dropdown for 1st of month only
// • Default dates: Tomorrow for flexible, next 1st of month for restricted
// • Qualification check: Member must be hired for minimum period before effective date (group only)
// • NO AUTHENTICATION REQUIRED - Used by enrollment links and product changes
router.get('/', async (req, res) => {
  try {
    const { memberId, selectedProducts, pastMonths, futureMonths } = req.query;

    // Modification window: admin tools (e.g., plan-modification wizard) need
    // a wider window than the default new-enrollment view. When either of
    // pastMonths/futureMonths is supplied, qualification gates (initial-enrollment
    // period, hire-date) are bypassed but cohort + AllowMidMonthEffective rules
    // still apply.
    const pastMonthsNum = Number.parseInt(pastMonths, 10);
    const futureMonthsNum = Number.parseInt(futureMonths, 10);
    const isModificationWindow =
      Number.isFinite(pastMonthsNum) && pastMonthsNum >= 0 &&
      Number.isFinite(futureMonthsNum) && futureMonthsNum >= 0 &&
      (pastMonthsNum + futureMonthsNum) > 0;

    console.log('🔍 DEBUG: Unified effective dates request:', { memberId, selectedProducts, pastMonths, futureMonths, isModificationWindow });
    
    const pool = await getPool();
    
    // For Agent-Static links, memberId will be null - treat as individual enrollment
    let member = null;
    let isGroupEnrollment = false;
    
    if (memberId) {
      // 1. Get member information with group and tenant data
      const memberQuery = `
        SELECT 
          m.MemberId,
          m.UserId,
          m.GroupId,
          m.HireDate,
          u.FirstName,
          u.LastName,
          u.Email,
          g.Name AS GroupName,
          g.TenantId,
          g.EnrollmentWaitingPeriod,
          g.MinimumHirePeriod,
          g.IsInInitialEnrollmentPeriod,
          g.InitialEnrollmentPeriodStart,
          g.InitialEnrollmentPeriodEnd,
          g.EarliestEffectiveDate,
          g.AllowMidMonthEffective,
          t.Name AS TenantName
        FROM oe.Members m
        JOIN oe.Users u ON m.UserId = u.UserId
        LEFT JOIN oe.Groups g ON m.GroupId = g.GroupId
        LEFT JOIN oe.Tenants t ON g.TenantId = t.TenantId
        WHERE m.MemberId = @memberId
      `;
      
      const memberRequest = pool.request();
      memberRequest.input('memberId', sql.UniqueIdentifier, memberId);
      
      const memberResult = await memberRequest.query(memberQuery);
      
      if (memberResult.recordset.length === 0) {
        return res.status(404).json({
          success: false,
          message: 'Member not found'
        });
      }
      
      member = memberResult.recordset[0];
      isGroupEnrollment = member.GroupId !== null;
    } else {
      // No memberId - treat as individual enrollment (Agent-Static link)
      console.log('🔍 DEBUG: No memberId provided - treating as individual enrollment (Agent-Static)');
      isGroupEnrollment = false;
    }
    
    // 2. Determine enrollment type and get group settings
    const groupEnrollmentWaitingPeriod = member?.EnrollmentWaitingPeriod;
    const minimumHirePeriod = 0; // TODO: Get from group settings when available
    
    // Check if group is in initial enrollment period
    const isInEnrollmentPeriod = isGroupEnrollment && 
                                 member?.IsInInitialEnrollmentPeriod && 
                                 member?.InitialEnrollmentPeriodEnd;
    const enrollmentPeriodEnd = member?.InitialEnrollmentPeriodEnd ? new Date(member.InitialEnrollmentPeriodEnd) : null;
    
    console.log('🔍 DEBUG: Member details:', {
      memberId: member?.MemberId || 'N/A (Agent-Static)',
      groupId: member?.GroupId || null,
      isGroupEnrollment,
      groupEnrollmentWaitingPeriod,
      minimumHirePeriod,
      memberHireDate: member?.HireDate || 'N/A',
      isInEnrollmentPeriod,
      enrollmentPeriodEnd: enrollmentPeriodEnd ? enrollmentPeriodEnd.toISOString().split('T')[0] : 'N/A'
    });
    
    // 3. Calculate effective date rules (hire date is optional)
    // Use noon (12:00 PM) as reference time to avoid timezone edge cases
    const today = new Date();
    const todayNoon = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
    const memberHireDate = member?.HireDate ? new Date(member.HireDate) : null;
    
    let effectiveDateOptions = {
      type: 'dropdown', // default
      fixedDate: null,
      availableDates: [],
      dateRange: null,
      restrictions: {
        mustBeFirstOfMonth: false,
        maxDaysInFuture: 90
      }
    };
    
    let memberQualified = true;
    let qualificationMessage = '';
    
    // 5. Determine effective date rules based on enrollment type
    if (isGroupEnrollment && isModificationWindow) {
      // Admin modification window — fixed past/future month range, no qualification gates.
      memberQualified = true;

      const householdCohort = member?.MemberId
        ? await getHouseholdCohortByMemberId(pool, member.MemberId)
        : null;
      let allowedDays;
      if (householdCohort === 'FIRST') {
        allowedDays = [1];
      } else if (householdCohort === 'FIFTEENTH') {
        allowedDays = [15];
      } else {
        const allowMidMonth = member?.AllowMidMonthEffective === true || member?.AllowMidMonthEffective === 1;
        allowedDays = allowMidMonth ? [1, 15] : [1];
      }

      qualificationMessage = allowedDays.length === 1 && allowedDays[0] === 15
        ? 'This household is locked to the 15th cohort; pick from the available 15th-of-month dates.'
        : allowedDays.length === 1
          ? 'You can choose from the available first-of-month dates.'
          : 'You can choose any 1st or 15th of month within the window.';

      const startMonth = new Date(todayNoon.getFullYear(), todayNoon.getMonth() - pastMonthsNum, 1, 12, 0, 0, 0);
      const endMonth = new Date(todayNoon.getFullYear(), todayNoon.getMonth() + futureMonthsNum, 1, 12, 0, 0, 0);

      const availableDates = [];
      const cursor = new Date(startMonth);
      while (cursor <= endMonth) {
        for (const day of allowedDays) {
          const candidate = new Date(cursor.getFullYear(), cursor.getMonth(), day, 12, 0, 0, 0);
          // Only emit dates within the [start, endMonth-end] window. End is inclusive
          // through last allowedDay of futureMonthsNum-th month.
          if (candidate >= startMonth && candidate <= new Date(endMonth.getFullYear(), endMonth.getMonth() + 1, 0, 12, 0, 0, 0)) {
            availableDates.push(candidate.toISOString().split('T')[0]);
          }
        }
        cursor.setMonth(cursor.getMonth() + 1);
      }
      availableDates.sort();

      effectiveDateOptions = {
        type: 'dropdown',
        fixedDate: null,
        availableDates,
        dateRange: null,
        restrictions: {
          allowedDays,
          mustBeFirstOfMonth: allowedDays.length === 1 && allowedDays[0] === 1,
          householdCohort,
          windowMonthsPast: pastMonthsNum,
          windowMonthsFuture: futureMonthsNum
        }
      };

      return res.json({
        success: true,
        data: {
          enrollmentType: 'Group',
          memberQualified,
          qualificationMessage,
          effectiveDateOptions
        },
        message: 'Effective dates retrieved successfully'
      });
    }

    if (isGroupEnrollment) {
      // Group enrollment: Always 1st of month, use group's earliest date
      memberQualified = true;
      qualificationMessage = 'You can choose from the available first-of-month dates for your benefits to start.';
      
      let earliestDate, latestDate;
      
      // If group is in initial enrollment period, effective date must be AFTER the period ends
      if (isInEnrollmentPeriod && enrollmentPeriodEnd) {
        // Use group's EarliestEffectiveDate if set, otherwise calculate 1st of month AFTER enrollment period ends
        if (member?.EarliestEffectiveDate) {
          const groupEarliestDate = new Date(member.EarliestEffectiveDate);
          earliestDate = new Date(groupEarliestDate.getFullYear(), groupEarliestDate.getMonth(), groupEarliestDate.getDate(), 12, 0, 0, 0);
          
          console.log('🔍 DEBUG: Group in initial enrollment period - using group EarliestEffectiveDate:', {
            enrollmentPeriodEnd: enrollmentPeriodEnd.toISOString().split('T')[0],
            groupEarliestEffectiveDate: member.EarliestEffectiveDate,
            earliestEffectiveDate: earliestDate.toISOString().split('T')[0]
          });
        } else {
          // Calculate 1st of month AFTER enrollment period ends (fallback)
          const periodEndNoon = new Date(enrollmentPeriodEnd.getFullYear(), enrollmentPeriodEnd.getMonth(), enrollmentPeriodEnd.getDate(), 12, 0, 0, 0);
          // Set to 1st of the next month after period ends
          earliestDate = new Date(periodEndNoon.getFullYear(), periodEndNoon.getMonth() + 1, 1, 12, 0, 0, 0);
          
          console.log('🔍 DEBUG: Group in initial enrollment period - calculating default (no EarliestEffectiveDate set):', {
            enrollmentPeriodEnd: enrollmentPeriodEnd.toISOString().split('T')[0],
            earliestEffectiveDate: earliestDate.toISOString().split('T')[0]
          });
        }
      } else {
        // Use group's EnrollmentWaitingPeriod if set, otherwise start from 1st of current/next month
        if (groupEnrollmentWaitingPeriod && groupEnrollmentWaitingPeriod > 0) {
          // Start from 1st of current month, or next month if we're past the 1st (using noon approach)
          earliestDate = new Date(todayNoon.getFullYear(), todayNoon.getMonth(), 1, 12, 0, 0, 0);
          if (earliestDate <= todayNoon) {
            earliestDate = new Date(todayNoon.getFullYear(), todayNoon.getMonth() + 1, 1, 12, 0, 0, 0);
          }
          
          // Add waiting period days to the calculated earliest date
          const waitingPeriodDate = new Date(earliestDate);
          waitingPeriodDate.setDate(waitingPeriodDate.getDate() + groupEnrollmentWaitingPeriod);
          earliestDate = waitingPeriodDate;
          
          console.log('🔍 DEBUG: Using group EnrollmentWaitingPeriod:', {
            waitingPeriodDays: groupEnrollmentWaitingPeriod,
            calculatedDate: earliestDate.toISOString().split('T')[0]
          });
        } else {
          // Start from 1st of current month. If that day has already passed
          // (or is today), advance earliestDate to tomorrow rather than
          // jumping to the next month's 1st — this keeps any remaining
          // cohort dates in the current month (e.g., the 15th when today
          // is the 1st) eligible. The per-candidate filter below still
          // excludes any specific day-of-month that lies on or before today.
          earliestDate = new Date(todayNoon.getFullYear(), todayNoon.getMonth(), 1, 12, 0, 0, 0);
          if (earliestDate <= todayNoon) {
            earliestDate = new Date(todayNoon);
            earliestDate.setDate(earliestDate.getDate() + 1);
          }
          console.log('🔍 DEBUG: No group EnrollmentWaitingPeriod set, using calculated earliest date:', earliestDate.toISOString().split('T')[0]);
        }
      }
      
      // End 90 days from today
      latestDate = new Date(today);
      latestDate.setDate(latestDate.getDate() + 90);
      
      // Determine which cohort day(s) to generate.
      //
      // Priority:
      //   1. Household cohort lock — if the member's household already has
      //      active enrollments, every new enrollment must match that cohort
      //      so the family stays single-cohort with one bill per period.
      //   2. Group flag — if no household cohort yet, allow 1st (and 15th
      //      when AllowMidMonthEffective is on) per group setting.
      let allowedDays;
      const householdCohort = member?.MemberId
        ? await getHouseholdCohortByMemberId(pool, member.MemberId)
        : null;
      if (householdCohort === 'FIRST') {
        allowedDays = [1];
      } else if (householdCohort === 'FIFTEENTH') {
        allowedDays = [15];
      } else {
        const allowMidMonth = member?.AllowMidMonthEffective === true || member?.AllowMidMonthEffective === 1;
        allowedDays = allowMidMonth ? [1, 15] : [1];
      }

      // Generate cohort-day dates using noon approach.
      // Anchor the month iterator at the 1st of earliestDate's month (not
      // earliestDate's actual day) so we don't accidentally skip over the
      // last month's 1st when earliestDate is mid-month — e.g., when the
      // bump above set earliestDate to "today+1".
      const availableDates = [];
      const currentDate = new Date(earliestDate.getFullYear(), earliestDate.getMonth(), 1, 12, 0, 0, 0);
      while (currentDate <= latestDate) {
        for (const day of allowedDays) {
          const candidate = new Date(currentDate.getFullYear(), currentDate.getMonth(), day, 12, 0, 0, 0);
          if (candidate >= earliestDate && candidate <= latestDate) {
            // CRITICAL: If group is in enrollment period, ensure date is AFTER period ends
            if (isInEnrollmentPeriod && enrollmentPeriodEnd) {
              const periodEndNoon = new Date(enrollmentPeriodEnd.getFullYear(), enrollmentPeriodEnd.getMonth(), enrollmentPeriodEnd.getDate(), 12, 0, 0, 0);
              // Only include dates that are AFTER the enrollment period ends
              if (candidate <= periodEndNoon) {
                continue;
              }
            }

            // Check if member qualifies for this date (hire period validation)
            if (memberHireDate) {
              const daysBetween = Math.floor((candidate.getTime() - memberHireDate.getTime()) / (1000 * 60 * 60 * 24));
              if (daysBetween >= minimumHirePeriod) {
                availableDates.push(candidate.toISOString().split('T')[0]);
              }
            } else {
              availableDates.push(candidate.toISOString().split('T')[0]);
            }
          }
        }
        currentDate.setMonth(currentDate.getMonth() + 1);
      }
      availableDates.sort();

      effectiveDateOptions = {
        type: 'dropdown',
        fixedDate: null,
        availableDates: availableDates,
        dateRange: null,
        restrictions: {
          allowedDays: allowedDays,
          // Backward-compat alias: true only when 1st-of-month is the only allowed day
          mustBeFirstOfMonth: allowedDays.length === 1 && allowedDays[0] === 1,
          maxDaysInFuture: 90
        }
      };
      
    } else {
      // Individual enrollment: Check product rules for 1st of month requirement.
      memberQualified = true;
      qualificationMessage = 'You can choose any date within the next 90 days for your benefits to start.';

      // Check if any SELECTED products require first of month effective dates.
      let requiresFirstOfMonth = false;
      let selectedProductIds = [];

      if (selectedProducts && selectedProducts.trim().length > 0) {
        selectedProductIds = selectedProducts.split(',').filter((id) => id.trim());
      }

      // For modification windows on individuals, the wizard often hasn't picked
      // products yet — derive from the member's currently-active enrollments so
      // FirstOfMonth detection still works for plan-mod scenarios. Mirrors the
      // group-modification path's intent (use what we know about the household).
      if (
        isModificationWindow &&
        member?.MemberId &&
        selectedProductIds.length === 0
      ) {
        try {
          const activeEnrReq = pool.request();
          activeEnrReq.input('memberId', sql.UniqueIdentifier, member.MemberId);
          const activeEnrRes = await activeEnrReq.query(`
            SELECT DISTINCT e.ProductId, e.ProductBundleID
            FROM oe.Enrollments e
            WHERE e.MemberId = @memberId
              AND e.Status = 'Active'
              AND (e.EnrollmentType = 'Product' OR e.EnrollmentType IS NULL)
              AND e.ProductId IS NOT NULL
              AND e.ProductId <> '00000000-0000-0000-0000-000000000000'
          `);
          const ids = new Set();
          for (const r of activeEnrRes.recordset) {
            if (r.ProductId) ids.add(r.ProductId);
            if (r.ProductBundleID) ids.add(r.ProductBundleID);
          }
          selectedProductIds = Array.from(ids);
          console.log('🔍 DEBUG: Auto-derived selectedProducts from active enrollments:', selectedProductIds);
        } catch (e) {
          console.warn('⚠️ Failed to auto-derive selectedProducts for individual modification window:', e.message);
        }
      }

      if (selectedProductIds.length === 0) {
        console.log('🔍 DEBUG: No products selected yet, defaulting to calendar picker');
        requiresFirstOfMonth = false;
      } else {
        try {
          const productIdsStr = selectedProductIds.map((id) => `'${String(id).trim()}'`).join(',');
          const productRulesQuery = `
            -- Non-bundle selected products only (bundle EffectiveDateLogic is ignored)
            SELECT ProductId, Name, EffectiveDateLogic
            FROM oe.Products
            WHERE ProductId IN (${productIdsStr})
              AND Status = 'Active'
              AND ISNULL(IsBundle, 0) = 0

            UNION ALL

            -- Included products within selected bundles determine bundle effective-date rules
            SELECT p.ProductId, p.Name, p.EffectiveDateLogic
            FROM oe.ProductBundles pb
            INNER JOIN oe.Products p ON pb.IncludedProductId = p.ProductId
            WHERE pb.BundleProductId IN (${productIdsStr})
              AND p.Status = 'Active'
          `;
          const productRulesRequest = pool.request();
          const productRulesResult = await productRulesRequest.query(productRulesQuery);
          requiresFirstOfMonth = productRulesResult.recordset.some(
            (product) => product.EffectiveDateLogic === 'FirstOfMonth'
          );
          console.log('🔍 DEBUG: Requires first of month:', requiresFirstOfMonth);
        } catch (error) {
          console.warn('⚠️ Error checking product effective date rules:', error.message);
          requiresFirstOfMonth = false;
        }
      }

      // Modification window for individuals: span [today - pastMonths, today + futureMonths].
      // Mirrors the group modification-window branch's window math but doesn't apply cohort
      // (individuals have no group cohort). Bypasses qualification gates same as group path.
      if (isModificationWindow) {
        const startMonth = new Date(todayNoon.getFullYear(), todayNoon.getMonth() - pastMonthsNum, 1, 12, 0, 0, 0);
        const endMonth = new Date(todayNoon.getFullYear(), todayNoon.getMonth() + futureMonthsNum, 1, 12, 0, 0, 0);
        // Inclusive end-of-month for the future-months bound.
        const windowEnd = new Date(endMonth.getFullYear(), endMonth.getMonth() + 1, 0, 12, 0, 0, 0);

        if (requiresFirstOfMonth) {
          const availableDates = [];
          const cursor = new Date(startMonth);
          while (cursor <= windowEnd) {
            availableDates.push(cursor.toISOString().split('T')[0]);
            cursor.setMonth(cursor.getMonth() + 1);
          }
          effectiveDateOptions = {
            type: 'dropdown',
            fixedDate: null,
            availableDates,
            dateRange: null,
            restrictions: {
              mustBeFirstOfMonth: true,
              allowedDays: [1],
              windowMonthsPast: pastMonthsNum,
              windowMonthsFuture: futureMonthsNum
            }
          };
          qualificationMessage = 'You can choose from the available first-of-month dates within the modification window.';
        } else {
          effectiveDateOptions = {
            type: 'calendar',
            fixedDate: null,
            availableDates: null,
            dateRange: {
              earliest: startMonth.toISOString().split('T')[0],
              latest: windowEnd.toISOString().split('T')[0]
            },
            restrictions: {
              mustBeFirstOfMonth: false,
              windowMonthsPast: pastMonthsNum,
              windowMonthsFuture: futureMonthsNum
            }
          };
          qualificationMessage = 'You can choose any date within the modification window.';
        }
      } else if (requiresFirstOfMonth) {
        // Default new-enrollment view: next 90 days, 1st-of-month only.
        const availableDates = [];
        const endDate = new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000);
        let currentDate = new Date(todayNoon.getFullYear(), todayNoon.getMonth(), 1, 12, 0, 0, 0);
        if (currentDate <= todayNoon) {
          currentDate = new Date(todayNoon.getFullYear(), todayNoon.getMonth() + 1, 1, 12, 0, 0, 0);
        }
        while (currentDate <= endDate) {
          availableDates.push(currentDate.toISOString().split('T')[0]);
          currentDate = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 1, 12, 0, 0, 0);
        }
        effectiveDateOptions = {
          type: 'dropdown',
          fixedDate: null,
          availableDates: availableDates,
          dateRange: null,
          restrictions: {
            mustBeFirstOfMonth: true,
            maxDaysInFuture: 90
          }
        };
        qualificationMessage = 'You can choose from the available first-of-month dates for your benefits to start.';
      } else {
        // Default new-enrollment view: tomorrow → +90d, any day.
        const tomorrow = new Date(todayNoon);
        tomorrow.setDate(tomorrow.getDate() + 1);
        effectiveDateOptions = {
          type: 'calendar',
          fixedDate: null,
          availableDates: null,
          dateRange: {
            earliest: tomorrow.toISOString().split('T')[0],
            latest: new Date(today.getTime() + 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
          },
          restrictions: {
            mustBeFirstOfMonth: false,
            maxDaysInFuture: 90
          }
        };
      }
    }
    
    console.log('🔍 DEBUG: Effective date options:', effectiveDateOptions);
    
    res.json({
      success: true,
      data: {
        enrollmentType: isGroupEnrollment ? 'Group' : 'Individual',
        memberQualified: memberQualified,
        qualificationMessage: qualificationMessage,
        effectiveDateOptions: effectiveDateOptions
      },
      message: 'Effective dates retrieved successfully'
    });
    
  } catch (error) {
    console.error('❌ Error fetching effective dates:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching effective dates'
    });
  }
});

module.exports = router;
