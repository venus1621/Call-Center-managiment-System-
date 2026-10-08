const { adminOnly } = require('../middleware/auth');
const { findUser, findAccounts } = require('./admin');
const { hoursReport, renderReport, accountDetail, renderAccountDetail } = require('../services/report');
const { parseRange } = require('../utils/time');

const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const args = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);
const RANGE_HELP = 'Range: today | yesterday | week | month | 2026-10-01 2026-10-07';

function register(bot) {
  // /hours <@name|all> [range]
  bot.command('hours', adminOnly, async (ctx) => {
    const [target, ...rest] = args(ctx);
    if (!target) return ctx.reply(`Usage: /hours <@name|all> [range]\n${RANGE_HELP}`);
    const range = parseRange(rest);
    if (!range) return ctx.reply(`Invalid date range.\n${RANGE_HELP}`);

    let id = null;
    let title = 'Hours – whole team';
    if (target.toLowerCase() !== 'all') {
      const u = await findUser(target);
      if (!u) return ctx.reply('User not found. See /users.');
      id = u._id;
      title = `Hours – ${u.name}`;
    }
    const rows = await hoursReport(range.from, range.to, { by: 'user', id });
    return ctx.reply(renderReport(title, range.label, rows), html());
  });

  // /accounthours <account|all> [range]
  bot.command('accounthours', adminOnly, async (ctx) => {
    const [target, ...rest] = args(ctx);
    if (!target) return ctx.reply(`Usage: /accounthours <account|all> [range]\n${RANGE_HELP}`);
    const range = parseRange(rest);
    if (!range) return ctx.reply(`Invalid date range.\n${RANGE_HELP}`);

    let id = null;
    let title = 'Hours – all accounts';
    if (target.toLowerCase() !== 'all') {
      const [acc] = await findAccounts(target);
      if (!acc) return ctx.reply('Account not found. See /accounts.');
      id = acc._id;
      title = `Hours – account ${acc.name}`;
    }
    const rows = await hoursReport(range.from, range.to, { by: 'account', id });
    return ctx.reply(renderReport(title, range.label, rows), html());
  });

  // /accountreport <account> [range]  – full report of one account
  bot.command('accountreport', adminOnly, async (ctx) => {
    const [target, ...rest] = args(ctx);
    if (!target) return ctx.reply(`Usage: /accountreport <account> [range]\n${RANGE_HELP}`);
    const range = parseRange(rest.length ? rest : ['week']);
    if (!range) return ctx.reply(`Invalid date range.\n${RANGE_HELP}`);
    const [acc] = await findAccounts(target);
    if (!acc) return ctx.reply('Account not found. See /accounts.');
    return ctx.reply(renderAccountDetail(await accountDetail(acc._id, range), range.label), html());
  });
}

module.exports = { register };
