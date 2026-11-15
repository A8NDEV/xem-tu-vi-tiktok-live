import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import sharp from 'sharp';
import { createPacer, SPEEDS } from './auto-pace.mjs';
import { splitChunks, clipText } from './tts-text.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TTS_DIR = path.join(__dirname, 'tts');
fs.mkdirSync(TTS_DIR, { recursive: true });
for (const f of fs.readdirSync(TTS_DIR)) { try { fs.unlinkSync(path.join(TTS_DIR, f)); } catch {} }
const AVATAR_DIR = path.join(__dirname, 'avatar-cache');
fs.mkdirSync(AVATAR_DIR, { recursive: true });
const PORT = +process.env.PORT || 3000;

const settings = {
  title: 'Tử Vi Phát Đạt',
  subtitle: 'Gieo Quẻ Kinh Dịch · Luận Giải Nhân Duyên',
  voice: 'vi-VN-NamMinhNeural',
  pitch: -10,
  rate: -2,
  music: true, musicVolume: 48, musicTrack: '',
  sfx: true, ambience: true,
  autoToast: true, toastEveryMin: 3,
  seatMode: 'auto',
  autoSeatFollowers: true,
  phaseMode: 'auto',
  foodFrom: 6,
  beerFrom: 18,
  gifts: { readAll: true, minDiamonds: 1 },
  // khách ảo giữ nhịp (xem auto-pace.mjs): không giả quà / KC / follow, tự nhường sóng khi có người thật
  autoPace: true, autoPaceSpeed: 'normal', autoPaceMax: 8, autoPaceReadings: true, autoPaceLabel: true,
};

const viewers = new Map();
const startedAt = Date.now();
let totalBeers = 0;
let tiktok = null, tiktokConnecting = false, tiktokState = { status: 'idle', uniqueId: '', error: '' };
const seenEventIds = new Map();

function firstEvent(key){
  if (!key) return true;
  const now = Date.now();
  if (seenEventIds.has(key)) return false;
  seenEventIds.set(key, now);
  if (seenEventIds.size > 3000){
    for (const [k, t] of seenEventIds) if (now - t > 120_000) seenEventIds.delete(k);
  }
  return true;
}
const msgKey = (d, type) => {
  const id = d?.common?.msgId ?? d?.msgId ?? d?.messageId;
  return id ? `${type}:${id}` : '';
};

const log = [];
function addLog(s){
  const line = `[${new Date().toLocaleTimeString('vi-VN')}] ${s}`;
  log.push(line);
  if (log.length > 300) log.shift();
  broadcast({ t:'log', line }, 'control');
  console.log(line);
}

const AVATAR_HOSTS = /\.(tiktokcdn\.com|tiktokcdn-us\.com|tiktokcdn-eu\.com|tiktokcdn-asia\.com|ibytedtos\.com|byteimg\.com|tiktokv\.com)$/i;
const AVATAR_MAX_BYTES = 3 * 1024 * 1024, AVATAR_MAX_FILES = 400, AVATAR_SIZE = 160, AVATAR_CONCURRENCY = 4;
function avatarUrl(raw){
  const s = String(raw || '');
  if (s.length > 2048) return null;
  let u; try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || !AVATAR_HOSTS.test(u.hostname)) return null;
  return u;
}
let avatarActive = 0;
const avatarQueue = [];
function avatarSlot(){ return new Promise(resolve => { if (avatarActive < AVATAR_CONCURRENCY){ avatarActive++; resolve(); } else avatarQueue.push(resolve); }); }
function avatarFree(){ const next = avatarQueue.shift(); if (next) next(); else avatarActive--; }
async function downloadAvatar(url, depth = 0){
  const res = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(8000),
    headers: {
      'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
      'accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
    },
  });
  if (res.status >= 300 && res.status < 400){
    const loc = res.headers.get('location');
    if (!loc || depth >= 2) throw new Error('avatar redirect');
    const next = avatarUrl(new URL(loc, url).href);
    if (!next) throw new Error('avatar redirect host');
    return downloadAvatar(next.href, depth + 1);
  }
  if (!res.ok) throw new Error('avatar HTTP ' + res.status);
  if (!/^image\//i.test(res.headers.get('content-type') || '')) throw new Error('avatar not an image');
  if (+res.headers.get('content-length') > AVATAR_MAX_BYTES) throw new Error('avatar too large');
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > AVATAR_MAX_BYTES) throw new Error('avatar too large');
  return buf;
}
const avatarJobs = new Map();
let avatarPrunedAt = 0;
async function pruneAvatars(){
  if (Date.now() - avatarPrunedAt < 30_000) return;
  avatarPrunedAt = Date.now();
  const files = await fs.promises.readdir(AVATAR_DIR).catch(() => []);
  if (files.length <= AVATAR_MAX_FILES) return;
  const list = (await Promise.all(files.map(async f => {
    const st = await fs.promises.stat(path.join(AVATAR_DIR, f)).catch(() => null);
    return st ? { f, t: st.mtimeMs } : null;
  }))).filter(Boolean).sort((a, b) => a.t - b.t);
  for (const x of list.slice(0, list.length - AVATAR_MAX_FILES)) fs.promises.unlink(path.join(AVATAR_DIR, x.f)).catch(() => {});
}
async function buildAvatar(url, file){
  await avatarSlot();
  try {
    const raw = await downloadAvatar(url);
    const webp = await sharp(raw).rotate()
      .resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', withoutEnlargement: true })
      .webp({ quality: 82, effort: 4 }).toBuffer();
    const tmp = file + '.tmp';
    await fs.promises.writeFile(tmp, webp);
    await fs.promises.rename(tmp, file);
    pruneAvatars();
  } finally { avatarFree(); }
}
async function serveAvatar(req, res, rawUrl){
  const u = avatarUrl(rawUrl);
  if (!u){ res.writeHead(400).end('bad avatar url'); return; }
  const file = path.join(AVATAR_DIR, createHash('sha256').update(u.href).digest('hex').slice(0, 40) + '.webp');
  const send = size => {
    res.writeHead(200, { 'Content-Type': 'image/webp', 'Content-Length': String(size),
      'Cache-Control': 'private, max-age=31536000, immutable', 'X-Content-Type-Options': 'nosniff' });
    if (req.method === 'HEAD') res.end();
    else fs.createReadStream(file).pipe(res);
  };
  try { const st = await fs.promises.stat(file); if (st.isFile()){ send(st.size); return; } } catch {}
  let job = avatarJobs.get(file);
  if (!job){ job = buildAvatar(u.href, file).finally(() => avatarJobs.delete(file)); avatarJobs.set(file, job); }
  try { await job; } catch { res.writeHead(404).end('avatar unavailable'); return; }
  try { const st = await fs.promises.stat(file); send(st.size); } catch { res.writeHead(404).end('avatar unavailable'); }
}

const CAPS = [12, 24, 36, 48, 64];
function capacity(){
  const need = CAPS.find(c => viewers.size <= c) || 64;
  return settings.seatMode === 'auto' ? need : Math.max(+settings.seatMode, need);
}

const SKIN_LABEL = { man: 'nam', cap: 'công tử', woman: 'nữ', sexy: 'tiểu thư', uncle: 'ông già', oldwoman: 'bà già' };
const SKIN_WORDS = [
  [['man', 'cap'],        ['nam','anh','trai']],
  [['woman', 'sexy'],     ['nữ','nu','chị','chi','gái','gai','em','bé','be']],
  [['uncle'],             ['ông','ong','chú','chu','bác','bac','già','gia','cụ ông','cu ong','ông già']],
  [['oldwoman'],          ['bà','ba','má','ma','cụ bà','cu ba','bà già']],
  [['cap'],               ['công tử','cong tu','mũ','mu','nón','non','cap','khăn xếp']],
  [['sexy'],              ['tiểu thư','tieu thu','sexy','gợi cảm','áo dài','ao dai']],
  [['uncle', 'oldwoman'], ['cụ','cu']],
];
function pickSkin(list, current){
  if (list.length === 1) return list[0];
  const other = list.filter(s => s !== current);
  const pool = other.length ? other : list;
  return pool[Math.floor(Math.random() * pool.length)];
}
function skinFromText(t, current){
  const w = String(t).toLowerCase().normalize('NFC').replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!w || w.split(' ').length > 3) return null;
  for (const [skins, words] of SKIN_WORDS) if (words.some(k => w === k || w.startsWith(k + ' '))) return pickSkin(skins, current);
  return null;
}
const DEFAULT_SKINS = ['man', 'woman', 'cap', 'sexy', 'uncle', 'oldwoman'];

const MENU = [
  { id: 'khai_loc',    label: 'Khai Lộc',    coins: 1,   dur: 18, unit: 'quẻ ngắn',     icon: '🪙', desc: '1–9 KC · 18s' },
  { id: 'phuc_loc',    label: 'Phúc Lộc',    coins: 10,  dur: 25, unit: 'quẻ sâu',      icon: '📜', desc: '10–29 KC · 25s' },
  { id: 'thien_loc',   label: 'Thiên Lộc',   coins: 30,  dur: 35, unit: 'quẻ chi tiết', icon: '🔮', desc: '30–69 KC · 35s' },
  { id: 'long_phuong', label: 'Long Phượng', coins: 70,  dur: 48, unit: 'đại quẻ',      icon: '🐉', desc: '70–149 KC · 48s' },
  { id: 'thien_menh',  label: 'Thiên Mệnh',  coins: 150, dur: 65, unit: 'thiên mệnh',   icon: '👑', desc: '150+ KC · 65s' },
];

