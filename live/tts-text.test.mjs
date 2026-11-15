import test from 'node:test';
import assert from 'node:assert/strict';
import { splitChunks, clipText } from './tts-text.mjs';

test('mỗi câu là một đoạn độc lập, theo đúng thứ tự', () => {
  const t = 'Thí chủ Lan Anh. Ông Đồ xin gieo quẻ Khai Lộc. Quẻ số bảy, Địa Thủy Sư. Giữ tâm ngay thẳng, chớ nóng vội!';
  assert.deepEqual(splitChunks(t), ['Thí chủ Lan Anh.', 'Ông Đồ xin gieo quẻ Khai Lộc.', 'Quẻ số bảy, Địa Thủy Sư.', 'Giữ tâm ngay thẳng, chớ nóng vội!']);
});

test('hai khách khác tên chỉ khác đúng đoạn tên, mọi đoạn còn lại giống hệt (dùng chung bộ nhớ đệm)', () => {
  const body = 'Ông Đồ xin gieo quẻ Khai Lộc. Quẻ số bảy, Địa Thủy Sư. Giữ tâm ngay thẳng, chớ nóng vội.';
  const a = splitChunks(`Thí chủ Lan Anh. ${body}`), b = splitChunks(`Thí chủ Bảo Ngọc. ${body}`);
  assert.notEqual(a[0], b[0]);
  assert.deepEqual(a.slice(1), b.slice(1));
});

test('câu quá dài được cắt ở khoảng trắng, không đoạn nào quá max, ghép lại đủ chữ', () => {
  const t = 'Câu mở đầu. ' + 'rất dài '.repeat(60) + 'hết.';
  const c = splitChunks(t, 100);
  assert.ok(c.length > 2 && c.every(x => x.length <= 100), c.map(x => x.length).join(','));
  assert.equal(c.join(' ').replace(/\s+/g, ' '), t.replace(/\s+/g, ' ').trim());
});

test('rỗng / một câu / không dấu chấm vẫn ra ít nhất một đoạn', () => {
  assert.deepEqual(splitChunks('Xin chào'), ['Xin chào']);
  assert.equal(splitChunks('').length, 1);
});

test('clipText cắt ở cuối câu', () => {
  const t = 'Câu một rất vui. Câu hai cũng vui. Câu ba thì dài dài dài dài dài dài.';
  assert.equal(clipText(t, 40), 'Câu một rất vui. Câu hai cũng vui.');
  assert.equal(clipText('ngắn', 40), 'ngắn');
});
