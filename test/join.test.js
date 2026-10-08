const assert = require('node:assert/strict');
const { test, before, beforeEach, after } = require('node:test');
const { randomBytes } = require('node:crypto');

// Telegram is mocked, and all database writes use a fresh, isolated test database.
process.env.BOT_TOKEN = '123456:test';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.MONGO_URI = process.env.JOIN_TEST_MONGO_URI || 'mongodb://127.0.0.1:27017';
process.env.ADMIN_IDS = '9001';

const mongoose = require('mongoose');
const { Telegraf } = require('telegraf');
const User = require('../src/models/User');
const config = require('../src/config');
const { auth } = require('../src/middleware/auth');
const join = require('../src/handlers/join');
const agent = require('../src/handlers/agent');
const admin = require('../src/handlers/admin');
const panel = require('../src/handlers/panel');
const notify = require('../src/services/notify');

const dbName = `call_center_bot_join_test_${process.pid}_${randomBytes(5).toString('hex')}`;
let bot;
let events;
let adminMessages;
let userMessages;
let updateId = 0;

before(async () => {
  await mongoose.connect(process.env.MONGO_URI, { dbName, serverSelectionTimeoutMS: 5000 });
  await User.init();
});

beforeEach(async () => {
  await User.deleteMany({});
  config.adminIds = [9001];
  events = [];
  adminMessages = [];
  userMessages = [];
  notify.toAdmin = async (...args) => { adminMessages.push(args); };
  notify.toUser = async (...args) => { userMessages.push(args); };
  bot = new Telegraf('123456:test');
  bot.botInfo = { id: 123456, is_bot: true, first_name: 'Test', username: 'join_test_bot' };
  for (const method of ['reply', 'answerCbQuery', 'editMessageText', 'editMessageReplyMarkup']) {
    bot.context[method] = async function (...args) {
      events.push({ method, chatId: this.chat?.id, args });
      return { message_id: updateId };
    };
  }
  join.registerPublic(bot);
  bot.use(auth);
  agent.register(bot);
  admin.register(bot);
  panel.register(bot);
  join.registerAdmin(bot);
});

after(async () => {
  try {
    if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName && /^call_center_bot_join_test_\d+_[a-f0-9]+$/.test(dbName)) {
      await mongoose.connection.dropDatabase();
    }
  } finally { await mongoose.disconnect(); }
});

const from = (id) => ({ id, is_bot: false, first_name: 'Agent <One>', username: `user${id}` });
async function message(id, text, type = 'private') {
  const command = text.match(/^\/\w+(?:@\w+)?/);
  return bot.handleUpdate({
    update_id: ++updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type }, from: from(id), text,
      entities: command ? [{ type: 'bot_command', offset: 0, length: command[0].length }] : [],
    },
  });
}
async function callback(id, data) {
  return bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(updateId), from: from(id), chat_instance: 'test', data,
      message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id, type: 'private' }, from: bot.botInfo, text: 'Join request' },
    },
  });
}
const lastReply = () => events.filter((event) => event.method === 'reply').at(-1);

test('new users see a join button, remain blocked, and cannot submit from groups', async () => {
  await message(1001, '/start');
  assert.match(lastReply().args[0], /admin approval/);
  assert.equal(lastReply().args[1].reply_markup.inline_keyboard[0][0].callback_data, 'join:request');
  assert.equal(await User.countDocuments(), 0);
  await message(1001, '/slots');
  assert.match(lastReply().args[0], /admin approval/);
  await message(1001, '/join', 'group');
  assert.equal(await User.countDocuments(), 0);
});

test('one pending request is saved, admins receive escaped identities, and repeats do not notify again', async () => {
  await User.create({ telegramId: 9002, name: 'Supervisor', role: 'admin' });
  await callback(1001, 'join:request');
  await Promise.all([message(1001, '/join'), callback(1001, 'join:request')]);
  const user = await User.findOne({ telegramId: 1001 });
  assert.equal(await User.countDocuments({ telegramId: 1001 }), 1);
  assert.equal(user.registrationStatus, 'pending');
  assert.equal(user.active, false);
  assert.equal(user.role, 'agent');
  assert.ok(user.requestedAt);
  assert.deepEqual(adminMessages.map(([id]) => id).sort(), [9001, 9002]);
  assert.match(adminMessages[0][1], /Agent &lt;One&gt;/);
  assert.equal(adminMessages[0][2].reply_markup.inline_keyboard[0][0].callback_data, `join:approve:${user._id}`);
  await message(1001, '/slots');
  assert.match(lastReply().args[0], /waiting for admin approval/);
  await message(1001, '/users');
  assert.match(lastReply().args[0], /waiting for admin approval/);
});

test('simultaneous first submissions create one request and one admin notification', async () => {
  await Promise.all(Array.from({ length: 4 }, () => message(1001, '/join')));
  assert.equal(await User.countDocuments({ telegramId: 1001 }), 1);
  assert.equal(adminMessages.length, 1);
});

test('only an admin can review; approval gives agent access and stale rejection cannot revoke it', async () => {
  await message(1001, '/join');
  const pending = await User.findOne({ telegramId: 1001 });
  await callback(1001, `join:approve:${pending._id}`);
  assert.equal((await User.findById(pending._id)).active, false);
  await User.create({ telegramId: 1002, name: 'Existing agent' });
  await callback(1002, `join:approve:${pending._id}`);
  assert.match(lastReply().args[0], /Admins only/);
  assert.equal((await User.findById(pending._id)).registrationStatus, 'pending');

  await callback(9001, `join:approve:${pending._id}`);
  const approved = await User.findById(pending._id);
  const supervisor = await User.findOne({ telegramId: 9001 });
  assert.equal(approved.registrationStatus, 'approved');
  assert.equal(approved.active, true);
  assert.equal(approved.role, 'agent');
  assert.equal(String(approved.reviewedBy), String(supervisor._id));
  assert.ok(approved.reviewedAt);
  assert.equal(userMessages.length, 1);
  assert.match(userMessages[0][1], /approved/);
  await message(1001, '/start');
  assert.match(lastReply().args[0], /What would you like to do/);
  await callback(9001, `join:reject:${pending._id}`);
  assert.equal((await User.findById(pending._id)).active, true);
  assert.equal(userMessages.length, 1);
});

