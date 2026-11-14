// Khách ảo tự động giữ nhịp live (tham khảo Thắp Sáng: src/ingest/auto-pacing.mjs).
// Khác Thắp Sáng ở chỗ: KHÔNG giả quà / kim cương / follow. Khách ảo chỉ là nhân vật trong cảnh:
// vào phòng, bình luận xin quẻ, thả tim, được Ông Đồ gieo quẻ khai lộc MIỄN PHÍ (0 KC, không cộng công đức).
// Người thật có hoạt động → khách ảo tự nhường sóng (im hẳn rồi chậm lại).
// Module thuần: mọi thứ chạm vào server (viewers, seat, onChat…) đều đi qua `deps`, nên test được không cần mạng.

const rnd = (a, b, r = Math.random) => Math.floor(r() * (b - a + 1)) + a;
const pick = (arr, r = Math.random) => arr[Math.floor(r() * arr.length)];

export const isAutoId = id => String(id || '').startsWith('auto_');
// bot_ / demo_ / auto_ là người ảo; sim_ (gõ tay ở bảng điều khiển) và mọi id khác coi là người thật
export const isVirtualId = id => /^(auto|bot|demo)_/.test(String(id || ''));

const HO = ['Nguyễn', 'Trần', 'Lê', 'Phạm', 'Hoàng', 'Huỳnh', 'Phan', 'Vũ', 'Võ', 'Đặng', 'Bùi', 'Đỗ', 'Ngô', 'Lý', 'Đinh', 'Trịnh', 'Mai', 'Lâm'];
const TEN_NAM = ['Minh Khang', 'Quốc Bảo', 'Hoàng Nam', 'Tuấn Kiệt', 'Đức Anh', 'Thanh Tùng', 'Gia Huy', 'Nhật Minh', 'Xuân Trường', 'Minh Quân', 'Duy Mạnh', 'Tiến Dũng', 'Quang Hải', 'Việt Anh', 'Thái Sơn', 'Thành Long', 'Văn Đạt', 'Bảo Long', 'Đức Phúc', 'Hoàng Dũng'];
const TEN_NU = ['Thảo Vy', 'Hương Giang', 'Ngọc Ánh', 'Hải Yến', 'Quỳnh Như', 'Mỹ Duyên', 'Kim Chi', 'Bảo Ngọc', 'Phương Thảo', 'Thu Trang', 'Khánh Linh', 'Diệu Linh', 'Thùy Dung', 'Mai Phương', 'Hà My', 'Lan Anh', 'Ngọc Mai', 'Trúc Ly', 'Như Quỳnh', 'Minh Châu', 'Yến Nhi', 'Thanh Tâm'];
const NICK = ['Bé Bắp', 'Mèo Mập', 'Cậu Út', 'Cô Ba Sài Gòn', 'Long Ka', 'Bống Bống', 'Hà Nội Phố', 'Miền Tây Quê Tôi', 'Gió Mùa Thu', 'Gia Đình Nhỏ', 'Kem Dâu', 'Mây Lang Thang', 'Hoa Hướng Dương', 'Út Nhỏ', 'Chàng Khờ', 'Sơn Ca', 'Hạt Tiêu', 'Nhím Xù', 'Heo Con', 'Chú Bảy Cần Thơ', 'Chị Tư Hóc Môn', 'Cún Con', 'Nắng Ban Mai'];

export const NAME_MAX = 14;   // chừa chỗ cho nhãn "🎭 " vì server cắt tên ở 18 ký tự
export function makeName(rand = Math.random, taken = new Set()){
  for (let i = 0; i < 12; i++) {
    const r = rand();
    let n;
    if (r < .42) { const ten = pick(rand() < .5 ? TEN_NAM : TEN_NU, rand); n = `${pick(HO, rand)} ${ten}`; if (n.length > NAME_MAX) n = ten; }
    else if (r < .78) n = pick(NICK, rand);
    else n = `${pick([...TEN_NAM, ...TEN_NU], rand).split(' ').pop()}${rnd(90, 99, rand)}`;
    if (n.length > NAME_MAX) continue;   // bỏ tên dài thay vì cắt cụt giữa chữ
    if (!taken.has(n)) return n;
  }
  return `Thiện tín ${rnd(10, 99, rand)}`;
}

