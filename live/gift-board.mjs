// Bảng quà TikTok gợi ý hiện trên overlay: ghép quà thật (tên, giá xu, hình) vào 5 mốc gieo quẻ.
// Dữ liệu quà lấy từ live/qua-tiktok.json (danh sách công khai của TikTok, cùng nguồn với dự án Thắp Sáng).
// Module thuần (chỉ đọc một file JSON), có test: gift-board.test.mjs.
import fs from 'node:fs';

// Quà mặc định, chọn hợp chủ đề: Hoa hồng, Bắn tim (Khai Lộc) · Chú heo may mắn, Nước hoa (Phúc Lộc) · Bánh vòng, Bó hoa (Thiên Lộc)
// · Hạc giấy, Thả tim (Long Phượng) · Chó Corgi, Tim (Thiên Mệnh).
export const DEFAULT_GIFT_IDS = ['5655', '5487', '8825', '5658', '5879', '5780', '5659', '5660', '6267', '5586'];
export const DICE_GIFT_ID = '9875';   // Cỏ bốn lá: server đọc là "lắc ống xâm", không phải quẻ theo mốc
const IMG_RE = /^https:\/\/[^\s"'<>]+$/;

export function loadGiftCatalog(file){
  const map = new Map();
  try {
    for (const g of JSON.parse(fs.readFileSync(file, 'utf8')).gifts || []) {
      if (!g || !/^\d{1,20}$/.test(String(g.id)) || !(g.coins > 0)) continue;
      map.set(String(g.id), {
        id: String(g.id), name: String(g.name || '').slice(0, 40), coins: Math.round(g.coins),
        img: IMG_RE.test(g.img || '') && g.img.length < 600 ? g.img : '',
      });
    }
  } catch { /* không có file → bảng không hiện quà, vẫn hiện mốc */ }
  return map;
}

export function parseGiftIds(v, fallback = DEFAULT_GIFT_IDS){
  const ids = [...new Set(String(v ?? '').split(/[\s,;]+/).filter(x => /^\d{1,20}$/.test(x)))].slice(0, 12);
  return ids.length ? ids : fallback;
}

const slim = g => g && { id: g.id, name: g.name, coins: g.coins, img: g.img };

// mỗi mốc lấy 1 quà (quà đầu tiên trong danh sách) có giá nằm trong khoảng [giá mốc, giá mốc kế tiếp); cột phải overlay chỉ đủ chỗ cho 1 quà / mốc
export function buildMenu(menu, catalog, ids){
  return menu.map((tier, i) => {
    const hi = i + 1 < menu.length ? menu[i + 1].coins : Infinity;
    const gifts = ids.map(id => catalog.get(id)).filter(g => g && g.coins >= tier.coins && g.coins < hi).slice(0, 1).map(slim);
    return { ...tier, gifts };
  });
}
export const diceGift = catalog => slim(catalog.get(DICE_GIFT_ID)) || null;

// danh sách gọn cho ô tìm quà ở bảng điều khiển: [id, tên, xu]
export const catalogList = catalog => [...catalog.values()].sort((a, b) => a.coins - b.coins || a.name.localeCompare(b.name, 'vi')).map(g => [g.id, g.name, g.coins]);
