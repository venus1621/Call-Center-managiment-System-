const User = require('../models/User');
const Account = require('../models/Account');
const Slot = require('../models/Slot');
const Booking = require('../models/Booking');
const config = require('../config');
const Session = require('../models/Session');
const { adminOnly } = require('../middleware/auth');
const { encrypt } = require('../utils/crypto');
const { esc, escapeRegex } = require('../utils/format');
const { scheduleText } = require('../services/schedule');
const { reserveSlots, ReservationError } = require('../services/reservations');
const notify = require('../services/notify');
const { disableDefaultSlots, ensureDefaultSlots } = require('../services/defaultSlots');
const { DAY, parseDateTime, parseSlotTime, fmtTime, fmtDate, fmtDateTime, todayStr, fmtHm } = require('../utils/time');

const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const args = (ctx) => ctx.message.text.trim().split(/\s+/).slice(1);

async function findUser(arg) {
  if (!arg) return null;
  if (/^\d+$/.test(arg)) return User.findOne({ telegramId: Number(arg), registrationStatus: { $nin: ['pending', 'rejected'] } });
  const q = escapeRegex(arg.replace(/^@/, ''));
  return User.findOne({ registrationStatus: { $nin: ['pending', 'rejected'] }, $or: [{ username: new RegExp(`^${q}$`, 'i') }, { name: new RegExp(`^${q}$`, 'i') }] });
}

async function findAccounts(arg) {
  if (!arg || arg.toLowerCase() === 'all') return Account.find({ active: true }).sort({ name: 1 });
  const acc = await Account.findOne({ name: new RegExp(`^${escapeRegex(arg)}$`, 'i') });
  return acc ? [acc] : [];
}

const ADMIN_HELP =
  `<b>Supervisor commands</b>\n\n` +
  `<b>Team</b>\n/requests – approve or reject join requests\n/adduser &lt;telegramId&gt; &lt;name&gt; [admin|agent]\n/users\n/removeuser &lt;@username|id&gt;\n\n` +
  `<b>Accounts</b>\n/addaccount &lt;name&gt; &lt;login&gt; [password]\n/setcodes &lt;account&gt; &lt;code&gt; [code…|none] – agent codes, one per seat\n/assign &lt;agent&gt; [agent] &lt;date&gt; &lt;time&gt; [account] – book agents into a slot\n/accounts – list &amp; who is using each now\n/idle – accounts with no active session\n\n` +
  `<b>Slots</b>\n/addslots &lt;date&gt; &lt;from&gt; &lt;to&gt; &lt;account|all&gt; [minutes=60] [users=1|2]\n   e.g. /addslots 2026-10-08 2:00day 4:00night all 60 2\n   Ethiopian clock: add day or night (no spaces). Standard 24-hour times also work.\n/delslots &lt;date&gt; &lt;account|all&gt; – remove slots with no reservations\n/schedule [date] – who is booked when\n\n` +
  `<b>Reports</b>\n/accountreport &lt;account&gt; [range] – full report of one account\n/hours &lt;@name|all&gt; [range]\n/accounthours &lt;account|all&gt; [range]\n   range: today | yesterday | week | month | 2026-10-01 2026-10-07\n\n` +
  `<b>Messages</b>\n/msg &lt;@username|id|all&gt; &lt;text&gt; – send a direct message (you confirm first)\n/messages – history with delivered / confirmed counts\n/templates – ready-made messages · /addtemplate Title | text\n\n` +
  `/panel – button menu for all of this`;

