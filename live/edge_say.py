"""Tạo giọng Edge TTS (gói Python edge-tts), tự thử lại nhiều lần trong cùng một tiến trình.

Dịch vụ Edge hay trả rỗng (NoAudioReceived) với giọng tiếng Việt; thử lại sau vài trăm ms thường được.
Dùng chung cách làm với dự án Thắp Sáng Bản Đồ (giọng Nam Minh), có pitch/volume.

Cách dùng: python edge_say.py <voice> <rate> <pitch> <volume> <file_van_ban_utf8> <file_mp3_ra> [so_lan_thu]
"""
import asyncio
import sys

import edge_tts


async def synth_once(text, voice, rate, pitch, volume):
    data = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume).stream():
        if chunk["type"] == "audio":
            data += chunk["data"]
    if len(data) < 1024:
        raise RuntimeError("Edge trả về âm thanh rỗng")
    return bytes(data)


async def main():
    voice, rate, pitch, volume, src, dst = sys.argv[1:7]
    tries = int(sys.argv[7]) if len(sys.argv) > 7 else 5
    with open(src, encoding="utf-8") as f:
        text = f.read()
    last = None
    for attempt in range(1, tries + 1):
        try:
            # mỗi lần thử tối đa 10 giây (câu dài cần lâu hơn): kết nối Edge đôi khi treo im lặng → bỏ sớm, thử kết nối mới (thường được ngay)
            audio = await asyncio.wait_for(synth_once(text, voice, rate, pitch, volume), 10)
            with open(dst, "wb") as f:
                f.write(audio)
            print(f"ok attempt={attempt}")
            return 0
        except Exception as e:  # noqa: BLE001 - lỗi mạng/dịch vụ đều thử lại
            last = e
            await asyncio.sleep(0.3 * attempt)
    print(f"fail after {tries}: {type(last).__name__}: {last}", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
