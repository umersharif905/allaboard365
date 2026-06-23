/**
 * Single place for password hashing so login (bcryptjs.compare) and all writers stay aligned.
 */
const bcrypt = require('bcryptjs');

const SALT_ROUNDS = 12;

async function hashPassword(plainText) {
  return bcrypt.hash(plainText, SALT_ROUNDS);
}

module.exports = {
  SALT_ROUNDS,
  hashPassword,
  comparePassword: (plainText, hash) => bcrypt.compare(plainText, hash),
};
