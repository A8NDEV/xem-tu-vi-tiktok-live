// Thống kê buổi live: thanh mục tiêu chung (tim + kim cương), người xem quen (chuỗi ngày), tổng kết cuối buổi.
// Module thuần, mọi thứ chạm vào server đi qua tham số. Có test: stats.test.mjs.
// NGUYÊN TẮC: chỉ người thật được tính. Server không gọi các hàm này cho khách ảo (auto_ / bot_ / demo_).
import fs from 'node:fs';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const WORD = ['', 'một', 'hai', 'ba'];

/* ---------- mục tiêu chung ---------- */
export const DEFAULT_GOAL_LIKES = '300,1000,3000';
export const DEFAULT_GOAL_COINS = '50,200,600';
export function parseSteps(v, fallback = DEFAULT_GOAL_LIKES){
  const nums = [...new Set(String(v ?? '').split(/[\s,;]+/).map(Number).filter(n => Number.isFinite(n) && n > 0).map(Math.round))].sort((a, b) => a - b).slice(0, 3);
  return nums.length ? nums : parseSteps(fallback, '1');
}
// Lời Ông Đồ khi đạt mốc (câu cố định: server tạo sẵn giọng cho các câu này)
export const goalLine = (kind, level, total) =>
  `Mục tiêu ${kind === 'tim' ? 'thả tim' : 'dâng lộc'} của cả đền đã đạt mốc ${WORD[level] || level}${level >= total ? ', mốc cuối cùng' : ''}. Ông Đồ xin ban phúc cho toàn thể thiện tín!`;
export const GOAL_LINES = ['tim', 'xu'].flatMap(k => [1, 2, 3].map(l => goalLine(k, l, 3)));

export function createStats({ getSettings, onReach = () => {} }){
  const st = { likes: 0, coins: 0, comments: 0, follows: 0, readings: 0, likesDone: 0, coinsDone: 0, topics: {} };
  const steps = kind => parseSteps(kind === 'tim' ? getSettings().goalLikes : getSettings().goalCoins, kind === 'tim' ? DEFAULT_GOAL_LIKES : DEFAULT_GOAL_COINS);
  function check(kind, who){
    if (!getSettings().goalOn) return;
    const key = kind === 'tim' ? 'likes' : 'coins', doneKey = key + 'Done', s = steps(kind);
    while (st[doneKey] < s.length && st[key] >= s[st[doneKey]]) { st[doneKey]++; onReach(kind, st[doneKey], s[st[doneKey] - 1], s.length, who); }
  }
  const view = kind => {
    const key = kind === 'tim' ? 'likes' : 'coins', done = st[key + 'Done'], s = steps(kind);
    return { cur: st[key], prev: done ? s[done - 1] : 0, next: s[Math.min(done, s.length - 1)], level: done, total: s.length };
  };
  return {
    addLikes(n, who){ st.likes += clamp(Math.round(+n || 0), 0, 100); check('tim', who); },   // một sự kiện tối đa 100 tim: thanh không nhảy vọt bất thường
    addCoins(n, who){ st.coins += clamp(Math.round(+n || 0), 0, 100000); check('xu', who); },
    addComment(){ st.comments++; },
    addFollow(){ st.follows++; },
    addReading(topic){ st.readings++; if (topic) st.topics[topic] = (st.topics[topic] || 0) + 1; },
    resetGoals(){ st.likes = st.coins = st.likesDone = st.coinsDone = 0; },
    resetAll(){ Object.assign(st, { likes: 0, coins: 0, comments: 0, follows: 0, readings: 0, likesDone: 0, coinsDone: 0, topics: {} }); },
    totals: () => ({ likes: st.likes, coins: st.coins, comments: st.comments, follows: st.follows, readings: st.readings, topics: { ...st.topics } }),
    goalView: () => ({ on: !!getSettings().goalOn, likes: view('tim'), coins: view('xu') }),
  };
}

/* ---------- người xem quen ---------- */
export const dayKey = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const dayNum = k => { const [y, m, d] = k.split('-').map(Number); return Math.round(Date.UTC(y, m - 1, d) / 86400000); };
export const daysBetween = (a, b) => dayNum(b) - dayNum(a);

// Gọi khi người THẬT hoạt động lần đầu trong buổi. Trả về { fan, returning, streak } (returning = lần đầu của ngày hôm nay, đã từng đến).
export function touchFan(fans, id, name, now = Date.now()){
  const today = dayKey(now);
  let f = fans[id];
  if (!f) { f = fans[id] = { name, first: today, last: today, streak: 1, best: 1, days: 1, kc: 0, topic: '' }; return { fan: f, returning: false, streak: 1 }; }
  f.name = name;
  if (f.last === today) return { fan: f, returning: false, streak: f.streak };
  f.streak = daysBetween(f.last, today) === 1 ? f.streak + 1 : 1;
  f.best = Math.max(f.best, f.streak); f.days++; f.last = today;
  return { fan: f, returning: true, streak: f.streak };
}
export function pruneFans(fans, max = 5000){
  const ids = Object.keys(fans);
  if (ids.length <= max) return;
  ids.sort((a, b) => fans[a].last.localeCompare(fans[b].last));
  for (const id of ids.slice(0, ids.length - max)) delete fans[id];
}
export function createFanStore(file){
  let fans = {}, timer = null;
  try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); if (d && typeof d === 'object') fans = d; } catch { /* chưa có */ }
  return {
    fans: () => fans,
    save(){
      clearTimeout(timer);
      timer = setTimeout(() => { pruneFans(fans); try { fs.writeFileSync(file + '.tmp', JSON.stringify(fans)); fs.renameSync(file + '.tmp', file); } catch { /* đĩa lỗi: bỏ qua */ } }, 2000);
      timer.unref?.();
    },
  };
}
// Câu chào người quen: số ngày được kẹp 2–30 để kho câu cố định hữu hạn (đã tạo sẵn giọng)
export const streakLine = n => `Hữu duyên trở lại, hôm nay là ngày thứ ${clamp(n, 2, 30)} liên tiếp.`;
export const COMEBACK_LINE = 'Lâu rồi mới gặp lại, Ông Đồ mừng lắm.';
export const STREAK_LINES = Array.from({ length: 29 }, (_, i) => streakLine(i + 2));

/* ---------- tổng kết cuối buổi ---------- */
export const RECAP_THANKS = 'Buổi gieo quẻ hôm nay đến đây là hết. Ông Đồ cảm ơn toàn thể thiện tín đã ghé đền. Chúc mọi người bình an, phát đạt!';
export const RECAP_TOP_LINE = 'Công đức đứng đầu buổi hôm nay.';
// viewers: [{name, beers, real}]  → chỉ người thật có công đức
export function buildRecap({ totals, startedAt, now = Date.now(), viewers }){
  const donors = viewers.filter(v => v.real && v.beers > 0).sort((a, b) => b.beers - a.beers).slice(0, 3).map(v => ({ name: v.name, beers: v.beers }));
  const topics = Object.entries(totals.topics || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, n]) => ({ name, n }));
  return { minutes: Math.max(0, Math.round((now - startedAt) / 60000)), likes: totals.likes, comments: totals.comments, follows: totals.follows, coins: totals.coins, readings: totals.readings, donors, topics };
}
