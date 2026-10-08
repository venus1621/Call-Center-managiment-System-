const config = require('../config');
const { decrypt } = require('./crypto');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The account block shown to the agent who reserved it. */
function accountInfo(acc) {
  let t = `🔑 Account: <b>${esc(acc.name)}</b>`;
  if (acc.username) t += `\nLogin: <code>${esc(acc.username)}</code>`;
  if (config.showPassword && acc.passwordEnc) {
    try { t += `\nPassword: <code>${esc(decrypt(acc.passwordEnc))}</code>`; } catch (e) { /* wrong key */ }
  }
  return t;
}

module.exports = { esc, escapeRegex, accountInfo };