// Câu bình luận: chủ đề phải chứa từ khóa mà server nhận ra (topicFromText), kiểu dáng phải đúng SKIN_WORDS
const TOPIC_LINES = [
  'Khai lộc tình duyên thầy ơi!', 'Con xin quẻ tình duyên với ạ', 'Xem giúp con chuyện tình duyên với thầy',
  'Con xin quẻ tài lộc tháng này ạ', 'Xin quẻ tài lộc làm ăn thầy ơi', 'Buôn bán dạo này ế quá, xin quẻ tài lộc ạ',
  'Xin quẻ gia đạo bình an', 'Xem giúp con chuyện gia đình với ạ',
  'Xem giúp con đường sự nghiệp với ạ', 'Con sắp xin việc, thầy xem giúp quẻ sự nghiệp nha',
  'Xin quẻ sức khỏe cho ba mẹ con ạ', 'Cầu an cho cả nhà thầy ơi',
  'Xin quẻ vận mệnh năm nay ạ', 'Thầy gieo quẻ cho con với',
];
const CHEER_LINES = ['Nam mô hoan hỷ đại cát', 'Xin vía tài lộc đại cát', 'Quẻ thầy luận chuẩn quá ạ!', 'A di đà Phật, cầu an', 'Chúc cả phòng đại cát đại lợi', 'Vui quá, ai cũng may mắn nha'];
const SKIN_LINES = ['Công tử', 'Tiểu thư', 'Nam', 'Nữ', 'Ông già', 'Bà già'];
export function pickLine(rand = Math.random){
  const r = rand();
  if (r < .60) return pick(TOPIC_LINES, rand);
  if (r < .88) return pick(CHEER_LINES, rand);
  return pick(SKIN_LINES, rand);
}

export const SPEEDS = ['slow', 'normal', 'fast'];
const RANGE = { slow: [14000, 22000], normal: [7000, 12000], fast: [4000, 7000] };
export const REAL_QUIET_MS = 15_000;     // người thật vừa hoạt động trong 15 giây: khách ảo im hẳn
export const REAL_RECENT_MS = 90_000;    // trong 90 giây: chậm gấp đôi, không gieo quẻ miễn phí
export function nextDelay(speed, realAgo, rand = Math.random){
  const [a, b] = RANGE[speed] || RANGE.normal;
  return rnd(a, b, rand) * (realAgo < REAL_RECENT_MS ? 2 : 1);
}

// ctx: { realAgo, virtualCount, max, canJoin, canRead, canLeave }
export function chooseAction(rand, ctx){
  if (ctx.realAgo < REAL_QUIET_MS) return 'skip';
  const w = { chat: ctx.virtualCount ? 45 : 0, like: ctx.virtualCount ? 25 : 0, join: 0, leave: 0, read: 0 };
  if (ctx.canJoin && ctx.virtualCount < ctx.max) w.join = ctx.virtualCount < 2 ? 60 : 14;
  if (ctx.canLeave) w.leave = ctx.virtualCount > ctx.max ? 40 : 6;
  if (ctx.canRead && ctx.virtualCount && ctx.realAgo >= REAL_RECENT_MS) w.read = 12;
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (!total) return 'skip';
  let x = rand() * total;
  for (const [k, v] of Object.entries(w)) { if (x < v) return k; x -= v; }
  return 'skip';
}