const TOPICS = [
  { id: 'tinh_duyen', label: 'Tình Duyên', icon: '💕', words: ['tinh duyen', 'tinh cam', 'nguoi yeu', 'vo chong', 'hon nhan', 'crush', 'duyen', 'ny', 'yeu', 'chia tay'] },
  { id: 'tai_loc',    label: 'Tài Lộc',    icon: '💰', words: ['tai loc', 'tien bac', 'loc', 'kinh doanh', 'buon ban', 'lam an', 'dau tu', 'tien', 'mua ban'] },
  { id: 'su_nghiep',  label: 'Sự Nghiệp',  icon: '📈', words: ['su nghiep', 'cong viec', 'cong danh', 'thi cu', 'hoc tap', 'thang tien', 'viec lam', 'xin viec'] },
  { id: 'gia_dao',    label: 'Gia Đạo',    icon: '🏡', words: ['gia dao', 'gia dinh', 'con cai', 'nha cua', 'cha me', 'xay nha', 'dat dai'] },
  { id: 'suc_khoe',   label: 'Sức Khỏe',   icon: '🌿', words: ['suc khoe', 'benh', 'cau an', 'binh an', 'tho'] },
  { id: 'tong_quan',  label: 'Vận Mệnh',   icon: '☯',  words: ['van menh', 'tong quan', 'tu vi', 'gieo que', 'xin que', 'xem que'] },
];

const HEXAGRAMS = [
  {
    num: 1, name: 'Thuần Càn', rank: 'Thượng Thượng Cát', changed: 'Thiên Phong Cấu',
    lines: [1, 1, 1, 1, 1, 1],
    verse: 'Rồng bay trên chín tầng mây, thời vận hanh thông vạn sự thành.',
    topics: {
      tinh_duyen: 'Nhân duyên sáng rõ, đôi bên tâm đầu ý hợp, người độc thân dễ gặp lương duyên cao quý.',
      tai_loc: 'Tài lộc vượng phát như rồng gặp mây, mưu sự lớn ắt thu về lộc dày.',
      su_nghiep: 'Công danh thăng tiến mạnh mẽ, được cấp trên trọng dụng, mở ra cơ hội dẫn đầu.',
      gia_dao: 'Gia môn hưng thịnh, trên dưới thuận hòa, đón tin vui từ người thân.',
      suc_khoe: 'Tinh thần sung mãn, dương khí dồi dào, bệnh tật tiêu trừ.',
      tong_quan: 'Nguyên hanh lợi trinh, vạn sự khởi đầu đều thuận buồm xuôi gió.',
    },
    advice: 'Giữ tâm khiêm cung giữa lúc thịnh vượng thì phúc lộc bền lâu.',
    lucky: { time: 'Tháng âm lịch tới và giờ Thìn, Ngọ', noble: 'Người tuổi Thìn, Thân, Tý', dir: 'Hướng Đông Nam, màu Vàng Kim và Đỏ' }
  },
  {
    num: 14, name: 'Hỏa Thiên Đại Hữu', rank: 'Đại Cát Vượng Tài', changed: 'Hỏa Phong Đỉnh',
    lines: [1, 1, 1, 1, 0, 1],
    verse: 'Mặt trời tỏa sáng giữa trời cao, phúc lộc đầy nhà vạn điều may.',
    topics: {
      tinh_duyen: 'Tình cảm nồng ấm, chân thành gắn kết, nhân duyên đơm hoa kết trái.',
      tai_loc: 'Đại hữu là có nhiều lộc lớn, tiền tài tụ về từ nhiều nguồn thuận lợi.',
      su_nghiep: 'Uy tín vang xa, hợp tác làm ăn gặp người đồng tâm hiệp lực.',
      gia_dao: 'Trong ấm ngoài êm, gia đình sung túc, con cháu hiếu thuận.',
      suc_khoe: 'Khí huyết lưu thông, thân tâm an lạc, gặp thầy gặp thuốc.',
      tong_quan: 'Thời vận đang độ rực rỡ, cầu tài đắc tài, cầu lộc đắc lộc.',
    },
    advice: 'Biết sẻ chia phước báu và hành thiện tích đức sẽ giữ được đại lộc.',
    lucky: { time: 'Trong 15 ngày tới và giờ Tỵ, Ngọ', noble: 'Người tuổi Ngọ, Dần, Tuất', dir: 'Hướng Nam, màu Đỏ Son và Cam Vàng' }
  },
  {
    num: 11, name: 'Địa Thiên Thái', rank: 'Thượng Cát · Hanh Thông', changed: 'Địa Trạch Lâm',
    lines: [1, 1, 1, 0, 0, 0],
    verse: 'Trời đất giao hòa muôn vật sinh sôi, tiểu vãng đại lai phúc lộc về.',
    topics: {
      tinh_duyen: 'Đôi lứa hòa hợp như đất với trời, hiểu lầm hóa giải, tình duyên bền chặt.',
      tai_loc: 'Bế tắc đã qua, vận may tài chính mở rộng, buôn may bán đắt.',
      su_nghiep: 'Mọi kế hoạch đang ấp ủ đều gặp thiên thời địa lợi nhân hòa.',
      gia_dao: 'Gia đạo bình an, tiếng cười ngập tràn, đón hỷ sự trong nhà.',
      suc_khoe: 'Âm dương cân bằng, cơ thể hồi phục nhanh chóng.',
      tong_quan: 'Cái nhỏ đi qua, cái lớn đang tới, vận trình chuyển mình rực rỡ.',
    },
    advice: 'Nắm bắt thời cơ ngay khi vận mở, chớ chần chừ bỏ lỡ cơ duyên.',
    lucky: { time: 'Đầu tháng âm lịch và giờ Mão, Thìn', noble: 'Người tuổi Sửu, Mùi, Thìn', dir: 'Hướng Đông Bắc, màu Vàng Đất và Xanh Ngọc' }
  },
  {
    num: 22, name: 'Sơn Hỏa Bí', rank: 'Bình Hòa · Cát Tường', changed: 'Địa Hỏa Minh Di',
    lines: [1, 0, 1, 0, 0, 1],
    verse: 'Ánh lửa soi sáng chân núi, văn vẻ rạng ngời, việc nhỏ hanh thông.',
    topics: {
      tinh_duyen: 'Duyên lành đến từ sự chân thành, đừng chỉ nhìn vẻ hào nhoáng bên ngoài.',
      tai_loc: 'Lộc đến đều đặn, thích hợp củng cố nền tảng hơn là mạo hiểm lớn.',
      su_nghiep: 'Danh tiếng và tài năng được ghi nhận, thuận lợi cho giấy tờ, thi cử.',
      gia_dao: 'Nhà cửa trang hoàng ấm cúng, gia đình hòa thuận yên vui.',
      suc_khoe: 'Chú ý nghỉ ngơi điều độ, giữ tâm thanh tịnh tránh lo âu.',
      tong_quan: 'Quẻ chủ về sự tốt đẹp, sáng sủa, làm việc có kế hoạch ắt thành.',
    },
    advice: 'Lấy sự chân thật làm gốc, văn chất hài hòa thì phúc tự tìm đến.',
    lucky: { time: 'Cuối tuần này và giờ Dần, Ngọ', noble: 'Người tuổi Dần, Ngọ, Hợi', dir: 'Hướng Đông, màu Trắng Kem và Đỏ Đô' }
  },
  {
    num: 15, name: 'Địa Sơn Khiêm', rank: 'Lục Hào Giai Cát', changed: 'Địa Hỏa Minh Di',
    lines: [0, 0, 1, 0, 0, 0],
    verse: 'Núi cao ẩn mình trong lòng đất, người khiêm nhường ắt được trời ban phúc.',
    topics: {
      tinh_duyen: 'Nhường nhịn và thấu hiểu giúp tình yêu vượt qua mọi thử thách, kết thành đôi.',
      tai_loc: 'Tài lộc tích tụ bền vững, càng khiêm tốn làm ăn càng thu lợi lớn.',
      su_nghiep: 'Được lòng cả cấp trên lẫn đồng nghiệp, quý nhân âm thầm nâng đỡ.',
      gia_dao: 'Gia phong lễ nghĩa, phúc đức tổ tiên che chở cho cả nhà.',
      suc_khoe: 'Bình an vô sự, tâm an thì vạn bệnh lùi xa.',
      tong_quan: 'Trong 64 quẻ Kinh Dịch, chỉ duy nhất quẻ Khiêm cả 6 hào đều tốt lành.',
    },
    advice: 'Lùi một bước biển rộng trời cao, mềm mỏng ắt thắng cứng rắn.',
    lucky: { time: 'Mọi khung giờ hoàng đạo trong tháng', noble: 'Người lớn tuổi trong gia đình', dir: 'Hướng Tây Nam, màu Nâu Vàng và Trắng' }
  },
  {
    num: 31, name: 'Trạch Sơn Hàm', rank: 'Đại Cát Nhân Duyên', changed: 'Trạch Hỏa Cách',
    lines: [0, 0, 1, 1, 1, 0],
    verse: 'Núi đầm giao cảm, tâm linh tương thông, hữu duyên thiên lý năng tương ngộ.',
    topics: {
      tinh_duyen: 'Quẻ thượng cát về tình duyên! Đôi bên rung động chân thành, sớm có tin vui cưới hỏi hoặc tỏ tình.',
      tai_loc: 'Hợp tác ăn ý sinh tài lộc, khách hàng quý mến tìm đến.',
      su_nghiep: 'Giao tiếp thuận lợi, ký kết hợp đồng hay thương thảo đều suôn sẻ.',
      gia_dao: 'Vợ chồng đồng lòng, gia đình gắn kết yêu thương.',
      suc_khoe: 'Tâm trạng phấn chấn, tinh thần vui vẻ giúp cơ thể khỏe khoắn.',
      tong_quan: 'Vạn vật cảm ứng bằng chữ Tâm, cầu duyên đắc duyên, cầu hợp tác ắt thành.',
    },
    advice: 'Mở lòng đón nhận thiện ý, lắng nghe trực giác mách bảo.',
    lucky: { time: 'Rằm và mùng 1 âm lịch, giờ Dậu, Tuất', noble: 'Người tuổi Dậu, Sửu', dir: 'Hướng Tây, màu Hồng Sen và Vàng Ánh Kim' }
  },
  {
    num: 50, name: 'Hỏa Phong Đỉnh', rank: 'Thượng Cát · Đổi Mới', changed: 'Hỏa Thiên Đại Hữu',
    lines: [0, 1, 1, 1, 0, 1],
    verse: 'Vạc vàng luyện ngọc, rũ bỏ cái cũ đón vận mới huy hoàng.',
    topics: {
      tinh_duyen: 'Mối quan hệ bước sang trang mới vững chắc, chín chắn và sâu sắc hơn.',
      tai_loc: 'Đầu tư đúng hướng, tài lộc chín muồi, thu hoạch thành quả xứng đáng.',
      su_nghiep: 'Vững vàng như chân vạc, khẳng định vị thế và bản lĩnh vững chắc.',
      gia_dao: 'Gia đình sung túc, bếp lửa luôn ấm, đón thêm tài sản mới.',
      suc_khoe: 'Bồi bổ đúng cách giúp sức khỏe dồi dào, tràn đầy sinh lực.',
      tong_quan: 'Cơ hội chuyển mình lên tầm cao mới, quý nhân trao quyền trợ lực.',
    },
    advice: 'Giữ chữ Tín và sự kiên định như vạc đồng ba chân thì đại sự tất thành.',
    lucky: { time: 'Tháng tới và giờ Tỵ, Mùi', noble: 'Người tuổi Mão, Ngọ, Mùi', dir: 'Hướng Nam, màu Đỏ và Xanh Lá' }
  },
  {
    num: 42, name: 'Phong Lôi Ích', rank: 'Thượng Cát · Tăng Phúc', changed: 'Phong Hỏa Gia Nhân',
    lines: [1, 0, 0, 0, 1, 1],
    verse: 'Gió sấm tương trợ, mưa thuận gió hòa, làm một hưởng mười.',
    topics: {
      tinh_duyen: 'Tình cảm ngày càng gắn bó, đôi bên cùng nâng đỡ nhau tiến bộ.',
      tai_loc: 'Quẻ Ích chủ về thêm lộc thêm tài, lợi nhuận gia tăng vượt kỳ vọng.',
      su_nghiep: 'Thời cơ bứt phá đã điểm, mạnh dạn khởi sự hoặc mở rộng quy mô.',
      gia_dao: 'Thêm người thêm của, phúc khí tràn đầy trong gia quyến.',
      suc_khoe: 'Sức khỏe chuyển biến tích cực, tinh thần minh mẫn.',
      tong_quan: 'Thiên thời đang ủng hộ, tiến hành việc lớn hay nhỏ đều có lợi.',
    },
    advice: 'Thấy việc thiện nên làm ngay, thấy điều chưa chuẩn kịp thời sửa đổi.',
    lucky: { time: 'Trong 10 ngày tới và giờ Mão, Thìn', noble: 'Người tuổi Thìn, Tỵ, Dần', dir: 'Hướng Đông, màu Xanh Ngọc và Vàng' }
  },
];

