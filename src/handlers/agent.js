const { Markup } = require('telegraf');
const config = require('../config');
const Slot = require('../models/Slot');
const Booking = require('../models/Booking');
const Session = require('../models/Session');
const { esc, accountInfo } = require('../utils/format');
const {
  DAY, parseDateTime, fmtTime, fmtDate, fmtDateTime, todayStr, addDays, fmtHm, parseRange,
} = require('../utils/time');
const { hoursReport, renderReport } = require('../services/report');
const { ensureDefaultSlots } = require('../services/defaultSlots');
const { reserveSlots, ReservationError } = require('../services/reservations');
const { requestAdminRole } = require('./join');

const html = (extra = {}) => ({ parse_mode: 'HTML', ...extra });
const MAX_LIST = 60;
const selections = new Map();
const SELECTION_TTL = 30 * 60000;
function selectedTimes(user, date) {
  const now = Date.now();
  for (const [key, selection] of selections) {
    if (selection.expiresAt <= now) selections.delete(key);
  }
  const key = `${user._id}:${date}`;
  if (!selections.has(key)) selections.set(key, { slots: new Set(), expiresAt: now + SELECTION_TTL });
  const selection = selections.get(key);
  selection.expiresAt = now + SELECTION_TTL;
  return selection.slots;
}
const chooseTimeDate = () => {
  const today = todayStr();
  const lastStart = parseDateTime(today, config.defaultSlotEnd).getTime() - config.defaultSlotMinutes * 60000;
  return Date.now() + config.minNoticeMin * 60000 >= lastStart ? addDays(today, 1) : today;
};
const homeBtn = () => Markup.button.callback('🏠 Home', 'a:home');
const chooseTimeKeyboard = () => Markup.inlineKeyboard([
  [Markup.button.callback('📅 Reserve a time', `slots:date:${chooseTimeDate()}`)],
  [Markup.button.callback('🗓 My reservations', 'bookings:mine'), homeBtn()],
]);

// Persistent keyboard shown at the bottom of the chat.
const KB = {
  reserve: '📅 Reserve', bookings: '🗓 My bookings', start: '▶️ Start work', end: '⏹ End work',
  account: '🔑 My account', hours: '⏱ My hours', menu: '🏠 Menu', admin: '🛠 Admin panel',
};
const mainKeyboard = (user) => Markup.keyboard([
  [KB.reserve, KB.bookings],
  [KB.start, KB.end],
  [KB.account, KB.hours],
  user.role === 'admin' ? [KB.menu, KB.admin] : [KB.menu],
]).resize().persistent();

/** Agent home: current status + one-tap access to everything. */
async function homeScreen(user) {
  const now = new Date();
  const active = await Session.findOne({ user: user._id, status: 'active' }).populate('account');
  const next = await Booking.findOne({ user: user._id, end: { $gt: now } }).sort({ start: 1 }).populate('account');
  let status;
  if (active) status = `🟢 Working on <b>${esc(active.account.name)}</b> since ${fmtTime(active.startedAt)}`;
  else if (next) status = `🗓 Next: <b>${fmtDate(next.start)} ${fmtTime(next.start)}–${fmtTime(next.end)}</b> · ${esc(next.account.name)}`;
  else status = '⚪ No upcoming reservations';
  const rows = [
    [active ? Markup.button.callback('⏹ End work', 'work:end') : Markup.button.callback('▶️ Start work', 'work:start')],
    [Markup.button.callback('📅 Reserve a time', `slots:date:${chooseTimeDate()}`), Markup.button.callback('🗓 My reservations', 'bookings:mine')],
    [Markup.button.callback('🔑 My account', 'a:acc'), Markup.button.callback('⏱ My hours', 'a:hours')],
  ];
  if (user.role === 'admin') rows.push([Markup.button.callback('🛠 Admin panel', 'p:home')]);
  else rows.push([Markup.button.callback(user.adminRequest === 'pending' ? '⏳ Admin request pending' : '🛡 Request admin access', 'a:reqadmin')]);
  return { text: `👋 Hello <b>${esc(user.name)}</b>!\n\n${status}\n\nWhat would you like to do?`, extra: Markup.inlineKeyboard(rows) };
}

async function safeEdit(ctx, text, extra) {
  try { await ctx.editMessageText(text, html(extra)); } catch (e) { /* message not modified */ }
}

