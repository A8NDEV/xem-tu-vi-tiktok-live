import test from 'node:test';
import assert from 'node:assert/strict';
import { makeName, NAME_MAX, chooseAction, nextDelay, createPacer, isVirtualId, pickLine } from './auto-pace.mjs';

const seeded = (seed = 1) => () => (seed = (seed * 16807) % 2147483647) / 2147483647;

function rig(over = {}){
  let t = 1_000_000;
  const viewers = new Map(), sent = [], chats = [], reads = [];
  const settings = { autoPace: true, autoPaceSpeed: 'normal', autoPaceMax: 8, autoPaceReadings: true, autoPaceLabel: true, ...over };
  const pacer = createPacer({
    getSettings: () => settings, viewers, rand: seeded(7), now: () => t,
    seat: (id, name, o) => { viewers.set(id, { id, name, joinedAt: t, ...o }); },
    onChat: (id, name, text) => chats.push({ id, text }),
    broadcast: m => sent.push(m), addLog: () => {}, readFree: v => reads.push(v.id), busy: () => false,
    setTimeout: () => 0, clearTimeout: () => {},
  });
  return { pacer, viewers, sent, chats, reads, settings, tick: ms => { t += ms; } };
}

test('tên khách ảo ngắn, không trùng', () => {
  const taken = new Set(), r = seeded(3);
  for (let i = 0; i < 60; i++) { const n = makeName(r, taken); assert.ok(n.length <= NAME_MAX, n); assert.ok(!taken.has(n), n); taken.add(n); }
});

test('người thật vừa hoạt động → khách ảo im hẳn', () => {
  assert.equal(chooseAction(() => .5, { realAgo: 5_000, virtualCount: 3, max: 8, canJoin: true, canRead: true, canLeave: true }), 'skip');
});

test('không gieo quẻ miễn phí khi người thật mới hoạt động trong 90 giây', () => {
  const r = seeded(11);
  for (let i = 0; i < 300; i++) assert.notEqual(chooseAction(r, { realAgo: 40_000, virtualCount: 3, max: 8, canJoin: true, canRead: true, canLeave: true }), 'read');
});

test('phòng trống: khách ảo vào phòng trước, chưa thể chat/like', () => {
  const r = seeded(5);
  for (let i = 0; i < 100; i++) assert.equal(chooseAction(r, { realAgo: Infinity, virtualCount: 0, max: 8, canJoin: true, canRead: true, canLeave: false }), 'join');
});

test('người thật hoạt động → nhịp chậm gấp đôi', () => {
  assert.ok(nextDelay('normal', 10_000, () => 0) === 2 * nextDelay('normal', Infinity, () => 0));
});

test('phân loại id: sim_ là người thật, auto_/bot_/demo_ là ảo', () => {
  assert.ok(isVirtualId('auto_x') && isVirtualId('bot_1') && isVirtualId('demo_2'));
  assert.ok(!isVirtualId('sim_An') && !isVirtualId('nguoi_that'));
});

test('chạy lâu: có vào/chat/like/rời, không bao giờ vượt autoPaceMax, tên có nhãn', () => {
  const x = rig();
  for (let i = 0; i < 400; i++) { x.pacer.step(); x.tick(10_000); assert.ok(x.viewers.size <= 8); }
  assert.ok(x.viewers.size > 0);
  for (const v of x.viewers.values()) assert.ok(v.name.startsWith('🎭 '), v.name);
  assert.ok(x.chats.length > 0 && x.sent.some(m => m.t === 'like') && x.sent.some(m => m.t === 'leave') && x.reads.length > 0);
});

test('khách ảo chỉ phát leave/like, không có quà/beer/follow', () => {
  const x = rig();
  for (let i = 0; i < 300; i++) { x.pacer.step(); x.tick(10_000); }
  assert.ok(x.sent.every(m => ['like', 'leave'].includes(m.t)), JSON.stringify([...new Set(x.sent.map(m => m.t))]));
});

test('người thật hoạt động → bước tiếp theo không làm gì', () => {
  const x = rig();
  for (let i = 0; i < 20; i++) { x.pacer.step(); x.tick(10_000); }
  const before = x.viewers.size, nChat = x.chats.length, nSent = x.sent.length;
  x.pacer.markReal('nguoi_that'); x.tick(2_000);
  for (let i = 0; i < 5; i++) x.pacer.step();
  assert.equal(x.viewers.size, before); assert.equal(x.chats.length, nChat); assert.equal(x.sent.length, nSent);
});

test('markReal bỏ qua id ảo', () => {
  const x = rig();
  x.pacer.markReal('auto_1'); x.pacer.markReal('bot_1');
  for (let i = 0; i < 3; i++) x.pacer.step();
  assert.ok(x.viewers.size > 0);
});

test('tắt autoPace → dọn hết khách ảo, giữ người thật', () => {
  const x = rig();
  for (let i = 0; i < 20; i++) { x.pacer.step(); x.tick(10_000); }
  x.viewers.set('sim_An', { id: 'sim_An', name: 'An', joinedAt: 0 });
  x.settings.autoPace = false; x.pacer.step();
  assert.deepEqual([...x.viewers.keys()], ['sim_An']);
});

test('câu bình luận không rỗng', () => { const r = seeded(2); for (let i = 0; i < 50; i++) assert.ok(pickLine(r).length > 1); });
