'use strict';

const { shouldSkipIndividualDimeSync } = require('../dimeRecurringSync');

describe('shouldSkipIndividualDimeSync', () => {
  it('skips list-bill households', () => {
    expect(shouldSkipIndividualDimeSync({ billType: 'LB' })).toBe(true);
    expect(shouldSkipIndividualDimeSync({ isListBillBilled: true })).toBe(true);
  });

  it('skips when plan has groupId', () => {
    expect(
      shouldSkipIndividualDimeSync({
        groupId: '11111111-1111-1111-1111-111111111111',
        billType: 'IB'
      })
    ).toBe(true);
  });

  it('does not skip direct individual without group', () => {
    expect(shouldSkipIndividualDimeSync({ billType: 'IB', groupId: null })).toBe(false);
  });
});