// ---------- slots ----------
async function renderSlots(dateStr, user) {
  const from = parseDateTime(dateStr);
  const to = new Date(from.getTime() + DAY);
  const accounts = await ensureDefaultSlots(dateStr);
  const slots = await Slot.find({ account: { $in: accounts.map((account) => account._id) }, start: { $gte: from, $lt: to } }).sort({ start: 1, account: 1 }).populate('account');
  const bookings = await Booking.find({ slot: { $in: slots.map((s) => s._id) } }).populate('user');
  const namesBySlot = new Map();
  bookings.forEach((b) => {
    const k = String(b.slot);
    if (!namesBySlot.has(k)) namesBySlot.set(k, []);
    namesBySlot.get(k).push(b);
  });
  const now = new Date();
  const selected = selectedTimes(user, dateStr);
  const available = slots.filter((slot) => slot.bookedCount < slot.capacity
    && slot.start.getTime() > now.getTime() + config.minNoticeMin * 60000
    && !(namesBySlot.get(String(slot._id)) || []).some((booking) => String(booking.user?._id) === String(user._id)));
  const availableIds = new Set(available.map((slot) => String(slot._id)));
  for (const id of selected) { if (!availableIds.has(id)) selected.delete(id); }

  const day = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' });
  const tag = dateStr === todayStr() ? ' · Today' : dateStr === addDays(todayStr(), 1) ? ' · Tomorrow' : '';
  const multiAccount = accounts.length > 1;
  let text = `📅 <b>${day} ${dateStr}</b>${tag}
<i>Ethiopian time</i>
`;
  const rows = [];
  if (!slots.length) text += accounts.length ? '\nNo slots published for this day.' : '\nNo active call-center accounts. Please contact your supervisor.';

  const shown = slots.slice(0, MAX_LIST);
  const mineLines = [];
  let fullCount = 0;
  let pastCount = 0;
  let openCount = 0;
  shown.forEach((s) => {
    const label = `${fmtTime(s.start)}–${fmtTime(s.end)}`;
    const list = namesBySlot.get(String(s._id)) || [];
    const mine = list.some((b) => String(b.user._id) === String(user._id));
    const full = s.bookedCount >= s.capacity;
    const open = s.start.getTime() > now.getTime() + config.minNoticeMin * 60000;
    if (mine) rows.push([Markup.button.callback(`🟦 ${label} · yours`, `slot:info:${s._id}`)]);
    if (mine) mineLines.push(`🟦 ${label}${multiAccount ? ` · ${esc(s.account?.name || '?')}` : ''}`);
    else if (!full && open) {
      const checked = selected.has(String(s._id));
      const extra = (multiAccount ? ` · ${s.account ? s.account.name : '?'}` : '') + (s.capacity > 1 ? ` · ${s.bookedCount}/${s.capacity}` : '');
      openCount += 1;
      rows.push([Markup.button.callback(`${checked ? '☑️' : '🟢'} ${label}${extra}`, `slot:toggle:${s._id}`)]);
    } else if (full) {
      fullCount += 1;
      rows.push([Markup.button.callback(`❌ ${label} · full`, `slot:info:${s._id}`)]);
    } else {
      pastCount += 1;
      rows.push([Markup.button.callback(`🔒 ${label}`, `slot:info:${s._id}`)]);
    }
  });
  if (mineLines.length) text += `
<b>Your reservations</b>
${mineLines.join('\n')}
`;
  const notes = [openCount ? `🟢 ${openCount} open` : '', fullCount ? `❌ ${fullCount} full` : '', pastCount ? `⏳ ${pastCount} past` : ''].filter(Boolean);
  if (notes.length) text += `
${notes.join(' · ')}`;
  if (slots.length > MAX_LIST) text += `
… and ${slots.length - MAX_LIST} more.`;
  if (openCount) {
    const totalMinutes = slots.filter((slot) => selected.has(String(slot._id))).reduce((sum, slot) => sum + (slot.end - slot.start) / 60000, 0);
    text += `

👇 Tap times to select, then press Reserve.
Selected: <b>${selected.size}</b> · <b>${fmtHm(totalMinutes)}</b> (daily limit ${config.maxHoursPerDay} h)`;
    rows.push([Markup.button.callback(`✅ Reserve selected (${selected.size})`, `slots:reserve:${dateStr}`)]);
    if (selected.size) rows.push([Markup.button.callback('✖ Clear selection', `slots:clear:${dateStr}`)]);
  }
  else if (slots.length) text += '\n\nNo available times on this day. Use Next day to choose another date.';

  rows.push([
    Markup.button.callback('◀️ Prev day', `slots:date:${addDays(dateStr, -1)}`),
    Markup.button.callback('Next day ▶️', `slots:date:${addDays(dateStr, 1)}`),
  ]);
  rows.push([Markup.button.callback('🗓 My reservations', 'bookings:mine'), homeBtn()]);
  return { text, extra: Markup.inlineKeyboard(rows) };
}

