import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChunks, clipText } from './tts-text.mjs';

test('câu đầu (chứa tên) đứng riêng, các câu sau gộp theo độ dài', () => {
  const t = 'Ông Đồ xin gieo quẻ cho thí chủ Lan Anh. Quẻ số bảy, Địa Thủy Sư. Trung Cát. Giữ tâm ngay thẳng, chớ nóng vội, quý nhân sẽ đến.';
  const c = splitChunks(t, 60);
  assert.equal(c[0], 'Ông Đồ xin gieo quẻ cho thí chủ Lan Anh.');
  assert.equal(c[1], 'Quẻ số bảy, Địa Thủy Sư. Trung Cát.');
  assert.equal(c[2], 'Giữ tâm ngay thẳng, chớ nóng vội, quý nhân sẽ đến.');
});

test('hai khách khác tên có chung các đoạn luận quẻ (để dùng bộ nhớ đệm)', () => {
  const body = 'Quẻ số bảy, Địa Thủy Sư, Trung Cát. Giữ tâm ngay thẳng, chớ nóng vội, quý nhân sẽ đến đúng lúc.';
  const a = splitChunks(`Ông Đồ xin gieo quẻ cho thí chủ Lan Anh. ${body}`), b = splitChunks(`Ông Đồ xin gieo quẻ cho thí chủ Bảo Ngọc. ${body}`);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a.slice(1), b.slice(1));
});

test('ghép lại đủ chữ, không đoạn nào quá max, đúng thứ tự', () => {
  const t = Array.from({ length: 12 }, (_, i) => `Câu số ${i} nói về vận may của thí chủ trong năm nay.`).join(' ') + ' ' + 'rất dài '.repeat(40) + 'hết.';
  const c = splitChunks(t, 100);
  assert.ok(c.every(x => x.length <= 100), c.map(x => x.length).join(','));
  assert.equal(c.join(' ').replace(/\s+/g, ' '), t.replace(/\s+/g, ' ').trim());
});

test('câu rỗng / một câu / không dấu chấm vẫn ra ít nhất một đoạn', () => {
  assert.deepEqual(splitChunks('Xin chào'), ['Xin chào']);
  assert.equal(splitChunks('').length, 1);
});

test('clipText cắt ở cuối câu', () => {
  const t = 'Câu một rất vui. Câu hai cũng vui. Câu ba thì dài dài dài dài dài dài.';
  assert.equal(clipText(t, 40), 'Câu một rất vui. Câu hai cũng vui.');
  assert.equal(clipText('ngắn', 40), 'ngắn');
});
