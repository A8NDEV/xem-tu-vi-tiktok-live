import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSteps, createStats, goalLine, GOAL_LINES, dayKey, daysBetween, touchFan, pruneFans, streakLine, STREAK_LINES, buildRecap } from './stats.mjs';

const mk = (over = {}) => {
  const reached = [], settings = { goalOn: true, goalLikes: '100,300,900', goalCoins: '10,50,200', ...over };
  return { reached, settings, s: createStats({ getSettings: () => settings, onReach: (...a) => reached.push(a) }) };
};

test('parseSteps: sắp tăng dần, bỏ trùng / không hợp lệ, tối đa 3, rỗng thì dùng mặc định', () => {
  assert.deepEqual(parseSteps('900, 100 ,300,300,abc,-5'), [100, 300, 900]);
  assert.deepEqual(parseSteps('1,2,3,4,5'), [1, 2, 3]);
  assert.deepEqual(parseSteps(''), [300, 1000, 3000]);
});

test('đạt mốc thì báo đúng một lần mỗi mốc, kèm tên người góp', () => {
  const { s, reached } = mk();
  s.addLikes(60, 'An'); assert.equal(reached.length, 0);
  s.addLikes(60, 'Bình'); assert.deepEqual(reached[0], ['tim', 1, 100, 3, 'Bình']);
  s.addLikes(5, 'C'); assert.equal(reached.length, 1);
});

test('một lượt góp lớn vượt nhiều mốc → báo từng mốc theo thứ tự', () => {
  const { s, reached } = mk();
  for (let i = 0; i < 4; i++) s.addCoins(100, 'X');   // 400 xu: qua mốc 10, 50, 200
  assert.deepEqual(reached.map(r => r[1]), [1, 2, 3]);
  assert.equal(s.goalView().coins.level, 3);
});

test('một sự kiện tim tối đa 100: số khổng lồ không làm thanh nhảy vọt', () => {
  const { s } = mk();
  s.addLikes(1_000_000, 'A'); assert.equal(s.totals().likes, 100);
});

test('tắt mục tiêu vẫn đếm số liệu nhưng không báo mốc; đặt lại thanh không xóa số comment', () => {
  const { s, reached, settings } = mk({ goalOn: false });
  s.addLikes(100, 'A'); s.addComment(); assert.equal(reached.length, 0); assert.equal(s.totals().likes, 100);
  settings.goalOn = true; s.resetGoals(); assert.equal(s.totals().likes, 0); assert.equal(s.totals().comments, 1);
});

test('goalView: mốc kế tiếp, mốc trước, mức đã đạt', () => {
  const { s } = mk(); s.addLikes(100, 'A'); s.addLikes(100, 'A');
  assert.deepEqual(s.goalView().likes, { cur: 200, prev: 100, next: 300, level: 1, total: 3 });
});

test('câu mốc cố định: đủ 6 câu, câu cuối mốc có "mốc cuối cùng"', () => {
  assert.equal(GOAL_LINES.length, 6);
  assert.match(goalLine('tim', 3, 3), /mốc cuối cùng/); assert.doesNotMatch(goalLine('xu', 1, 3), /cuối cùng/);
});

test('chuỗi ngày: ngày liền kề +1, bỏ ngày thì về 1, cùng ngày không đổi', () => {
  const fans = {}, d = n => new Date(2026, 10, n, 12).getTime();
  assert.equal(touchFan(fans, 'u', 'An', d(10)).streak, 1);
  assert.equal(touchFan(fans, 'u', 'An', d(10)).returning, false);
  const r = touchFan(fans, 'u', 'An', d(11)); assert.deepEqual([r.returning, r.streak], [true, 2]);
  assert.equal(touchFan(fans, 'u', 'An', d(12)).streak, 3);
  assert.equal(touchFan(fans, 'u', 'An', d(15)).streak, 1);
  assert.equal(fans.u.best, 3); assert.equal(fans.u.days, 4);
});

test('daysBetween qua ranh giới tháng / năm', () => {
  assert.equal(daysBetween('2026-11-30', '2026-12-01'), 1); assert.equal(daysBetween('2026-12-31', '2027-01-01'), 1);
  assert.match(dayKey(), /^\d{4}-\d{2}-\d{2}$/);
});

test('pruneFans giữ người mới nhất; câu chào chuỗi ngày hữu hạn (kẹp 2–30)', () => {
  const fans = { a: { last: '2026-01-01' }, b: { last: '2026-03-01' }, c: { last: '2026-02-01' } };
  pruneFans(fans, 2); assert.deepEqual(Object.keys(fans).sort(), ['b', 'c']);
  assert.equal(streakLine(99), streakLine(30)); assert.equal(streakLine(1), streakLine(2)); assert.equal(STREAK_LINES.length, 29);
});

test('tổng kết: chỉ người thật có công đức, top 3, thời lượng theo phút', () => {
  const r = buildRecap({
    totals: { likes: 10, comments: 5, follows: 2, coins: 99, readings: 4, topics: { 'Tài Lộc': 3, 'Tình Duyên': 1 } }, startedAt: 0, now: 90 * 60000,
    viewers: [{ name: 'A', beers: 50, real: true }, { name: 'Ảo', beers: 999, real: false }, { name: 'B', beers: 70, real: true }, { name: 'C', beers: 0, real: true }, { name: 'D', beers: 10, real: true }, { name: 'E', beers: 5, real: true }],
  });
  assert.deepEqual(r.donors.map(d => d.name), ['B', 'A', 'D']); assert.equal(r.minutes, 90);
  assert.deepEqual(r.topics[0], { name: 'Tài Lộc', n: 3 });
});