async function confirmReservations(ctx, ids, date) {
  let slots;
  try { slots = await reserveSlots(ctx.state.user, ids); }
  catch (err) {
    return ctx.answerCbQuery(err instanceof ReservationError ? err.message : 'Could not reserve these times. Please try again.', { show_alert: true });
  }
  for (const slot of slots) selectedTimes(ctx.state.user, fmtDate(slot.start)).delete(String(slot._id));
  await ctx.answerCbQuery(`Reserved ${slots.length} time${slots.length === 1 ? '' : 's'}.`);
  const accounts = [...new Map(slots.map((slot) => [String(slot.account._id), slot.account])).values()];
  const lines = slots.map((slot) => `${fmtDate(slot.start)} ${fmtTime(slot.start)}–${fmtTime(slot.end)} · ${esc(slot.account.name)}`);
  const otherBookings = await Booking.find({ slot: { $in: slots.map((slot) => slot._id) }, user: { $ne: ctx.state.user._id } }).populate('user');
  const others = [...new Set(otherBookings.map((booking) => booking.user?.name).filter(Boolean))];
  await ctx.reply(
    `✅ <b>Reserved ${slots.length} time${slots.length === 1 ? '' : 's'}</b>\n${lines.join('\n')}${others.length ? `\nSharing selected slots with: ${others.map(esc).join(', ')}` : ''}\n\n${accounts.map(accountInfo).join('\n\n')}\n\nWhen your time starts, press ▶️ Start work.`,
    html(workKeyboard(false))
  );
  const { text, extra } = await renderSlots(date, ctx.state.user);
  return safeEdit(ctx, text, extra);
}

// ---------- my bookings ----------
async function renderMyBookings(user) {
  const now = Date.now();
  const bookings = await Booking.find({ user: user._id, end: { $gt: new Date() } })
    .sort({ start: 1 }).limit(30).populate('account');
  if (!bookings.length) return { text: '🗓 You have no upcoming reservations.\nTap Reserve a time to book a slot.', extra: chooseTimeKeyboard() };

  const dayLabel = (d) => {
    const day = fmtDate(d);
    return day === todayStr() ? 'Today' : day === addDays(todayStr(), 1) ? 'Tomorrow' : day;
  };
  const inTxt = (min) => (min >= 60 ? fmtHm(min) : `${Math.max(1, Math.round(min))} min`);
  const rows = [];
  let text = `🗓 <b>My reservations</b> (${bookings.length})\n`;
  let lastDay = '';
  let startable = false;
  bookings.forEach((b) => {
    const day = fmtDate(b.start);
    if (day !== lastDay) {
      text += `\n<b>${dayLabel(b.start)}</b>${day === todayStr() || day === addDays(todayStr(), 1) ? ` · ${day}` : ''}\n`;
      lastDay = day;
    }
    const startsIn = (b.start.getTime() - now) / 60000;
    const status = startsIn <= 0 ? '🟢 now' : `in ${inTxt(startsIn)}`;
    if (startsIn <= config.earlyStartMin) startable = true;
    text += `• ${fmtTime(b.start)}–${fmtTime(b.end)} · <b>${esc(b.account.name)}</b> · ${fmtHm((b.end - b.start) / 60000)} · <i>${status}</i>\n`;
    if (startsIn >= config.cancelDeadlineMin) {
      rows.push([Markup.button.callback(`🗑 Cancel ${dayLabel(b.start)} ${fmtTime(b.start)}`, `slot:cancel:${b._id}`)]);
    }
  });
  text += `\n<i>Cancel up to ${config.cancelDeadlineMin} min before the start.</i>`;
  if (startable) rows.unshift([Markup.button.callback('▶️ Start work', 'work:start')]);
  rows.push([Markup.button.callback('📅 Reserve another time', `slots:date:${chooseTimeDate()}`), homeBtn()]);
  return { text, extra: Markup.inlineKeyboard(rows) };
}