const normGift = s => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ').trim();

function topicFromText(raw){
  const s = normGift(raw);
  if (!s) return null;
  for (const tp of TOPICS){
    if (tp.words.some(w => s.includes(w))) return tp;
  }
  return null;
}

function tierFromCoins(coins){
  const n = Math.max(1, Math.floor(coins || 1));
  if (n >= 150) return MENU[4];
  if (n >= 70) return MENU[3];
  if (n >= 30) return MENU[2];
  if (n >= 10) return MENU[1];
  return MENU[0];
}

function orderFromCoins(coins, topicLabel){
  const n = Math.max(1, Math.floor(coins || 1));
  const tier = tierFromCoins(n);
  const tp = topicLabel || 'Vận Mệnh';
  return {
    tierId: tier.id,
    tierLabel: tier.label,
    dur: tier.dur,
    icon: tier.icon,
    coins: n,
    topic: tp,
    text: `${tier.label} (${tp})`,
    label: `${tier.icon} ${tier.label.toUpperCase()}`,
  };
}

// Lời đọc của một quẻ. Mỗi câu độc lập với câu bên cạnh (dùng dấu phẩy thay dấu hai chấm) để tạo sẵn / dùng lại giọng đọc được.
function composeReading(h, topicId, tierId, moving){
  const topic = (TOPICS.find(x => x.id === topicId) || TOPICS[5]).label.toLowerCase();
  let t = `Quẻ số ${h.num}, ${h.name}, ${h.rank}. ${h.verse} Luận về ${topic}, ${h.topics[topicId]}`;
  if (tierId !== 'khai_loc') t += ` Động tại hào ${moving}, biến sang quẻ ${h.changed}. Lời khuyên của Ông Đồ, ${h.advice}`;
  if (tierId === 'thien_loc' || tierId === 'long_phuong' || tierId === 'thien_menh') t += ` Thời điểm thuận lợi, ${h.lucky.time}.`;
  if (tierId === 'long_phuong' || tierId === 'thien_menh') t += ` Quý nhân phù trợ, ${h.lucky.noble}. Hướng và màu hợp, ${h.lucky.dir}.`;
  return t;
}
let hexSeq = 0;
function buildHexagram(topicId = 'tong_quan', tierId = 'khai_loc'){
  const h = HEXAGRAMS[(hexSeq++ + Math.floor(Math.random() * HEXAGRAMS.length)) % HEXAGRAMS.length];
  const moving = 1 + (Math.floor(Math.random() * 6));
  const coins = [0, 1, 2].map(() => (Math.random() < 0.58 ? 1 : 0));
  const tpKey = h.topics[topicId] ? topicId : 'tong_quan';
  const topicObj = TOPICS.find(x => x.id === tpKey) || TOPICS[5];
  const mainText = h.topics[tpKey];
  const fullReading = composeReading(h, tpKey, tierId, moving);
  return {
    num: h.num,
    name: h.name,
    rank: h.rank,
    changed: h.changed,
    lines: h.lines,
    moving,
    coins,
    verse: h.verse,
    topicId: tpKey,
    topicLabel: topicObj.label,
    mainText,
    advice: h.advice,
    lucky: h.lucky,
    fullReading,
  };
}

const readingQueue = [];
let activeReading = null;
let readingTimer = null;

function pub(v){
  return {
    id: v.id, name: v.name, skin: v.skin, avatar: v.avatar || '',
    beers: v.beers, followed: !!v.followed, demo: !!v.demo,
    topic: v.topic || 'Vận Mệnh', asked: !!v.asked,
  };
}
function snapshot(){
  return {
    t: 'state', settings, viewers: [...viewers.values()].map(pub),
    cap: capacity(), startedAt, tiktok: tiktokState, barBeers: totalBeers,
    menu: MENU, queue: readingQueue.slice(0, 8), activeReading,
  };
}

// Mỗi quẻ có giọng đọc riêng, tạo sẵn ngay lúc xếp hàng (voiceOf) để tới lượt là có tiếng liền.
// Thẻ quẻ chỉ hiện khi tiếng sắp phát và giữ đến hết câu đọc, nên chữ và tiếng luôn khớp nhau.
const voiceOf = new WeakMap();
async function pumpQueue(){
  if (activeReading || !readingQueue.length) return;
  const item = activeReading = readingQueue.shift();
  const v = viewers.get(item.id);
  if (v) v.asked = true;
  const sp = voiceOf.get(item);
  let secs = 0, shownAt = Date.now();
  try {
    if (sp){
      const lead = Math.min(8000, voiceFreeAt - Date.now());   // overlay còn đang đọc câu khác → chờ đúng lúc
      if (lead > 0) await sleep(lead);
      await Promise.race([sp.first, sleep(6000)]);             // đoạn đầu sẵn sàng (tối đa 6 giây)
      if (activeReading !== item) return;                      // phòng đã bị làm trống trong lúc chờ
    }
    broadcast({ t: 'reading', activeReading: item, queue: readingQueue.slice(0, 8) });
    shownAt = Date.now();
    if (sp) secs = await emitSpeech(sp, { tag: 'reading', id: item.id });
  } catch (e) { addLog('Đọc quẻ lỗi: ' + (e?.message || e)); }
  if (activeReading !== item) return;
  const tierMs = Math.max(7000, Math.min(22000, (item.dur || 18) * 550));
  const durMs = Math.min(70000, Math.max(tierMs, secs * 1000 + 1500));   // thẻ ở lại tới khi đọc xong
  clearTimeout(readingTimer);
  readingTimer = setTimeout(() => {
    activeReading = null;
    broadcast({ t: 'reading', activeReading: null, queue: readingQueue.slice(0, 8) });
    setTimeout(pumpQueue, 600);
  }, Math.max(500, durMs - (Date.now() - shownAt)));
}

