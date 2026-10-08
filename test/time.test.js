const assert = require('node:assert/strict');
const { test } = require('node:test');

process.env.BOT_TOKEN = '123456:test';
process.env.MONGO_URI = 'mongodb://127.0.0.1:27017';
process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
process.env.TZ_NAME = 'Africa/Addis_Ababa';
process.env.TZ_OFFSET = '+03:00';

const { parseDateTime, parseSlotTime, fmtTime, fmtDate, fmtDateTime, fmtHm, fmtHM } = require('../src/utils/time');

test('Ethiopian clock conversion keeps minutes and distinguishes morning, afternoon and night', () => {
  const expected = [
    ['00:00', '6:00 night'], ['05:59', '11:59 night'],
    ['06:00', '12:00 morning'], ['08:00', '2:00 morning'],
    ['11:30', '5:30 morning'], ['12:00', '6:00 afternoon'],
    ['17:45', '11:45 afternoon'], ['18:00', '12:00 night'],
    ['21:00', '3:00 night'], ['22:00', '4:00 night'], ['23:59', '5:59 night'],
  ];
  for (const [standard, ethiopian] of expected) {
    assert.equal(fmtTime(new Date(`2026-10-08T${standard}:00+03:00`)), ethiopian);
  }
});

test('Ethiopian command inputs map to exact UTC instants with noon and midnight handled', () => {
  const expected = [
    ['2:00day', '2026-10-08T05:00:00.000Z'],
    ['4:00night', '2026-10-08T19:00:00.000Z'],
    ['12:00day', '2026-10-08T03:00:00.000Z'],
    ['12:00night', '2026-10-08T15:00:00.000Z'],
    ['6:00night', '2026-10-07T21:00:00.000Z'],
    ['02:15D', '2026-10-08T05:15:00.000Z'],
    ['2:30morning', '2026-10-08T05:30:00.000Z'],
    ['8:15afternoon', '2026-10-08T11:15:00.000Z'],
  ];
  for (const [input, iso] of expected) assert.equal(parseSlotTime('2026-10-08', input).toISOString(), iso);
});

test('invalid Ethiopian times are rejected and standard command times stay compatible', () => {
  for (const invalid of ['0:00day', '13:00night', '2:60day', '8:00morning', '2:00afternoon', '2:00unknown', '2:00 day', '', undefined]) {
    assert.equal(parseSlotTime('2026-10-08', invalid), null);
  }
  assert.equal(parseSlotTime('2026-10-08', '08:00').toISOString(), '2026-10-08T05:00:00.000Z');
  assert.equal(parseSlotTime('2026-10-08', '22:00').toISOString(), '2026-10-08T19:00:00.000Z');
});

test('clock display does not shift local dates or convert elapsed durations', () => {
  const midnight = new Date('2026-10-07T21:15:00.000Z');
  assert.equal(fmtDate(midnight), '2026-10-08');
  assert.equal(fmtDateTime(midnight), '2026-10-08 6:15 night');
  assert.equal(parseDateTime('2026-10-08', '08:00').toISOString(), '2026-10-08T05:00:00.000Z');
  assert.equal(fmtHm(60), '1h 00m');
  assert.equal(fmtHM(480), '8:00');
});
