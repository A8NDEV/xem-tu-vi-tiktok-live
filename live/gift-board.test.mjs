import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadGiftCatalog, parseGiftIds, buildMenu, diceGift, catalogList, DEFAULT_GIFT_IDS } from './gift-board.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const catalog = loadGiftCatalog(path.join(here, 'qua-tiktok.json'));
const MENU = [
  { id: 'khai_loc', coins: 1 },
  { id: 'cat_tuong', coins: 5 },
  { id: 'phuc_loc', coins: 10 },
  { id: 'thien_loc', coins: 20 },
  { id: 'long_phuong', coins: 30 },
  { id: 'thien_menh', coins: 100 },
];

test('đọc được danh sách quà TikTok kèm giá và hình https', () => {
  assert.ok(catalog.size > 100);
  const rose = catalog.get('5655');
  assert.equal(rose.coins, 1); assert.match(rose.img, /^https:\/\//);
});

test('mọi quà mặc định đều có trong danh sách và có hình', () => {
  for (const id of DEFAULT_GIFT_IDS) { const g = catalog.get(id); assert.ok(g, `thiếu quà ${id}`); assert.ok(g.img, `quà ${id} thiếu hình`); }
});

test('mỗi mốc chỉ nhận đúng 1 quà có giá nằm trong khoảng của mốc', () => {
  const menu = buildMenu(MENU, catalog, DEFAULT_GIFT_IDS);
  menu.forEach((tier, i) => {
    const hi = i + 1 < MENU.length ? MENU[i + 1].coins : Infinity;
    assert.equal(tier.gifts.length, 1, `${tier.id}: ${tier.gifts.length} quà`);
    for (const g of tier.gifts) assert.ok(g.coins >= tier.coins && g.coins < hi, `${g.name} ${g.coins} xu lệch mốc ${tier.id}`);
  });
});

test('mã quà lạ / không có trong danh sách bị bỏ qua, không lỗi', () => {
  const menu = buildMenu(MENU, catalog, ['999999999', '5655']);
  assert.equal(menu[0].gifts.length, 1); assert.equal(menu[1].gifts.length, 0);
});

test('parseGiftIds: lọc mã không hợp lệ, bỏ trùng, tối đa 12, rỗng thì dùng mặc định', () => {
  assert.deepEqual(parseGiftIds('5655, 5655;abc 5487'), ['5655', '5487']);
  assert.equal(parseGiftIds(Array.from({ length: 30 }, (_, i) => i + 1).join(',')).length, 12);
  assert.deepEqual(parseGiftIds('  '), DEFAULT_GIFT_IDS);
  assert.deepEqual(parseGiftIds(undefined), DEFAULT_GIFT_IDS);
});

test('Cỏ bốn lá có sẵn cho dòng "Lắc ống xâm"; danh sách tìm quà gọn và đã sắp theo xu', () => {
  assert.equal(diceGift(catalog)?.coins, 10);
  const l = catalogList(catalog);
  assert.ok(l.length > 100 && l[0][2] <= l[l.length - 1][2]);
});