const MIN_STAY_MS = 90_000;           // khách ảo ở lại ít nhất 90 giây trước khi rời
const READ_GAP_MS = 120_000;          // hai lần gieo quẻ miễn phí cách nhau tối thiểu 2 phút
const SEAT_LIMIT = 56;                // seat() của server đuổi người im lặng khi đầy 64 → chừa chỗ, không bao giờ đuổi người thật

/* deps: { getSettings, viewers: Map, seat(id,name,opts), onChat(id,name,text), broadcast(msg), addLog(s),
           readFree(v), busy(): boolean, now?, rand?, timers? }
   KHÔNG có hàm tặng quà trong deps: khách ảo không thể tạo quà / KC / follow, kể cả khi code sau này sai. */
export function createPacer(deps){
  const now = deps.now || Date.now, rand = deps.rand || Math.random;
  const setT = deps.setTimeout || setTimeout, clearT = deps.clearTimeout || clearTimeout;
  let running = false, timer = null, lastReal = 0, lastRead = 0, seq = 0;

  const autos = () => [...deps.viewers.values()].filter(v => isAutoId(v.id));
  const realSeated = () => [...deps.viewers.values()].filter(v => !isVirtualId(v.id)).length;
  const realAgo = () => (lastReal ? now() - lastReal : Infinity);

  function markReal(id){ if (id && !isVirtualId(id)) lastReal = now(); }

  function removeGuest(v){ deps.viewers.delete(v.id); deps.broadcast({ t: 'leave', id: v.id }); }
  function clearAll(){ for (const v of autos()) removeGuest(v); }

  function join(s){
    const taken = new Set([...deps.viewers.values()].map(v => v.name.replace(/^🎭\s*/u, '')));
    const name = makeName(rand, taken);
    const id = `auto_${now().toString(36)}_${++seq}`;
    const skin = pick(['man', 'woman', 'cap', 'sexy', 'uncle', 'oldwoman'], rand);
    const topic = pick(['Tình Duyên', 'Tài Lộc', 'Sự Nghiệp', 'Gia Đạo', 'Sức Khỏe', 'Vận Mệnh'], rand);
    deps.seat(id, (s.autoPaceLabel ? '🎭 ' : '') + name, { skin, topic });
  }

  function step(){
    const s = deps.getSettings();
    if (!s.autoPace) { if (autos().length) clearAll(); return 5000; }
    const ago = realAgo(), list = autos();
    const max = Math.max(0, s.autoPaceMax - Math.floor(realSeated() / 2));   // nhiều người thật → bớt khách ảo
    const old = list.filter(v => now() - v.joinedAt > MIN_STAY_MS);
    const action = chooseAction(rand, {
      realAgo: ago, virtualCount: list.length, max,
      canJoin: deps.viewers.size < SEAT_LIMIT,
      canLeave: old.length > 0 && (list.length > max || list.length > 2),
      canRead: s.autoPaceReadings && !deps.busy() && now() - lastRead > READ_GAP_MS,
    });
    const v = list.length ? pick(list, rand) : null;
    if (action === 'join') join(s);
    else if (action === 'leave') removeGuest(pick(old, rand));
    else if (action === 'chat' && v) deps.onChat(v.id, v.name, pickLine(rand));
    else if (action === 'like' && v) deps.broadcast({ t: 'like', id: v.id, n: rnd(1, 4, rand) });
    else if (action === 'read' && v) { lastRead = now(); deps.readFree(v); }
    return action === 'skip' ? rnd(6000, 10000, rand) : nextDelay(s.autoPaceSpeed, ago, rand);
  }

  function loop(){
    if (!running) return;
    let delay = 8000;
    try { delay = step(); } catch (e) { deps.addLog('Khách ảo lỗi: ' + (e?.message || e)); }
    timer = setT(loop, delay);
  }

  return {
    markReal, step, clearAll,
    isRunning: () => running,
    start(){ if (running) return; running = true; clearT(timer); timer = setT(loop, 3000); },
    stop(){ running = false; clearT(timer); timer = null; clearAll(); },
  };
}
