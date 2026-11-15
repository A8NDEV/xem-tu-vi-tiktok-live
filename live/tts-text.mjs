// Xử lý chữ trước khi tạo giọng (thuần, có test: tts-text.test.mjs).

// Cắt ở cuối câu gần nhất thay vì giữa chừng.
export function clipText(text, max = 600){
  const s = String(text);
  if (s.length <= max) return s;
  const cut = Math.max(s.lastIndexOf('. ', max), s.lastIndexOf('! ', max), s.lastIndexOf('? ', max));
  return s.slice(0, cut > max * 0.5 ? cut + 1 : max);
}

// Chia câu thành các đoạn ngắn để tạo giọng song song.
// Câu ĐẦU luôn đứng riêng: nó thường chứa tên người ("Ông Đồ xin gieo quẻ cho thí chủ <tên>…") nên mỗi lần một khác,
// còn các câu sau là lời luận quẻ lặp lại giữa các khách → nằm trong bộ nhớ đệm, không phải chờ Edge tạo lại.
// (Edge chậm / hay trả rỗng với câu mới, nhưng xong trong ~0,5 giây với câu đã đọc.)
export function splitChunks(text, max = 100){
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/u);
  const chunks = [];
  let buf = '';
  const flush = () => { if (buf) { chunks.push(buf); buf = ''; } };
  sentences.forEach((sentence, i) => {
    let s = sentence;
    while (s.length > max){
      flush();
      let cut = s.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (!s) return;
    if (i === 0) { chunks.push(s); return; }
    if (!buf) buf = s;
    else if (buf.length + 1 + s.length <= max) buf += ' ' + s;
    else { flush(); buf = s; }
  });
  flush();
  return chunks.length ? chunks : [String(text).slice(0, max)];
}
