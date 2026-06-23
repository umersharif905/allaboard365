'use strict';

const axios = require('axios');
const { assertMemberSearchConfigured } = require('./e123Config');
const { parseUserGetAllResponse } = require('./e123XmlParser');

/** E123 user.getall pages can be large (dependents + products + transactions). */
const E123_HTTP_TIMEOUT_MS = 10 * 60 * 1000;

function buildSearchParams(filters = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filters)) {
    if (value !== undefined && value !== null && value !== '') {
      params.set(key, String(value));
    }
  }
  return params;
}

async function userGetAllPage(filters = {}, { lightweight = false } = {}) {
  const cfg = assertMemberSearchConfigured();
  const defaults = lightweight
    ? { USER_IS_LEAD: 0, RETURN_DEPENDENTS: 0, RETURN_PRODUCTS: 0, RETURN_TRANSACTIONS: 0 }
    : { USER_IS_LEAD: 0, RETURN_DEPENDENTS: 1, RETURN_PRODUCTS: 1, RETURN_TRANSACTIONS: 1 };
  const body = buildSearchParams({
    CORPID: cfg.corpid,
    USERNAME: cfg.username,
    PASSWORD: cfg.password,
    ...defaults,
    ...filters
  });

  const response = await axios.post(cfg.url, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    responseType: 'text',
    timeout: E123_HTTP_TIMEOUT_MS,
    validateStatus: (status) => status >= 200 && status < 500
  });

  const xml = response.data || '';
  if (!String(xml).trim()) {
    const err = new Error('E123 authentication failed or returned empty response');
    err.code = 'E123_AUTH_FAILED';
    throw err;
  }

  const parsed = parseUserGetAllResponse(xml);
  if (parsed.authFailed) {
    const err = new Error('E123 authentication failed or returned empty response');
    err.code = 'E123_AUTH_FAILED';
    throw err;
  }
  return parsed;
}

async function fetchAllUsersForBroker({ brokerId, includeDownline = true, onPage, logPrefix = '', lightweight = false }) {
  const filters = {
    BROKERID: brokerId,
    ...(includeDownline ? { SHOW_TREE: 1 } : {})
  };

  const allUsers = [];
  const allDependents = [];
  const allProducts = [];
  const allTransactions = [];
  let nextUser;
  let pagesCompleted = 0;
  const fetchStartedAt = Date.now();
  const tag = logPrefix || `[e123-fetch broker=${brokerId}]`;

  console.log(`${tag} starting (SHOW_TREE=${includeDownline ? 1 : 0})`);

  while (true) {
    const pageFilters = { ...filters };
    if (nextUser) pageFilters.NEXT_USER = nextUser;

    const pageNum = pagesCompleted + 1;
    const pageStartedAt = Date.now();
    console.log(`${tag} page ${pageNum} requesting${nextUser ? ` NEXT_USER=${nextUser}` : ''}${lightweight ? ' (lightweight)' : ''}…`);

    const page = await userGetAllPage(pageFilters, { lightweight });
    pagesCompleted += 1;
    const pageMs = Date.now() - pageStartedAt;

    allUsers.push(...page.users);
    allDependents.push(...page.dependents);
    allProducts.push(...page.products);
    allTransactions.push(...page.transactions);

    console.log(
      `${tag} page ${pagesCompleted} done in ${pageMs}ms — +${page.users.length} users`
      + ` (${allUsers.length} cumulative, ${allDependents.length} dependents)`
    );

    if (typeof onPage === 'function') {
      await onPage({
        pagesCompleted,
        usersOnPage: page.users.length,
        membersLoaded: allUsers.length,
        usersTotal: page.usersTotal,
        lastUserId: page.users.length ? Number(page.users[page.users.length - 1].userid) : nextUser,
        pageMs
      });
    }

    if (page.usersTotal === 0 || page.users.length === 0) {
      break;
    }

    const lastUser = page.users[page.users.length - 1];
    const lastUserId = Number(lastUser?.userid);
    if (!lastUserId || lastUserId === nextUser) {
      break;
    }
    nextUser = lastUserId;
  }

  const totalMs = Date.now() - fetchStartedAt;
  console.log(
    `${tag} complete in ${totalMs}ms — ${pagesCompleted} page(s), ${allUsers.length} users,`
    + ` ${allDependents.length} dependents, ${allProducts.length} product rows`
  );

  return {
    users: allUsers,
    dependents: allDependents,
    products: allProducts,
    transactions: allTransactions,
    pagesCompleted,
    membersLoaded: allUsers.length
  };
}

module.exports = {
  userGetAllPage,
  fetchAllUsersForBroker
};