function enqueueReading(v, order, hex, voiceText = ''){
  const item = {
    id: v.id,
    name: v.name,
    avatar: v.avatar || '',
    skin: v.skin,
    tierId: order.tierId,
    tierLabel: order.tierLabel,
    topic: hex.topicLabel,
    coins: order.coins,
    dur: order.dur,
    hex,
    at: Date.now(),
  };
  if (voiceText) voiceOf.set(item, speak(clipText(voiceText, 900)));
  if (readingQueue.length < 20) readingQueue.push(item);
  broadcast({ t: 'queue', queue: readingQueue.slice(0, 8), activeReading });
  pumpQueue();
  return item;
}

function seat(id, name, opts = {}){
  let v = viewers.get(id);
  if (v){
    v.lastAt = Date.now();
    if (opts.avatar) v.avatar = opts.avatar;
    if (opts.followed) v.followed = true;
    if (opts.topic) v.topic = opts.topic;
    return { v, isNew: false };
  }
  if (viewers.size >= 64){
    const quiet = [...viewers.values()].filter(x => x.beers === 0).sort((a,b) => a.lastAt - b.lastAt)[0];
    if (!quiet) return { v: null, isNew: false };
    viewers.delete(quiet.id); broadcast({ t: 'leave', id: quiet.id });
  }
  v = {
    id, name: (name || id).slice(0, 18),
    skin: opts.skin || DEFAULT_SKINS[viewers.size % DEFAULT_SKINS.length],
    avatar: opts.avatar || '', beers: 0, followed: !!opts.followed,
    topic: opts.topic || 'Vận Mệnh', asked: false,
    joinedAt: Date.now(), lastAt: Date.now(), demo: !!opts.demo,
  };
  viewers.set(id, v);
  broadcast({ t: 'join', v: pub(v), cap: capacity() });
  if (!opts.demo && !/^(auto|bot|demo)_/.test(id)) prefetchName(v.name);
  return { v, isNew: true };
}

const chatMemo = new Map();
const followerIds = new Set();
function rememberChat(id, text){
  if (!id) return;
  if (chatMemo.size > 500) chatMemo.clear();
  chatMemo.set(id, { text, at: Date.now() });
}
const isCheer = t => /(^|\s)(nam\s*mo|cau\s*an|xin\s*que|khai\s*loc|hoan\s*hy|dai\s*cat|a\s*di\s*da)(\s|$|[!.,])/iu.test(normGift(t));

function onChat(id, name, text, avatar){
  pacer.markReal(id);
  if (!/^(auto|bot|demo)_/.test(String(id || ''))) prefetchName(name);
  text = String(text || '').slice(0, 120);
  rememberChat(id, text);
  const v = viewers.get(id);
  if (!v) return;
  v.lastAt = Date.now();
  if (avatar) v.avatar = avatar;
  v.lastText = text; v.lastTextAt = Date.now();
  const want = skinFromText(text, v.skin);
  if (want && want !== v.skin){
    v.skin = want;
    broadcast({ t: 'skin', id, skin: want });
    addLog(`🎭 ${v.name} đổi sang dáng ${SKIN_LABEL[want] || want}`);
  }
  const tp = topicFromText(text);
  if (tp) {
    v.topic = tp.label;
    v.topicId = tp.id;
    broadcast({ t: 'topic', id, topic: tp.label });
  }
  broadcast({ t: 'chat', id, name: v.name, text, topic: v.topic });
  if (isCheer(text)){
    broadcast({ t: 'cheer', id, name: v.name });
    addLog(`🙏 ${v.name} chắp tay cầu an · ${v.topic}`);
  }
}

function onFollow(id, name, avatar){
  if (!id) return;
  pacer.markReal(id);
  if (followerIds.size > 5000) followerIds.clear();
  followerIds.add(id);
  const { v } = seat(id, name, { avatar, followed: true });
  const who = v?.name || String(name || 'thiện tín').slice(0, 18);
  broadcast({ t: 'follow', id, name: who });
  addLog(`☯ ${who} vào phòng Tử Vi Phát Đạt`);
  say(`Thí chủ ${spoken(who)}. ${WELCOME_LINE}`, { tag: 'follow', id });
}

const ROSE_GIFTS = new Set(['hoa hong', 'rose', 'hong', 'khai loc']);
const DICE_GIFTS = new Set(['co bon la', 'shamrock', 'xuc xac', 'dice', 'xin xam', 'ong xam']);
const isFollower = u => Number(u?.followInfo?.followStatus ?? 0) >= 1 || u?.isFollower === true;

function onGift(id, name, giftName, count, diamonds, avatar, followed){
  pacer.markReal(id);
  giftName = String(giftName || 'lộc').slice(0, 30);
  count = Math.max(1, Math.min(9999, +count || 1));
  const { v } = seat(id, name, { avatar, followed });
  if (!v) return;
  if (followed) followerIds.add(id);
  const beers = Math.max(1, Math.min(999, (diamonds || 1) * (count || 1)));
  v.beers += beers; totalBeers += beers;
  v.asked = true;

  const memo = chatMemo.get(id);
  const tpFromGift = topicFromText(giftName) || (memo && topicFromText(memo.text));
  if (tpFromGift) {
    v.topic = tpFromGift.label;
    v.topicId = tpFromGift.id;
  }
  const order = orderFromCoins(beers, v.topic);
  const hex = buildHexagram(v.topicId || 'tong_quan', order.tierId);
  const key = normGift(giftName);
  const rose = ROSE_GIFTS.has(key) || key.startsWith('hoa hong');
  const diceGift = DICE_GIFTS.has(key);
  const kind = rose ? 'rose' : beers >= 30 ? 'tower' : 'beer';
  const tier = beers >= 70 ? 3 : beers >= 10 ? 2 : 1;

  if (diceGift){
    rollDiceFor(v, giftName, 0);
    return;
  }

  const line = `Thí chủ ${spoken(v.name)}. Ông Đồ xin gieo quẻ ${order.tierLabel}. ${hex.fullReading}`;
  enqueueReading(v, order, hex, settings.gifts.readAll || beers >= settings.gifts.minDiamonds ? line : '');
  broadcast({
    t: 'beer', id, name: v.name, giftName, beers, total: v.beers,
    barBeers: totalBeers, tier, kind, card: true, order, hex,
  });
  addLog(`☯ ${v.name} gieo ${order.text} (${beers} KC) → Quẻ số ${hex.num} ${hex.name}`);
}

const WELCOME_LINE = 'Hoan hỷ chào đón người hữu duyên bước vào phòng Tử Vi Phát Đạt. Mời ngồi lên chiếu đỏ và bình luận chủ đề muốn gieo quẻ!';
const spoken = s => String(s).replace(/[_@.]+/g, ' ').replace(/[^\p{L}\p{N}\s]/gu, '').trim() || 'thiện tín';

const CHALLENGES = [
  'Tháng này xuất hành hướng Đông Nam ắt gặp quý nhân.',
  'Giữ tâm hoan hỷ, mỉm cười đón lộc vào nhà.',
  'Làm một việc thiện nhỏ trong tuần này để kích hoạt đại vận.',
  'Tránh nóng vội vào khung giờ Ngọ, mềm mỏng ắt thành công.',
  'Màu đỏ son và vàng ánh kim sẽ mang lại may mắn cho bạn.',
  'Cơ hội tài lộc đang đến gần, hãy chuẩn bị sẵn sàng đón nhận.',
  'Người bạn đang nghĩ tới cũng đang dành thiện cảm cho bạn.',
  'Gia đạo bình an, sắp có tin vui từ phương xa gửi về.',
];
function rollDiceFor(v, giftName = 'Xin Xâm', base = 0){
  if (!v) return;
  const dice = [1, 2, 3].map(() => 1 + Math.floor(Math.random() * 6));
  const sum = dice.reduce((a, b) => a + b, 0);
  let label, cls, bonus;
  if (dice[0] === dice[1] && dice[1] === dice[2]){ label = 'THƯỢNG THƯỢNG CÁT!'; cls = 'bao'; bonus = 3; }
  else if (sum >= 14){ label = 'ĐẠI CÁT · VƯỢNG LỘC'; cls = 'lon'; bonus = 2; }
  else if (sum >= 9){ label = 'THƯỢNG CÁT · BÌNH AN'; cls = 'thuong'; bonus = 1; }
  else { label = 'TRUNG BÌNH · TĨNH TÂM'; cls = 'nho'; bonus = 1; }
  const gained = Math.max(0, base) + bonus;
  if (gained){ v.beers += gained; totalBeers += gained; }
  v.asked = true;
  const challenge = CHALLENGES[Math.floor(Math.random() * CHALLENGES.length)];
  const hex = buildHexagram(v.topicId || 'tong_quan', 'phuc_loc');
  enqueueReading(v, orderFromCoins(Math.max(10, v.beers), v.topic), hex);
  broadcast({
    t: 'dice', id: v.id, viewer: v.name, giftName, dice, sum, label, class: cls,
    bonus, gained, challenge, total: v.beers, barBeers: totalBeers, hex,
  });
  addLog(`🎋 ${v.name} xin xâm số ${sum} · ${label} (+${bonus} công đức, tổng ${v.beers} KC)`);
  say(`Thí chủ ${spoken(v.name)}. Ông Đồ lắc ống xâm, rút được thẻ xâm số ${sum}, quẻ ${label}. ${challenge} Cộng thêm ${bonus} điểm công đức. Chúc thí chủ vạn sự cát tường!`, { tag: 'dice', id: v.id });
  if (cls === 'bao') broadcast({ t: 'toast', text: 'THƯỢNG THƯỢNG CÁT!', sub: `${v.name} rút được thẻ xâm Đại Cát` });
}

