'use strict';

const { parseUserGetAllResponse } = require('../e123XmlParser');

describe('e123XmlParser', () => {
  test('parses sample user.getall XML', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<method request="user.getall">
  <users total="1">
    <user>
      <firstname>Steve</firstname>
      <lastname>Jaeger</lastname>
      <memberid>655077998</memberid>
      <userid>156522</userid>
      <brokerid>21478</brokerid>
    </user>
  </users>
</method>`;
    const parsed = parseUserGetAllResponse(xml);
    expect(parsed.authFailed).toBe(false);
    expect(parsed.usersTotal).toBe(1);
    expect(parsed.users[0].memberid).toBe('655077998');
  });

  test('parses transactions with nested transactionpayments', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<method request="user.getall">
  <users total="1">
    <user><userid>100</userid></user>
  </users>
  <transactions total="1">
    <transaction>
      <transid>1</transid>
      <userid>100</userid>
      <paytype>CC</paytype>
      <transactionpayments total="1">
        <transactionpayment>
          <ccnum>4111111111111111</ccnum>
          <cclast4>1111</cclast4>
          <paytype>CC</paytype>
        </transactionpayment>
      </transactionpayments>
    </transaction>
  </transactions>
</method>`;
    const parsed = parseUserGetAllResponse(xml);
    expect(parsed.transactions).toHaveLength(1);
    expect(parsed.transactions[0].transactionpayments[0].ccnum).toBe('4111111111111111');
  });

  test('treats blank response as auth failure', () => {
    const parsed = parseUserGetAllResponse('');
    expect(parsed.authFailed).toBe(true);
  });
});
