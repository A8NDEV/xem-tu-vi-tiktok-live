// Xử lý chữ trước khi tạo giọng (thuần, có test: tts-text.test.mjs).

// Cắt ở cuối câu gần nhất thay vì giữa chừng.
export function clipText(text, max = 600){
  const s = String(text);
  if (s.length <= max) return s;
  const cut = Math.max(s.lastIndexOf('. ', max), s.lastIndexOf('! ', max), s.lastIndexOf('? ', max));
  return s.slice(0, cut > max * 0.5 ? cut + 1 : max);
}

// Chia thành từng CÂU, mỗi câu là một đoạn giọng độc lập.
// Lý do: Edge chậm / hay trả rỗng với câu mới nhưng xong trong ~0,5 giây với câu đã đọc; câu ngắn cũng ít hỏng hơn câu dài.
// Mỗi câu không phụ thuộc câu bên cạnh (không gộp) nên bộ nhớ đệm và việc tạo sẵn giọng dùng chung được cho mọi khách.
// Câu quá dài (> max) mới cắt thêm ở khoảng trắng.
export function splitChunks(text, max = 160){
  const sentences = String(text).replace(/\s+/g, ' ').trim().split(/(?<=[.!?…;:])\s+/u);
  const chunks = [];
  for (let s of sentences){
    while (s.length > max){
      let cut = s.lastIndexOf(' ', max);
      if (cut < max * 0.5) cut = max;
      chunks.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (s) chunks.push(s);
  }
  return chunks.length ? chunks : [String(text).slice(0, max)];
}