function register(bot) {
  // ---- users ----
  bot.command('adduser', adminOnly, async (ctx) => {
    const a = args(ctx);
    const id = Number(a[0]);
    if (!Number.isInteger(id) || a.length < 2) return ctx.reply('Usage: /adduser <telegramId> <name> [admin|agent]');
    let role = 'agent';
    if (['admin', 'agent'].includes(a[a.length - 1].toLowerCase()) && a.length > 2) role = a.pop().toLowerCase();
    const name = a.slice(1).join(' ');
    await User.findOneAndUpdate({ telegramId: id }, { name, role, active: true, registrationStatus: 'approved', reviewedBy: ctx.state.user._id, reviewedAt: new Date() }, { upsert: true, new: true, setDefaultsOnInsert: true });
    return ctx.reply(`✅ ${esc(name)} (${id}) added as ${role}.`, html());
  });

  bot.command('users', adminOnly, async (ctx) => {
    const users = await User.find({ registrationStatus: { $nin: ['pending', 'rejected'] } }).sort({ name: 1 });
    if (!users.length) return ctx.reply('No users yet.');
    return ctx.reply(
      '👥 <b>Team</b>\n' + users.map((u) => `${u.active ? '•' : '✖'} ${esc(u.name)}${u.username ? ' @' + esc(u.username) : ''} — ${u.role} — <code>${u.telegramId}</code>`).join('\n'),
      html()
    );
  });

  bot.command('removeuser', adminOnly, async (ctx) => {
    const u = await findUser(args(ctx)[0]);
    if (!u) return ctx.reply('User not found. Usage: /removeuser <@username|telegramId>');
    u.active = false;
    await u.save();
    return ctx.reply(`✅ ${esc(u.name)} deactivated. Their past data is kept for reports.`, html());
  });

  // ---- accounts ----
  bot.command('addaccount', adminOnly, async (ctx) => {
    const [name, login, password] = args(ctx);
    if (!name) return ctx.reply('Usage: /addaccount <name> <login> [password]\nRun again with the same name to update it.');
    const set = { name, active: true };
    if (login) set.username = login;
    if (password) set.passwordEnc = encrypt(password);
    await Account.findOneAndUpdate({ name }, set, { upsert: true, new: true, setDefaultsOnInsert: true });
    await ensureDefaultSlots(todayStr());
    if (password) { try { await ctx.deleteMessage(); } catch (e) { /* can't delete */ } }
    return ctx.reply(`✅ Account <b>${esc(name)}</b> saved${password ? ' (password stored encrypted, your message was deleted)' : ''}.`, html());
  });

  // /setcodes CC-01 agent/1567 agent/1568 - codes are handed out one per seat of a slot
  bot.command('setcodes', adminOnly, async (ctx) => {
    const [name, ...codes] = args(ctx);
    if (!name || !codes.length) return ctx.reply('Usage: /setcodes <account> <code> [code…]\nExample: /setcodes CC-01 agent/1567 agent/1568\nUse "none" to remove all codes.');
    const acc = await Account.findOne({ name: new RegExp('^' + escapeRegex(name) + '$', 'i') });
    if (!acc) return ctx.reply('Account not found. See /accounts.');
    const list = codes.length === 1 && codes[0].toLowerCase() === 'none' ? [] : [...new Set(codes)];
    await Account.updateOne({ _id: acc._id }, { agentCodes: list });
    return ctx.reply(list.length ? `✅ <b>${esc(acc.name)}</b> agent codes: ${list.map(esc).join(', ')}` : `✅ Agent codes removed from <b>${esc(acc.name)}</b>.`, html());
  });

  // /assign <agent> [agent] <date> <time> [account] - the supervisor books agents without them pressing Reserve
  bot.command('assign', adminOnly, async (ctx) => {
    const a = args(ctx);
    const usage = 'Usage: /assign <agent> [agent] <date> <time> [account]\nExample: /assign 1567 1568 2026-10-11 08:00\nAgents: Telegram ID, @username or name. Time: 24-hour or Ethiopian (2:00day).';
    const dateIdx = a.findIndex((x) => /^\d{4}-\d{2}-\d{2}$/.test(x));
    if (dateIdx < 1 || dateIdx > 2 || !a[dateIdx + 1]) return ctx.reply(usage);
    const date = a[dateIdx];
    const start = parseSlotTime(date, a[dateIdx + 1]);
    if (!start) return ctx.reply(usage);
    const agents = [];
    for (const token of a.slice(0, dateIdx)) {
      const u = await findUser(token);
      if (!u) return ctx.reply(`❓ Agent not found: ${esc(token)}. See /users.`, html());
      if (!agents.some((x) => String(x._id) === String(u._id))) agents.push(u);
    }
    const filter = { start };
    if (a[dateIdx + 2]) {
      const acc = await Account.findOne({ name: new RegExp('^' + escapeRegex(a[dateIdx + 2]) + '$', 'i'), active: true });
      if (!acc) return ctx.reply('Account not found. See /accounts.');
      filter.account = acc._id;
    }
    await ensureDefaultSlots(date);
    const slots = await Slot.find(filter).populate('account');
    const slot = slots
      .filter((x) => x.account?.active)
      .sort((x, y) => x.account.name.localeCompare(y.account.name))
      .find((x) => x.bookedCount + agents.length <= config.maxCapacity);
    if (!slot) return ctx.reply(`No slot with room for ${agents.length} agent(s) at ${date} ${a[dateIdx + 1]}. See /schedule ${date}.`);
    if (slot.capacity < slot.bookedCount + agents.length) await Slot.updateOne({ _id: slot._id }, { capacity: slot.bookedCount + agents.length });

    const lines = [];
    for (const agent of agents) {
      try {
        const booked = await reserveSlots(agent, [String(slot._id)], { skipNotice: true });
        const code = booked.agentCodes?.[String(slot._id)];
        lines.push(`✅ ${esc(agent.name)}${code ? ` → agent code <b>${esc(code)}</b>` : ''}`);
        await notify.toUser(agent.telegramId,
          `📌 <b>You were assigned a slot</b>\n${fmtDateTime(slot.start)}–${fmtTime(slot.end)} · ${esc(slot.account.name)}${code ? `\n🆔 <b>Use agent code: ${esc(code)}</b>` : ''}\n\nWhen your time starts, press ▶️ Start work.`).catch(() => {});
      } catch (err) {
        lines.push(`❌ ${esc(agent.name)}: ${esc(err instanceof ReservationError ? err.message : 'could not be assigned')}`);
      }
    }
    return ctx.reply(`📌 <b>Assignment</b> · ${date} ${fmtTime(slot.start)}–${fmtTime(slot.end)} · ${esc(slot.account.name)}\n${lines.join('\n')}`, html());
  });

  bot.command('accounts', adminOnly, async (ctx) => {
    const accounts = await Account.find().sort({ name: 1 });
    if (!accounts.length) return ctx.reply('No accounts yet. Use /addaccount.');
    const active = await Session.find({ status: 'active' }).populate('user');
    const byAcc = new Map();
    active.forEach((x) => {
      const k = String(x.account);
      if (!byAcc.has(k)) byAcc.set(k, []);
      byAcc.get(k).push(`${esc(x.user.name)} since ${fmtTime(x.startedAt)}`);
    });
    return ctx.reply(
      '🔑 <b>Accounts</b>\n' +
        accounts.map((a) => {
          const users = byAcc.get(String(a._id));
          const state = !a.active ? '⛔ disabled' : users ? `🟢 in use: ${users.join('; ')}` : '⚪ free';
          return `• <b>${esc(a.name)}</b> — ${state}${a.agentCodes?.length ? ` · codes: ${a.agentCodes.map(esc).join(', ')}` : ''}`;
        }).join('\n'),
      html()
    );
  });

  bot.command('idle', adminOnly, async (ctx) => {
    const now = new Date();
    const dayStart = parseDateTime(todayStr());
    const accounts = await Account.find({ active: true }).sort({ name: 1 });
    const active = new Set((await Session.find({ status: 'active' })).map((s) => String(s.account)));
    const lines = [];
    for (const a of accounts) {
      if (active.has(String(a._id))) continue;
      const open = await Slot.countDocuments({
        account: a._id,
        start: { $gte: now, $lt: new Date(dayStart.getTime() + DAY) },
        $expr: { $lt: ['$bookedCount', '$capacity'] },
      });
      const next = await Booking.findOne({ account: a._id, end: { $gt: now } }).sort({ start: 1 }).populate('user');
      lines.push(`• <b>${esc(a.name)}</b> — no active session; ${open} slot(s) with free places left today` + (next ? `; next reserved ${fmtDate(next.start)} ${fmtTime(next.start)} by ${esc(next.user?.name)}` : ''));
    }
    return ctx.reply(lines.length ? '💤 <b>Idle accounts</b>\n' + lines.join('\n') : 'All active accounts are in use right now.', html());
  });

  // ---- slots ----
  bot.command('addslots', adminOnly, async (ctx) => {
    const [date, from, to, accArg, minArg, capArg] = args(ctx);
    const minutes = minArg ? Number(minArg) : 60;
    const capacity = capArg ? Number(capArg) : config.defaultCapacity;
    const start = parseSlotTime(date, from);
    let end = parseSlotTime(date, to);
    if (!start || !end || !accArg || !(minutes >= 5)) {
      return ctx.reply('Usage: /addslots <date> <from> <to> <account|all> [minutes=60] [users=1|2]\nEthiopian example: /addslots 2026-10-08 2:00day 4:00night all 60 2\nUse day/night without spaces, or standard 24-hour times.');
    }
    if (![1, config.maxCapacity].includes(capacity)) return ctx.reply(`Users per slot must be 1 or ${config.maxCapacity}.`);
    if (end <= start) end = new Date(end.getTime() + DAY); // overnight shift
    const accounts = await findAccounts(accArg);
    if (!accounts.length) return ctx.reply('Account not found. See /accounts.');

    let created = 0;
    let skipped = 0;
    await disableDefaultSlots(date, accounts);
    for (const acc of accounts) {
      for (let t = start.getTime(); t + minutes * 60000 <= end.getTime(); t += minutes * 60000) {
        const r = await Slot.updateOne(
          { account: acc._id, start: new Date(t) },
          { $setOnInsert: { end: new Date(t + minutes * 60000), capacity, bookedCount: 0 } },
          { upsert: true }
        );
        if (r.upsertedCount) created += 1; else skipped += 1;
      }
    }
    return ctx.reply(`✅ ${created} slot(s) created on ${accounts.length} account(s) for ${date} ${fmtTime(start)}–${fmtTime(end)} (Ethiopian time), up to ${capacity} user(s) each.${skipped ? `\n${skipped} already existed (left unchanged).` : ''}`);
  });

  bot.command('delslots', adminOnly, async (ctx) => {
    const [date, accArg] = args(ctx);
    const from = parseDateTime(date);
    if (!from || !accArg) return ctx.reply('Usage: /delslots <date> <account|all>');
    const accounts = await findAccounts(accArg);
    if (!accounts.length) return ctx.reply('Account not found.');
    await disableDefaultSlots(date, accounts);
    const r = await Slot.deleteMany({
      account: { $in: accounts.map((a) => a._id) },
      bookedCount: 0,
      start: { $gte: from, $lt: new Date(from.getTime() + DAY) },
    });
    return ctx.reply(`🗑 ${r.deletedCount} unreserved slot(s) removed. Slots with reservations were kept.`);
  });

  bot.command('schedule', adminOnly, async (ctx) => {
    const text = await scheduleText(args(ctx)[0] || todayStr());
    if (!text) return ctx.reply('Usage: /schedule [YYYY-MM-DD]');
    return ctx.reply(text, html());
  });
}

module.exports = { register, findUser, findAccounts, ADMIN_HELP };