// ---------- start / end work ----------
const workKeyboard = (active) =>
  Markup.inlineKeyboard([[active ? Markup.button.callback('⏹ End work', 'work:end') : Markup.button.callback('▶️ Start work', 'work:start')], [Markup.button.callback('🏠 Home', 'a:home')]]);

async function startWork(ctx) {
  const user = ctx.state.user;
  const now = new Date();
  const active = await Session.findOne({ user: user._id, status: 'active' }).populate('account');
  if (active) {
    return ctx.reply(`You already have an active session on <b>${esc(active.account.name)}</b> since ${fmtTime(active.startedAt)}.`, html(workKeyboard(true)));
  }
  const booking = await Booking.findOne({
    user: user._id,
    start: { $lte: new Date(now.getTime() + config.earlyStartMin * 60000) },
    end: { $gt: now },
  }).populate('account');
  if (!booking) return ctx.reply('You have no reserved slot right now. Use /slots to reserve one, or /mybookings to see your reservations.');

  const late = Math.max(0, Math.round((now - booking.start) / 60000));
  await Session.create({ slot: booking.slot, account: booking.account._id, user: user._id, startedAt: now, lateMinutes: late });
  return ctx.reply(
    `▶️ <b>Work started</b> at ${fmtTime(now)}${late ? ` (${late} min late)` : ''}\nSlot ends at ${fmtTime(booking.end)}.\n\n${accountInfo(booking.account)}`,
    html(workKeyboard(true))
  );
}

async function endWork(ctx) {
  const user = ctx.state.user;
  const session = await Session.findOneAndUpdate(
    { user: user._id, status: 'active' },
    { endedAt: new Date(), status: 'completed' },
    { new: true }
  ).populate('account');
  if (!session) return ctx.reply('You have no active session.');
  const mins = (session.endedAt - session.startedAt) / 60000;
  return ctx.reply(`⏹ <b>Work ended</b> on ${esc(session.account.name)}.\nWorked: <b>${fmtHm(mins)}</b> (${fmtTime(session.startedAt)}–${fmtTime(session.endedAt)})`, html(Markup.inlineKeyboard([[homeBtn()]])));
}

async function showAccount(ctx) {
  const user = ctx.state.user;
  const b = await Booking.findOne({ user: user._id, end: { $gt: new Date() } }).sort({ start: 1 }).populate('account');
  if (!b) return ctx.reply('You have no upcoming reservation. Reserve a time first.', html(chooseTimeKeyboard()));
  const active = await Session.exists({ user: user._id, status: 'active' });
  return ctx.reply(`🔑 <b>${fmtDateTime(b.start)} – ${fmtTime(b.end)}</b>\n\n${accountInfo(b.account)}`, html(workKeyboard(!!active)));
}

const bar = (done, total) => {
  const n = total > 0 ? Math.min(10, Math.round((done / total) * 10)) : 0;
  return '█'.repeat(n) + '░'.repeat(10 - n);
};

function renderMyHours(label, row) {
  const head = `⏱ <b>My hours</b> · ${esc(label)}\n`;
  if (!row) return `${head}\nNo reservations or work in this period.`;
  const diff = row.workedMin - row.bookedMin;
  return `${head}\n📅 Reserved: <b>${fmtHm(row.bookedMin)}</b>\n▶️ Worked: <b>${fmtHm(row.workedMin)}</b>\n\n` +
    `${bar(row.workedMin, row.bookedMin)} ${row.bookedMin > 0 ? Math.round((row.workedMin / row.bookedMin) * 100) : 0}%\n` +
    `${diff >= 0 ? '✅ Extra' : '⚠️ Missing'}: ${fmtHm(Math.abs(diff))}${row.noShows ? `\n❌ No-shows: ${row.noShows}` : ''}`;
}

async function showHours(ctx, argv) {
  const range = parseRange(argv);
  if (!range) return ctx.reply('Usage: /myhours [today|yesterday|week|month|2026-10-01 2026-10-07]');
  const [row] = await hoursReport(range.from, range.to, { by: 'user', id: ctx.state.user._id });
  const key = argv[0] || 'today';
  const keys = [['Today', 'today'], ['Yesterday', 'yesterday'], ['Week', 'week'], ['Month', 'month']];
  const kb = Markup.inlineKeyboard([keys.map(([l, k]) => Markup.button.callback(k === key ? `• ${l}` : l, `a:hours:${k}`)), [homeBtn()]]);
  const text = renderMyHours(range.label, row);
  if (ctx.callbackQuery && /^a:hours:/.test(ctx.callbackQuery.data)) return safeEdit(ctx, text, kb);
  return ctx.reply(text, html(kb));
}