const ttsQueue = []; let ttsBusy = false, ttsSeq = 0;
const TTS_IDLE_MS = 5 * 60_000, TTS_TIMEOUT_MS = 20_000;
const TTS_EDGE_PAUSE_MS = 30_000, TTS_CACHE_MAX = 300;
const TTS_FAMILY = process.env.TTS_IP_FAMILY === '6' ? 6 : process.env.TTS_IP_FAMILY === '0' ? 0 : 4;
const ttsAgent = new https.Agent({ keepAlive: true, family: TTS_FAMILY });
let tts = null, ttsIdleTimer = null, ttsEdgeDownUntil = 0, edgeFails = 0;
const ttsCache = new Map();
// Bộ nhớ đệm giọng Edge trên đĩa: câu đã đọc một lần thì lần sau (kể cả sau khi mở lại server) có tiếng ngay,
// vì Edge chậm và hay trả rỗng với câu mới nhưng xong trong ~0,5 giây với câu cũ. Quẻ miễn phí cho khách ảo lúc vắng cũng làm đầy dần kho này.
const TTS_CACHE_DIR = path.join(__dirname, 'tts-cache'), TTS_DISK_MAX = 4000;
fs.mkdirSync(TTS_CACHE_DIR, { recursive: true });
try {
  const files = fs.readdirSync(TTS_CACHE_DIR).map(f => ({ f, t: fs.statSync(path.join(TTS_CACHE_DIR, f)).mtimeMs })).sort((a, b) => a.t - b.t);
  for (const { f } of files.slice(0, Math.max(0, files.length - TTS_DISK_MAX))) fs.unlinkSync(path.join(TTS_CACHE_DIR, f));
} catch {}
const diskFile = key => path.join(TTS_CACHE_DIR, createHash('sha1').update(key).digest('hex') + '.mp3');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ttsEngine = () => settings.voice === 'google' ? 'google' : 'edge';
function cacheKey(engine, text){ return `${engine}|${text}`; }
function cacheGet(key){
  const hit = ttsCache.get(key); if (!hit) return null;
  ttsCache.delete(key); ttsCache.set(key, hit);
  return hit;
}
function cachePut(key, audio){
  ttsCache.set(key, audio);
  while (ttsCache.size > TTS_CACHE_MAX) ttsCache.delete(ttsCache.keys().next().value);
}
function ttsClient(){
  clearTimeout(ttsIdleTimer); ttsIdleTimer = null;
  if (!tts) tts = new MsEdgeTTS({ synthesisTimeoutMs: TTS_TIMEOUT_MS, agent: ttsAgent });
  return tts;
}
function closeTTS(){
  clearTimeout(ttsIdleTimer); ttsIdleTimer = null;
  const old = tts; tts = null;
  if (old) try { old.close(); } catch {}
}
function scheduleTTSIdle(){
  clearTimeout(ttsIdleTimer);
  ttsIdleTimer = setTimeout(() => { if (!ttsBusy && !ttsQueue.length) closeTTS(); }, TTS_IDLE_MS);
}
function esc(s){ return String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c])); }
function say(text, meta = {}){
  const s = clipText(String(text).trim(), 600);
  if (!s) return;
  if (ttsQueue.length >= 15) { addLog('Hàng đợi giọng đọc đầy, bỏ qua 1 câu'); return; }
  ttsQueue.push({ sp: speak(s), meta }); pumpTTS();   // tạo giọng ngay lúc xếp hàng, tới lượt là có sẵn
}
const TOAST_LINE = 'Ông Đồ chúc toàn thể thiện tín trong phòng tâm an vạn sự lành, cầu tài đắc tài, cầu duyên đắc duyên!';
async function warmTTS(){
  if (ttsEngine() === 'google') return;
  if (await findPython()){ startWorker(); return; }   // nạp sẵn worker Python
  try {
    await ttsClient().setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    if (!ttsBusy) scheduleTTSIdle();
  } catch (e) {
    closeTTS();
  }
}
// Giọng Nam Minh qua gói Python edge-tts (giống dự án Thắp Sáng). Một worker Python chạy thường trực: nạp edge_tts
// một lần (~1,1 giây) thay vì mỗi câu một tiến trình, và tự gửi dự phòng song song khi Edge trả rỗng / treo (xem edge_say.py).
// Máy không có Python + edge-tts → dùng thư viện Node msedge-tts như cũ. Đặt PYTHON_BIN nếu python không nằm trong PATH.
const SAY_PY = path.join(__dirname, 'edge_say.py');
let pyBin = null, pyChecked = false;
async function findPython(){
  if (pyChecked) return pyBin;
  pyChecked = true;
  for (const bin of [...new Set([process.env.PYTHON_BIN, 'python', 'py'].filter(Boolean))]){
    const ver = await new Promise(r => execFile(bin, ['-c', 'import edge_tts;print(edge_tts.__version__)'], { windowsHide: true, timeout: 15000 }, (err, out) => r(err ? null : String(out).trim())));
    if (ver){ pyBin = bin; addLog(`Giọng Edge qua Python edge-tts ${ver} (${bin})`); return pyBin; }
  }
  addLog('Không thấy Python + edge-tts, dùng thư viện Node (kém ổn định hơn). Cài: pip install -U edge-tts');
  return null;
}
let pyWorker = null, pyReq = 0;
const pyPending = new Map();
function startWorker(){
  if (pyWorker) return pyWorker;
  const child = spawn(pyBin, [SAY_PY, '--serve'], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const dead = () => {
    if (pyWorker === child) pyWorker = null;
    for (const [id, p] of pyPending) if (p.child === child){
      pyPending.delete(id); clearTimeout(p.timer);
      p.reject(Object.assign(new Error('worker Python đã dừng'), { workerDied: true }));
    }
  };
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let m; try { m = JSON.parse(line); } catch { return; }
    const p = pyPending.get(m.id); if (!p) return;
    pyPending.delete(m.id); clearTimeout(p.timer);
    if (m.ok) p.resolve(Buffer.from(m.audio, 'base64')); else p.reject(new Error(String(m.err || 'Edge không trả âm thanh')));
  });
  child.stdin.on('error', () => {});
  child.on('error', dead); child.on('exit', dead);
  return (pyWorker = child);
}
function pyChunk(text){
  const child = startWorker(), id = ++pyReq;
  const rate = `${settings.rate >= 0 ? '+' : ''}${settings.rate}%`, pitch = `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pyPending.delete(id); reject(new Error('Edge TTS quá thời gian')); }, 34_000);
    pyPending.set(id, { resolve, reject, timer, child });
    child.stdin.write(JSON.stringify({ id, text, voice: settings.voice, rate, pitch, volume: '+0%', tries: 6 }) + '\n');
  });
}
async function synthChunk(text){
  if (await findPython()) return pyChunk(text);
  const t = ttsClient();
  await t.setMetadata(settings.voice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
  const { audioStream } = t.toStream(esc(text), { pitch: `${settings.pitch >= 0 ? '+' : ''}${settings.pitch}Hz`, rate: `${settings.rate >= 0 ? '+' : ''}${settings.rate}%` });
  const parts = [];
  await new Promise((res, rej) => { audioStream.on('data', c => parts.push(c)); audioStream.on('close', res); audioStream.on('error', rej); });
  if (!parts.length) throw new Error('không nhận được âm thanh');
  return Buffer.concat(parts);
}
async function synthChunkSafe(text){
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++){
    try { return await synthChunk(text); }
    catch (e) {
      lastError = e;
      if (pyBin && !e.workerDied) break;   // worker Python đã tự gửi dự phòng nhiều lần rồi, thử nữa chỉ tốn thời gian
      closeTTS();
      if (attempt < 2) await sleep(400 + Math.random() * 300);
    }
  }
  throw lastError;
}
async function googleChunk(text){
  const key = cacheKey('google', text);
  const hit = cacheGet(key); if (hit) return hit;
  const url = 'https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=vi&q=' + encodeURIComponent(text);
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++){
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36',
          'Referer': 'https://translate.google.com/',
        },
        signal: AbortSignal.timeout(TTS_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`giọng Google HTTP ${res.status}`);
      const audio = Buffer.from(await res.arrayBuffer());
      if (audio.length < 2 || audio[0] !== 0xff || (audio[1] & 0xe0) !== 0xe0)
        throw new Error('giọng Google trả về dữ liệu không phải MP3');
      cachePut(key, audio);
      return audio;
    } catch (e) {
      lastError = e;
      if (attempt < 2) await sleep(350 + Math.random() * 250);
    }
  }
  throw lastError;
}

// Tối đa 3 đoạn tạo giọng cùng lúc: nhiều hơn thì Edge dễ từ chối.
const SYNTH_MAX = 3, synthWait = []; let synthActive = 0;
const lowWait = [];   // việc nền (tạo sẵn giọng): chỉ được dùng khi còn chừa ít nhất 1 chỗ cho giọng đang cần đọc
const synthSlot = low => low
  ? (synthActive < SYNTH_MAX - 1 ? (synthActive++, Promise.resolve()) : new Promise(r => lowWait.push(r)))
  : (synthActive < SYNTH_MAX ? (synthActive++, Promise.resolve()) : new Promise(r => synthWait.push(r)));
const synthFree = () => {
  const n = synthWait.shift();
  if (n) return n();
  if (lowWait.length && synthActive <= SYNTH_MAX - 1) return lowWait.shift()();
  synthActive--;
};
const BYTES_PER_SEC = { edge: 6000, google: 4000 };   // MP3 48 kbps (Edge 24 kHz) / 32 kbps (Google)

async function edgeAudio(text, low = false){
  const key = cacheKey(`edge|${settings.voice}|${settings.pitch}|${settings.rate}`, text);
  const hit = cacheGet(key); if (hit) return hit;
  const file = diskFile(key);
  try { const buf = fs.readFileSync(file); if (buf.length >= 1024){ cachePut(key, buf); return buf; } } catch {}
  await synthSlot(low);
  try {
    const audio = await synthChunkSafe(text); cachePut(key, audio);
    try { fs.writeFileSync(file, audio); } catch {}
    return audio;
  }
  finally { synthFree(); }
}
// một đoạn câu → { audio, engine }; Edge hỏng thì dùng Google cho riêng đoạn đó; cả hai hỏng → null (đoạn đó bị bỏ qua)
async function chunkAudio(text){
  const order = ttsEngine() === 'google' || Date.now() < ttsEdgeDownUntil ? ['google', 'edge'] : ['edge', 'google'];
  let last;
  for (const engine of order){
    try { const audio = await (engine === 'google' ? googleChunk : edgeAudio)(text); if (engine === 'edge') edgeFails = 0; return { audio, engine }; }
    catch (e) {
      last = e;
      if (engine === 'edge'){
        // Một đoạn hỏng chỉ đọc đoạn đó bằng Google; hỏng liền 3 đoạn mới coi Edge đang sập và đổi hẳn trong 30 giây
        if (++edgeFails >= 3){ edgeFails = 0; ttsEdgeDownUntil = Date.now() + TTS_EDGE_PAUSE_MS; }
        addLog(`Edge TTS trục trặc, đoạn này dùng giọng Google: ${e?.message || e}`);
      }
    }
  }
  addLog('TTS lỗi: ' + (last?.message || last));
  return null;
}
// Bắt đầu tạo giọng NGAY cho mọi đoạn song song; phát từng đoạn theo thứ tự ngay khi đoạn đó xong (emitSpeech).
function speak(text){
  const parts = splitChunks(text).map(c => chunkAudio(c).catch(() => null));
  return { text, parts, first: parts[0].then(() => {}) };
}
// Tạo sẵn giọng đọc tên ("Thí chủ <tên>.") ngay khi người xem xuất hiện, để lúc họ tặng quà là có tiếng liền.
const prefetched = new Set();
function prefetchName(name){
  const n = spoken(name);
  if (!n || ttsEngine() === 'google' || prefetched.has(n) || lowWait.length > 30) return;
  if (prefetched.size > 3000) prefetched.clear();
  prefetched.add(n);
  edgeAudio(`Thí chủ ${n}.`, true).catch(() => {});
}
// Mọi câu cố định mà Ông Đồ có thể nói. Kho quẻ hữu hạn nên tạo sẵn một lần (vài phút), từ đó đọc quẻ chỉ còn chờ đúng câu tên.
function staticSentences(){
  const set = new Set();
  const add = t => splitChunks(t).forEach(c => set.add(c));
  [TOAST_LINE, WELCOME_LINE, 'Chúc thí chủ vạn sự cát tường!', ...CHALLENGES, ...[1, 2, 3].map(b => `Cộng thêm ${b} điểm công đức.`)].forEach(add);
  for (const t of MENU) add(`Ông Đồ xin gieo quẻ ${t.label}.`);
  add('Ông Đồ xin gieo quẻ Khai Lộc.');
  for (let sum = 3; sum <= 18; sum++) for (const label of ['THƯỢNG THƯỢNG CÁT!', 'ĐẠI CÁT · VƯỢNG LỘC', 'THƯỢNG CÁT · BÌNH AN', 'TRUNG BÌNH · TĨNH TÂM']) add(`Ông Đồ lắc ống xâm, rút được thẻ xâm số ${sum}, quẻ ${label}.`);
  for (const h of HEXAGRAMS) for (const tp of TOPICS) for (const tier of ['khai_loc', 'phuc_loc', 'thien_loc', 'long_phuong']) for (const moving of tier === 'khai_loc' ? [1] : [1, 2, 3, 4, 5, 6]) add(composeReading(h, tp.id, tier, moving));
  return [...set];
}
const prerender = { running: false, total: 0, done: 0, failed: 0, key: '' };
async function prerenderVoice(){
  const keyNow = () => `${settings.voice}|${settings.pitch}|${settings.rate}`;
  if (prerender.running || ttsEngine() === 'google') return;
  Object.assign(prerender, { running: true, done: 0, failed: 0, key: keyNow() });
  const list = staticSentences(); prerender.total = list.length;
  addLog(`Bắt đầu tạo sẵn giọng ${list.length} câu cố định (chạy nền, nhường giọng đang đọc)`);
  for (const text of list){
    while (activeReading || ttsBusy || ttsQueue.length) await sleep(2000);   // nhường live
    if (keyNow() !== prerender.key){ prerender.running = false; return prerenderVoice(); }   // đổi giọng / độ trầm giữa chừng → làm lại
    try { await edgeAudio(text, true); prerender.done++; } catch { prerender.failed++; }
  }
  prerender.running = false;
  addLog(`Đã tạo sẵn giọng ${prerender.done}/${prerender.total} câu${prerender.failed ? `, lỗi ${prerender.failed} câu (sẽ thử lại lần mở server sau)` : ''}`);
}
let voiceFreeAt = 0;   // ước tính lúc overlay đọc xong mọi thứ đã gửi (để thẻ quẻ khớp với tiếng)
async function emitSpeech(sp, meta = {}){
  let secs = 0;
  for (const part of sp.parts){
    const r = await part; if (!r) continue;
    const file = `tts_${Date.now()}_${++ttsSeq}.mp3`;
    fs.writeFileSync(path.join(TTS_DIR, file), r.audio);
    broadcast({ t:'tts', url: `/live/tts/${file}`, text: sp.text, rate: r.engine === 'google' ? settings.rate : 0, ...meta });
    const sec = r.audio.length / BYTES_PER_SEC[r.engine];
    secs += sec;
    voiceFreeAt = Math.max(voiceFreeAt, Date.now()) + sec * 1000 + 350;   // overlay nghỉ 350 ms giữa hai đoạn
  }
  const old = fs.readdirSync(TTS_DIR).sort(); while (old.length > 40) { try { fs.unlinkSync(path.join(TTS_DIR, old.shift())); } catch {} }
  return secs;
}
async function pumpTTS(){
  if (ttsBusy || !ttsQueue.length) return;
  ttsBusy = true;
  const { sp, meta } = ttsQueue.shift();
  try { await emitSpeech(sp, meta); }
  catch (e) { addLog('TTS lỗi: ' + (e?.message || e)); }
  finally { ttsBusy = false; scheduleTTSIdle(); setTimeout(pumpTTS, 50); }
}

const TOASTS = [
  ['KHAI LỘC ĐẠI CÁT!', 'Tâm thành tất ứng · Vạn sự hanh thông'],
  ['PHÚC LỘC VIÊN MÃN!', 'Bình luận chủ đề để Ông Đồ gieo quẻ'],
  ['THIÊN THỜI ĐỊA LỢI!', 'Cầu tài đắc tài · Cầu duyên đắc duyên'],
];
let toastTimer = null, toastIdx = 0;
function groupToast(){
  const [text, sub] = TOASTS[toastIdx++ % TOASTS.length];
  broadcast({ t:'toast', text, sub });
  say(TOAST_LINE, { tag:'toast' });
  addLog('☯ Ông Đồ ban lời chúc đại cát');
}
function scheduleToast(){ clearInterval(toastTimer); if (settings.autoToast) toastTimer = setInterval(groupToast, Math.max(1, settings.toastEveryMin) * 60_000); }
scheduleToast();

let TikTokLib = null;
let tiktokGen = 0;
async function connectTikTok(uniqueId){
  uniqueId = String(uniqueId || '').trim().replace(/^.*tiktok\.com\/@?/i, '').replace(/^@/, '').replace(/\/.*$/, '');
  if (!uniqueId) return;
  if (tiktokConnecting){ addLog('TikTok: đang kết nối, bỏ qua yêu cầu trùng'); return; }
  tiktokConnecting = true;
  const gen = ++tiktokGen;
  const alive = () => gen === tiktokGen;
  try {
    if (tiktok){ const old = tiktok; tiktok = null; try { await old.disconnect(); } catch {} }
    if (!alive()) return;
    seenEventIds.clear();
    tiktokState = { status: 'connecting', uniqueId, error: '' }; broadcast({ t:'tiktok', ...tiktokState });
    try {
      TikTokLib ||= await import('piratetok-live-js');
      if (!alive()) return;
      const { TikTokLiveClient, EventType, isStreakOver } = TikTokLib;
      const conn = new TikTokLiveClient(uniqueId);
      const av = u => u?.avatarThumb?.urlList?.[0] || u?.profilePicture?.urlList?.[0] || '';
      const nm = u => u?.nickname || u?.uniqueId || 'thiện tín';
      const uid = u => u?.uniqueId || u?.id;
      conn.on(EventType.chat, d => {
        if (!alive() || !firstEvent(msgKey(d, 'chat'))) return;
        onChat(uid(d.user), nm(d.user), d.content, av(d.user));
      });
      conn.on(EventType.follow, d => {
        if (!alive() || !firstEvent(msgKey(d, 'follow'))) return;
        onFollow(uid(d.user), nm(d.user), av(d.user));
      });
      conn.on(EventType.gift, d => {
        if (!alive() || !isStreakOver(d)) return;
        if (!firstEvent(msgKey(d, 'gift'))) return;
        const gname = d.gift?.name || 'lộc';
        const per = Math.max(1, +d.gift?.diamondCount || 1);
        const count = Math.max(1, +d.repeatCount || 1);
        onGift(uid(d.user), nm(d.user), gname, count, per, av(d.user), isFollower(d.user));
        addLog(`🎁 ${nm(d.user)} dâng lộc ${gname} x${count}`);
      });
      conn.on(EventType.join, d => {
        if (!alive() || !firstEvent(msgKey(d, 'join'))) return;
        const id = uid(d.user);
        if (!settings.autoSeatFollowers || !id || (!followerIds.has(id) && !isFollower(d.user))) return;
        followerIds.add(id);
        seat(id, nm(d.user), { avatar: av(d.user), followed: true });
      });
      conn.on(EventType.like, d => {
        if (!alive() || !firstEvent(msgKey(d, 'like'))) return;
        pacer.markReal(uid(d.user));
        broadcast({ t:'like', id: uid(d.user), n: +d.count || 1 });
      });
      conn.on(EventType.liveEnded, () => { if (!alive()) return; addLog('TikTok: live đã kết thúc'); disconnectTikTok(); });
      conn.on(EventType.reconnecting, () => { if (alive()) addLog('TikTok: đang kết nối lại…'); });
      conn.on(EventType.disconnected, () => {
        if (!alive()) return;
        tiktokState = { ...tiktokState, status: 'disconnected' }; broadcast({ t:'tiktok', ...tiktokState });
        addLog('TikTok: mất kết nối');
      });
      conn.on('error', e => { if (alive()) addLog('TikTok lỗi: ' + (e?.message || e)); });
      const roomId = await conn.connect();
      if (!alive()){ try { await conn.disconnect(); } catch {} return; }
      tiktok = conn;
      tiktokState = { status: 'connected', uniqueId, error: '', roomId: roomId || '' };
      addLog(`✅ Đã kết nối live @${uniqueId}`);
      purgeDemo();
    } catch (e) {
      if (!alive()) return;
      tiktokState = { status: 'error', uniqueId, error: String(e?.message || e) };
      addLog(`❌ Không kết nối được @${uniqueId}: ${tiktokState.error}`);
    }
    if (alive()) broadcast({ t:'tiktok', ...tiktokState });
  } finally {
    tiktokConnecting = false;
  }
}
async function disconnectTikTok(){
  tiktokGen++;
  if (tiktok){ const c = tiktok; tiktok = null; try { await c.disconnect(); } catch {} }
  tiktokState = { status:'idle', uniqueId:'', error:'' };
  broadcast({ t:'tiktok', ...tiktokState });
}

const DEMO_NAMES = ['Bích Tuyền','Mếnn Mèoo','Bỉ Ngạn Chiều','Đỗ Văn Đại','Kiều Hùng','Thích Phú Bà','Lâm Nguyễn','Văn Tuấn','Ngọc Lan','Tuấn Kiệt','Mai Linh','Đức Anh','Phương Thảo','Trung Kiên','Bảo Ngọc','Hoàng Nam','Lan Anh','Thanh Tùng','Kim Chi','Mỹ Duyên','Quang Huy','Hồng Nhung','Duy Khánh','Thùy Linh'];
const DEMO_TOPICS = ['Tình Duyên', 'Tài Lộc', 'Gia Đạo', 'Sự Nghiệp', 'Sức Khỏe', 'Vận Mệnh'];
function fillDemo(n){
  const have = [...viewers.values()].filter(v => v.demo).length;
  for (let i = have; i < n && viewers.size < 64; i++){
    const name = DEMO_NAMES[i % DEMO_NAMES.length] + (i >= DEMO_NAMES.length ? ' ' + (Math.floor(i / DEMO_NAMES.length) + 1) : '');
    const topic = DEMO_TOPICS[i % DEMO_TOPICS.length];
    const { v } = seat('demo_' + i, name, { demo: true, skin: ['man','woman','cap','sexy','uncle','oldwoman'][i % 6], topic });
    if (v){
      v.beers = [30, 25, 20, 16, 13, 8, 5, 2][i % 8] || Math.floor(Math.random() * 15);
      v.asked = i % 2 === 0;
      totalBeers += v.beers;
    }
  }
  broadcast(snapshot());
}
// Vào live thật: dọn hết người mẫu / bot (kèm KC giả của họ) để số liệu trên màn hình chỉ còn của người thật.
function purgeDemo(){
  setBots(false);
  const fake = [...viewers.values()].filter(v => /^(bot|demo)_/.test(v.id));
  if (!fake.length) return;
  for (const v of fake){ totalBeers = Math.max(0, totalBeers - v.beers); viewers.delete(v.id); }
  for (let i = readingQueue.length - 1; i >= 0; i--) if (/^(bot|demo)_/.test(readingQueue[i].id)) readingQueue.splice(i, 1);
  broadcast(snapshot());
  addLog(`Đã dọn ${fake.length} người mẫu / bot khi vào live thật`);
}
function clearSeats(){
  viewers.clear();
  readingQueue.length = 0;
  activeReading = null;
  clearTimeout(readingTimer);
  totalBeers = 0;
  broadcast(snapshot());
  addLog('Đã làm trống phòng Tử Vi');
}

function onControl(m){
  switch (m.cmd){
    case 'connect': connectTikTok(m.uniqueId); break;
    case 'disconnect': disconnectTikTok(); addLog('Đã ngắt kết nối TikTok'); break;
    case 'chat': {
      const n = String(m.name || 'Thiện Tín').slice(0, 18);
      seat('sim_' + n, n);
      onChat('sim_' + n, n, String(m.text || 'Khai lộc tình duyên').slice(0, 120));
      break;
    }
    case 'follow': { const n = String(m.name || 'Thiện Tín').slice(0, 18); onFollow('sim_' + n, n); break; }
    case 'beer': {
      const n = String(m.name || 'Thiện Tín').slice(0, 18);
      if (m.topic) {
        const { v } = seat('sim_' + n, n);
        if (v) v.topic = String(m.topic);
      }
      onGift('sim_' + n, n, String(m.gift || 'Khai Lộc').slice(0, 30), clamp(m.count, 1, 99), clamp(m.diamonds, 1, 50000));
      break;
    }
    case 'dice': {
      const n = String(m.name || 'Thiện Tín').slice(0, 18);
      const { v } = seat('sim_' + n, n);
      rollDiceFor(v, 'Ống Xâm Linh Ứng', 1);
      break;
    }
    case 'cheer': {
      if (m.global){ groupToast(); break; }
      const n = String(m.name || 'Thiện Tín').slice(0, 18), { v } = seat('sim_' + n, n);
      broadcast({ t:'cheer', id: v.id, name: v.name });
      addLog(`🙏 ${v.name} chắp tay cầu an`); break;
    }
    case 'fill':
      if (tiktokState.status === 'connected'){ addLog('⛔ Đang kết nối live thật: không đổ người mẫu (có KC giả). Ngắt TikTok trước nếu muốn thử.'); break; }
      fillDemo(clamp(m.n, 1, 64)); addLog(`Đổ người mẫu: ${viewers.size} người`); break;
    case 'clear': clearSeats(); break;
    case 'kick': {
      const id = String(m.id || '').slice(0, 64), v = viewers.get(id);
      if (!v || !/^(sim|demo|bot|auto)_/.test(id)) break;
      viewers.delete(id); broadcast({ t:'leave', id });
      addLog(`Đã xoá người xem mô phỏng: ${v.name}`); break;
    }
    case 'toast': groupToast(); break;
    case 'say': if (m.text) say(String(m.text).slice(0, 400), { tag:'say' }); break;
    case 'settings': {
      const voiceKey = () => `${settings.voice}|${settings.pitch}|${settings.rate}`, before = voiceKey();
      applySettings(m.settings || {});
      if (!settings.autoPace) pacer.clearAll();
      if (voiceKey() !== before && ttsEngine() === 'edge') prerenderVoice();   // giọng / độ trầm mới → tạo sẵn lại kho câu cố định
      saveSettings();
      scheduleToast(); broadcast({ t:'settings', settings, cap: capacity(), barBeers: totalBeers }); break;
    }
    case 'bots':
      if (m.on && tiktokState.status === 'connected'){
        addLog('⛔ Đang kết nối live thật: không bật bot (bot có tặng quà giả). Dùng "Khách ảo giữ nhịp live" thay thế.');
        broadcast({ t:'bots', on:false }, 'control'); break;
      }
      setBots(!!m.on, +m.n || 12, m.pace); break;
  }
}

const SETTING_RULES = {
  title: v => String(v).slice(0, 40), subtitle: v => String(v).slice(0, 60),
  voice: v => ['google', 'vi-VN-NamMinhNeural', 'vi-VN-HoaiMyNeural'].includes(v) ? v : settings.voice,
  pitch: v => clamp(v, -50, 50), rate: v => clamp(v, -50, 50), toastEveryMin: v => clamp(v, 1, 60),
  music: Boolean, sfx: Boolean, ambience: Boolean, autoToast: Boolean, autoSeatFollowers: Boolean,
  musicVolume: v => clamp(v, 0, 100),
  musicTrack: v => /^[a-z0-9_-]{0,64}$/i.test(String(v)) ? String(v) : settings.musicTrack,
  seatMode: v => ['auto', '12', '24', '36', '48', '64'].includes(String(v)) ? String(v) : 'auto',
  phaseMode: v => ['auto', 'food', 'beer'].includes(v) ? v : 'auto',
  foodFrom: v => clamp(v, 0, 23), beerFrom: v => clamp(v, 0, 23),
  autoPace: Boolean, autoPaceReadings: Boolean, autoPaceLabel: Boolean,
  autoPaceSpeed: v => SPEEDS.includes(v) ? v : settings.autoPaceSpeed,
  autoPaceMax: v => clamp(v, 0, 24),
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, Math.round(+v || 0)));
function applySettings(o){
  for (const [k, fn] of Object.entries(SETTING_RULES)) if (k in o) settings[k] = fn(o[k]);
  if (settings.beerFrom <= settings.foodFrom + 1){ settings.foodFrom = 6; settings.beerFrom = 18; }
}
// Cài đặt (giọng, khách ảo, nhạc, tên phòng…) được lưu vào live/settings.json và nạp lại khi mở server.
// Chỉ nhận đúng các khóa trong SETTING_RULES, qua cùng bộ kiểm tra như khi chỉnh trên bảng điều khiển.
const SETTINGS_FILE = path.join(__dirname, 'settings.json');
let saveTimer = null;
function saveSettings(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const out = {}; for (const k of Object.keys(SETTING_RULES)) out[k] = settings[k];
    try { fs.writeFileSync(SETTINGS_FILE + '.tmp', JSON.stringify(out, null, 2)); fs.renameSync(SETTINGS_FILE + '.tmp', SETTINGS_FILE); }
    catch (e) { addLog('Không lưu được cài đặt: ' + (e?.message || e)); }
  }, 600);
}
try { applySettings(JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))); scheduleToast(); } catch { /* chưa có file → dùng mặc định */ }

// Ông Đồ gieo quẻ khai lộc MIỄN PHÍ cho khách ảo: 0 KC, không cộng công đức / tổng bar, không phát sự kiện quà.
function freeReading(v){
  const hex = buildHexagram(v.topicId || 'tong_quan', 'khai_loc');
  v.asked = true;
  enqueueReading(v, { ...orderFromCoins(1, v.topic), coins: 0 }, hex, `Thí chủ ${spoken(v.name)}. Ông Đồ xin gieo quẻ Khai Lộc. ${hex.fullReading}`);
  addLog(`🎭 Ông Đồ gieo quẻ khai lộc cho khách ảo ${v.name} → Quẻ số ${hex.num} ${hex.name}`);
}
const pacer = createPacer({
  getSettings: () => settings, viewers, seat, onChat, broadcast, addLog,
  readFree: freeReading,
  busy: () => !!activeReading || readingQueue.length > 0 || ttsBusy || ttsQueue.length > 0,
});

let botTimer = null;
const BOT_LINES = [
  'Khai lộc tình duyên thầy ơi!',
  'Con xin quẻ tài lộc tháng này ạ',
  'Tới con chưa thầy ơi',
  'Xin quẻ gia đạo bình an',
  'Nam mô hoan hỷ đại cát',
  'Xem giúp con đường sự nghiệp với ạ',
  'Công tử', 'Tiểu thư', 'Nam', 'Nữ', 'Ông già', 'Bà già',
  'Quẻ thầy luận chuẩn quá ạ!',
  'Xin vía tài lộc đại cát',
  'Con xin quẻ tình duyên với ạ',
];
function setBots(on, n, pace){
  clearInterval(botTimer); botTimer = null;
  if (on){
    n = clamp(n, 1, 64);
    for (let i = 0; i < n; i++) seat('bot_' + i, DEMO_NAMES[(i + 4) % DEMO_NAMES.length], { demo: true, followed: true, topic: DEMO_TOPICS[i % DEMO_TOPICS.length] });
    const every = { slow: 4500, mid: 2200, fast: 950 }[pace] || 2200;
    botTimer = setInterval(() => {
      const ids = [...viewers.keys()].filter(id => id.startsWith('bot_')); if (!ids.length) return;
      const id = ids[Math.floor(Math.random() * ids.length)], v = viewers.get(id), r = Math.random();
      if (r < .54) onChat(id, v.name, BOT_LINES[Math.floor(Math.random() * BOT_LINES.length)]);
      else if (r < .72) broadcast({ t:'like', id, n: 1 + Math.floor(Math.random() * 4) });
      else if (r < .86) onGift(id, v.name, 'Khai Lộc Tình Duyên', 1, 1 + Math.floor(Math.random() * 8));
      else if (r < .95) onGift(id, v.name, 'Phúc Lộc Tài Lộc', 1, 15);
      else onGift(id, v.name, 'Thiên Lộc Đại Cát', 1, 35);
    }, every);
    addLog(`🤖 Bật ${n} bot thiện tín, nhịp ${pace}`);
  } else {
    for (const id of [...viewers.keys()]) if (id.startsWith('bot_')) { viewers.delete(id); broadcast({ t:'leave', id }); }
    addLog('🤖 Tắt bot');
  }
  broadcast({ t:'bots', on }, 'control');
}

const HOST = process.env.HOST || '127.0.0.1';
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript', '.css':'text/css', '.json':'application/json',
  '.png':'image/png', '.jpg':'image/jpeg', '.webp':'image/webp', '.mp3':'audio/mpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon' };
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`, `[::1]:${PORT}`]);
const okHost = h => ALLOWED_HOSTS.has(String(h || '').toLowerCase());
const SEP = path.sep;
function resolveStatic(urlPath){
  let p = urlPath === '/' ? '/live/control.html' : urlPath;
  if (p !== '/index.html' && !/^\/(assets|live)\//.test(p)) return null;
  if (p.split('/').some(seg => seg.startsWith('.') || seg === 'node_modules')) return null;
  if (/\.(mjs|json|md|log)$/i.test(p) && !p.startsWith('/assets/')) return null;
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT + SEP)) return null;
  return file;
}
const server = http.createServer((req, res) => {
  if (!okHost(req.headers.host)) { res.writeHead(421).end('wrong host'); return; }
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405).end(); return; }
  let reqUrl, p;
  try { reqUrl = new URL(req.url, 'http://x'); p = decodeURIComponent(reqUrl.pathname); } catch { res.writeHead(400).end(); return; }
  if (p === '/live/avatar') { serveAvatar(req, res, reqUrl.searchParams.get('u')).catch(() => { try { res.writeHead(500).end(); } catch {} }); return; }
  const file = resolveStatic(p);
  if (!file) { res.writeHead(404).end('not found'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404).end('not found'); return; }
    const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': p.startsWith('/live/tts/') ? 'no-store' : 'no-cache',
      'ETag': etag, 'Accept-Ranges': 'bytes',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
    };
    if (req.headers['if-none-match'] === etag) { res.writeHead(304, headers); res.end(); return; }
    let start = 0, end = st.size - 1, status = 200;
    const range = req.headers.range;
    if (range && st.size > 0) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (m && (m[1] || m[2])) {
        if (m[1]) { start = +m[1]; end = m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1; }
        else { start = Math.max(0, st.size - +m[2]); }
        if (start > end || start >= st.size) {
          res.writeHead(416, { 'Content-Range': `bytes */${st.size}`, 'Accept-Ranges': 'bytes' }); res.end(); return;
        }
        status = 206;
        headers['Content-Range'] = `bytes ${start}-${end}/${st.size}`;
      }
    }
    if (st.size > 0) headers['Content-Length'] = String(end - start + 1);
    res.writeHead(status, headers);
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file, st.size > 0 ? { start, end } : undefined).pipe(res);
  });
});
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 64 * 1024,
  verifyClient: ({ origin, req }) => {
    if (!okHost(req.headers.host)) return false;
    if (!origin) return true;
    try { return okHost(new URL(origin).host); } catch { return false; }
  } });
function broadcast(msg, only){ const s = JSON.stringify(msg); for (const c of wss.clients) if (c.readyState === 1 && (!only || c.role === only)) c.send(s); }
wss.on('connection', (ws, req) => {
  ws.role = new URL(req.url, 'http://x').searchParams.get('role') === 'control' ? 'control' : 'overlay';
  ws.send(JSON.stringify(snapshot()));
  if (ws.role === 'control') ws.send(JSON.stringify({ t:'logs', lines: log }));
  ws.on('message', buf => {
    if (ws.role !== 'control') return;
    try { const m = JSON.parse(buf); if (m && m.t === 'ctl') onControl(m); } catch (e) { addLog('Lệnh lỗi: ' + e.message); }
  });
});
server.listen(PORT, HOST, () => {
  addLog(`Server Tử Vi Phát Đạt (BEAR) chạy tại http://localhost:${PORT}  ·  Bảng điều khiển: http://localhost:${PORT}/live/control.html  ·  Overlay: http://localhost:${PORT}/live/overlay.html`);
  setTimeout(() => warmTTS().then(prerenderVoice), 1200);
  pacer.start();
});