test('rejection keeps users blocked and repeat requests cannot reactivate them', async () => {
  await message(1001, '/join');
  const pending = await User.findOne({ telegramId: 1001 });
  await callback(9001, `join:reject:${pending._id}`);
  const rejected = await User.findById(pending._id);
  assert.equal(rejected.registrationStatus, 'rejected');
  assert.equal(rejected.active, false);
  assert.match(userMessages[0][1], /rejected/);
  await message(1001, '/start');
  assert.match(lastReply().args[0], /rejected/);
  await message(1001, '/join');
  await callback(9001, `join:approve:${pending._id}`);
  assert.equal((await User.findById(pending._id)).registrationStatus, 'rejected');
  assert.equal(adminMessages.length, 1);
});

test('competing admin decisions apply once and notify the applicant once', async () => {
  await message(1001, '/join');
  await User.create({ telegramId: 9002, name: 'Second admin', role: 'admin' });
  await message(9001, '/start');
  const pending = await User.findOne({ telegramId: 1001 });
  await Promise.all([
    callback(9001, `join:approve:${pending._id}`),
    callback(9002, `join:reject:${pending._id}`),
    callback(9001, `join:approve:${pending._id}`),
  ]);
  const reviewed = await User.findById(pending._id);
  assert.ok(['approved', 'rejected'].includes(reviewed.registrationStatus));
  assert.equal(reviewed.active, reviewed.registrationStatus === 'approved');
  assert.equal(userMessages.length, 1);
});

test('pending requests have pagination, appear in the panel, and stay out of the registered team', async () => {
  await Promise.all(Array.from({ length: 7 }, (_, index) => message(1001 + index, '/join')));
  await message(9001, '/requests');
  assert.match(lastReply().args[0], /7 pending/);
  assert.match(lastReply().args[0], /Page 1 of 2/);
  const rows = lastReply().args[1].reply_markup.inline_keyboard;
  assert.equal(rows.filter((row) => row.some((button) => button.callback_data.startsWith('join:approve:'))).length, 5);
  assert.ok(rows.flat().some((button) => button.callback_data === 'join:list:1'));
  await callback(9001, 'join:list:1');
  assert.match(events.filter((event) => event.method === 'editMessageText').at(-1).args[0], /Page 2 of 2/);
  await message(9001, '/panel');
  assert.ok(lastReply().args[1].reply_markup.inline_keyboard.flat().some((button) => button.callback_data === 'join:list:0'));
  await message(9001, '/users');
  assert.doesNotMatch(lastReply().args[0], /1001/);
  const pending = await User.findOne({ telegramId: 1001 });
  await callback(9001, `p:utog:${pending._id}`);
  assert.equal((await User.findById(pending._id)).active, false);
});

test('legacy users keep access, deactivated users cannot rejoin, and manual registration resolves pending requests', async () => {
  await User.collection.insertOne({ telegramId: 1001, name: 'Legacy agent', role: 'agent', active: true });
  await message(1001, '/start');
  assert.match(lastReply().args[0], /What would you like to do/);
  await User.create({ telegramId: 1002, name: 'Disabled agent', active: false });
  await message(1002, '/join');
  assert.match(lastReply().args[0], /deactivated/);
  assert.equal((await User.findOne({ telegramId: 1002 })).active, false);
  await message(1003, '/join');
  const pending = await User.findOne({ telegramId: 1003 });
  await message(9001, '/adduser 1003 Manual agent');
  assert.equal((await User.findById(pending._id)).registrationStatus, 'approved');
  await callback(9001, `join:reject:${pending._id}`);
  assert.equal((await User.findById(pending._id)).active, true);
});

test('failed applicant notification does not undo approval and tells the admin', async () => {
  await message(1001, '/join');
  const pending = await User.findOne({ telegramId: 1001 });
  notify.toUser = async () => { throw new Error('User blocked the bot'); };
  await callback(9001, `join:approve:${pending._id}`);
  assert.equal((await User.findById(pending._id)).active, true);
  assert.match(events.filter((event) => event.method === 'editMessageText').at(-1).args[0], /notification could not be delivered/);
});

test('a configured admin can bootstrap even after submitting a request before configuration', async () => {
  config.adminIds = [];
  await message(9001, '/join');
  config.adminIds = [9001];
  await message(9001, '/start');
  const supervisor = await User.findOne({ telegramId: 9001 });
  assert.equal(supervisor.role, 'admin');
  assert.equal(supervisor.registrationStatus, 'approved');
  assert.equal(supervisor.active, true);
  await message(9001, '/requests');
  assert.match(lastReply().args[0], /No pending join requests/);
});

test('the dedicated admin bot directs unknown users to the agents bot', async () => {
  const responses = [];
  const adminBot = new Telegraf('123456:test');
  adminBot.botInfo = bot.botInfo;
  adminBot.context.reply = async (text) => { responses.push(text); };
  adminBot.use((ctx, next) => auth(ctx, next, { allowJoin: false }));
  await adminBot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: updateId, date: Math.floor(Date.now() / 1000), chat: { id: 1001, type: 'private' }, from: from(1001), text: '/start' },
  });
  assert.match(responses[0], /supervisors only/);
  assert.equal(await User.countDocuments(), 0);
});