function register(bot) {
  const openHome = async (ctx) => {
    const { text, extra } = await homeScreen(ctx.state.user);
    if (ctx.callbackQuery) { await ctx.answerCbQuery().catch(() => {}); return safeEdit(ctx, text, extra); }
    return ctx.reply(text, html(extra));
  };
  // start: attach the bottom keyboard first (a message can't carry both keyboard types), then the menu
  bot.start(async (ctx) => {
    await ctx.reply('Use the buttons below to move around 👇', mainKeyboard(ctx.state.user));
    return openHome(ctx);
  });
  bot.hears(KB.menu, openHome);
  bot.hears(KB.reserve, async (ctx) => {
    const { text, extra } = await renderSlots(chooseTimeDate(), ctx.state.user);
    return ctx.reply(text, html(extra));
  });
  bot.hears(KB.bookings, async (ctx) => {
    const { text, extra } = await renderMyBookings(ctx.state.user);
    return ctx.reply(text, html(extra));
  });
  bot.hears(KB.start, startWork);
  bot.hears(KB.end, endWork);
  bot.hears(KB.account, showAccount);
  bot.hears(KB.hours, (ctx) => showHours(ctx, ['today']));
  bot.command(['menu', 'help'], openHome);
  bot.action('a:home', openHome);
  bot.action('a:reqadmin', requestAdminRole);
  bot.command('becomeadmin', requestAdminRole);
  bot.action('a:acc', async (ctx) => { await ctx.answerCbQuery(); return showAccount(ctx); });
  bot.action('a:hours', async (ctx) => { await ctx.answerCbQuery(); return showHours(ctx, ['today']); });

  bot.command('slots', async (ctx) => {
    const arg = ctx.message.text.split(/\s+/)[1] || chooseTimeDate();
    if (!parseDateTime(arg)) return ctx.reply('Date format: /slots 2026-10-08');
    const { text, extra } = await renderSlots(arg, ctx.state.user);
    return ctx.reply(text, html(extra));
  });

  bot.action(/^slots:date:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    if (!parseDateTime(ctx.match[1])) return ctx.answerCbQuery('Invalid date.', { show_alert: true });
    const { text, extra } = await renderSlots(ctx.match[1], ctx.state.user);
    await safeEdit(ctx, text, extra);
    return ctx.answerCbQuery();
  });

  // tap a locked / reserved time to see who has it
  bot.action(/^slot:info:([a-f0-9]{24})$/, async (ctx) => {
    const slot = await Slot.findById(ctx.match[1]).populate('account');
    if (!slot) return ctx.answerCbQuery('This time no longer exists.', { show_alert: true });
    const people = (await Booking.find({ slot: slot._id }).populate('user')).map((b) => b.user?.name).filter(Boolean);
    const head = `${fmtTime(slot.start)}–${fmtTime(slot.end)}${slot.account ? ` · ${slot.account.name}` : ''}`;
    const state = slot.end.getTime() <= Date.now() ? 'Finished' : slot.start.getTime() <= Date.now() ? 'In progress' : slot.bookedCount >= slot.capacity ? 'Full' : 'Open';
    const who = people.length ? `Reserved by:\n${people.map((n) => `• ${n}`).join('\n')}` : 'Not reserved by anyone.';
    return ctx.answerCbQuery(`${head}\n${state} (${slot.bookedCount}/${slot.capacity})\n\n${who}`, { show_alert: true });
  });

  bot.action(/^slot:toggle:([a-f0-9]{24})$/, async (ctx) => {
    const slot = await Slot.findById(ctx.match[1]).populate('account');
    if (!slot) return ctx.answerCbQuery('This time is no longer available.', { show_alert: true });
    const date = fmtDate(slot.start);
    const selected = selectedTimes(ctx.state.user, date);
    const id = String(slot._id);
    if (selected.has(id)) selected.delete(id);
    else {
      if (!slot.account?.active || slot.bookedCount >= slot.capacity || slot.start.getTime() <= Date.now() + config.minNoticeMin * 60000) {
        return ctx.answerCbQuery('This time is no longer available. Please choose another slot.', { show_alert: true });
      }
      if (await Booking.exists({ slot: slot._id, user: ctx.state.user._id })) return ctx.answerCbQuery('You already reserved this slot.', { show_alert: true });
      selected.add(id);
    }
    await ctx.answerCbQuery();
    const { text, extra } = await renderSlots(date, ctx.state.user);
    return safeEdit(ctx, text, extra);
  });

  bot.action(/^slots:clear:(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    const date = ctx.match[1];
    if (!parseDateTime(date)) return ctx.answerCbQuery('Invalid date.', { show_alert: true });
    selectedTimes(ctx.state.user, date).clear();
    await ctx.answerCbQuery('Selection cleared.');
    const { text, extra } = await renderSlots(date, ctx.state.user);
    return safeEdit(ctx, text, extra);
  });

  bot.action(/^slots:reserve:(\d{4}-\d{2}-\d{2})$/, (ctx) => {
    const date = ctx.match[1];
    if (!parseDateTime(date)) return ctx.answerCbQuery('Invalid date.', { show_alert: true });
    return confirmReservations(ctx, [...selectedTimes(ctx.state.user, date)], date);
  });

  bot.action(/^slot:select:([a-f0-9]{24})$/, async (ctx) => {
    const slot = await Slot.findById(ctx.match[1]).populate('account');
    if (!slot?.account?.active || slot.bookedCount >= slot.capacity) return ctx.answerCbQuery('This slot is no longer available.', { show_alert: true });
    if (slot.start.getTime() <= Date.now() + config.minNoticeMin * 60000) return ctx.answerCbQuery('This time is no longer available. Please choose a later slot.', { show_alert: true });
    if (await Booking.exists({ slot: slot._id, user: ctx.state.user._id })) return ctx.answerCbQuery('You already reserved this slot.', { show_alert: true });
    await ctx.answerCbQuery();
    return safeEdit(
      ctx,
      `<b>Confirm your reservation</b>\n\nDate: <b>${fmtDate(slot.start)}</b>\nEthiopian time: <b>${fmtTime(slot.start)}–${fmtTime(slot.end)}</b>\nAccount: <b>${esc(slot.account.name)}</b>\nDuration: ${fmtHm((slot.end - slot.start) / 60000)}\n\nPress Reserve to book this time.`,
      Markup.inlineKeyboard([
        [Markup.button.callback('Reserve', `slot:book:${slot._id}`)],
        [Markup.button.callback('Back to times', `slots:date:${fmtDate(slot.start)}`)],
      ])
    );
  });

  bot.action(/^slot:book:([a-f0-9]{24})$/, async (ctx) => {
    const slot = await Slot.findById(ctx.match[1]).select('start');
    if (!slot) return ctx.answerCbQuery('This time is no longer available.', { show_alert: true });
    return confirmReservations(ctx, [String(slot._id)], fmtDate(slot.start));
  });

  bot.command(['mybookings', 'cancel'], async (ctx) => {
    const { text, extra } = await renderMyBookings(ctx.state.user);
    return ctx.reply(text, html(extra));
  });
  bot.action('bookings:mine', async (ctx) => {
    await ctx.answerCbQuery();
    const { text, extra } = await renderMyBookings(ctx.state.user);
    return safeEdit(ctx, text, extra);
  });

  bot.action(/^slot:cancel:([a-f0-9]{24})$/, async (ctx) => {
    const user = ctx.state.user;
    const b = await Booking.findOneAndDelete({
      _id: ctx.match[1], user: user._id,
      start: { $gt: new Date(Date.now() + config.cancelDeadlineMin * 60000) },
    });
    if (!b) return ctx.answerCbQuery(`Too late to cancel (deadline: ${config.cancelDeadlineMin} min before start).`, { show_alert: true });
    await Slot.updateOne({ _id: b.slot }, { $inc: { bookedCount: -1 } });
    await ctx.answerCbQuery('Reservation cancelled.');
    const { text, extra } = await renderMyBookings(user);
    return safeEdit(ctx, text, extra);
  });

  bot.command('myaccount', showAccount);

  bot.command('startwork', startWork);
  bot.command('endwork', endWork);
  bot.action('work:start', async (ctx) => { await ctx.answerCbQuery(); return startWork(ctx); });
  bot.action('work:end', async (ctx) => { await ctx.answerCbQuery(); return endWork(ctx); });

  bot.command('myhours', (ctx) => showHours(ctx, ctx.message.text.split(/\s+/).slice(1)));
  bot.action(/^a:hours:(today|yesterday|week|month)$/, async (ctx) => { await ctx.answerCbQuery(); return showHours(ctx, [ctx.match[1]]); });
}

module.exports = { KB, mainKeyboard, register, workKeyboard };
