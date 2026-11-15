"""Tạo giọng Edge TTS (gói Python edge-tts), gửi dự phòng song song để không chờ lâu khi Edge trả rỗng / treo.

Dịch vụ Edge hay trả rỗng (NoAudioReceived, mất ~2,5 giây) hoặc treo im lặng (mất tới 10 giây) với giọng tiếng Việt,
trong khi lần thành công chỉ mất khoảng 0,5-0,8 giây. Thử lại tuần tự nên rất chậm. Ở đây:
  - bắt đầu một lượt gọi; nếu sau HEDGE giây chưa xong thì mở thêm một lượt song song (tối đa MAX_PARALLEL lượt cùng lúc),
  - lượt nào lỗi thì mở ngay lượt thay thế, lượt nào xong đầu tiên thắng, các lượt còn lại bị huỷ,
  - tổng cộng không quá `so_lan_thu` lượt và không quá DEADLINE giây.

Hai chế độ:
  - worker thường trực (server dùng): python edge_say.py --serve
    đọc từng dòng JSON {id,text,voice,rate,pitch,volume,tries} từ stdin, trả từng dòng JSON {id,ok,audio(base64)|err} ra stdout.
    Nạp edge_tts một lần (mất ~1,1 giây) thay vì mỗi câu một tiến trình mới.
  - dòng lệnh một lần (để thử tay): python edge_say.py <voice> <rate> <pitch> <volume> <file_van_ban_utf8> <file_mp3_ra> [so_lan_thu]
"""
import asyncio
import base64
import json
import sys

import edge_tts

HEDGE = 1.6          # giây chờ trước khi mở lượt dự phòng (lần thành công thường ≤ 0,8 giây)
ATTEMPT_TIMEOUT = 10  # một lượt treo quá 10 giây thì bỏ
MAX_PARALLEL = 3
DEADLINE = 28


async def synth_once(text, voice, rate, pitch, volume):
    data = bytearray()
    async for chunk in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch, volume=volume).stream():
        if chunk["type"] == "audio":
            data += chunk["data"]
    if len(data) < 1024:
        raise RuntimeError("Edge trả về âm thanh rỗng")
    return bytes(data)


async def hedged(text, voice, rate, pitch, volume, tries):
    loop = asyncio.get_running_loop()
    t0 = loop.time()
    pending, started, last = set(), 0, None

    def launch():
        nonlocal started
        started += 1
        pending.add(asyncio.ensure_future(asyncio.wait_for(synth_once(text, voice, rate, pitch, volume), ATTEMPT_TIMEOUT)))

    launch()
    try:
        while pending:
            left = DEADLINE - (loop.time() - t0)
            if left <= 0:
                break
            can_hedge = started < tries and len(pending) < MAX_PARALLEL
            done, _ = await asyncio.wait(pending, timeout=min(HEDGE, left) if can_hedge else left, return_when=asyncio.FIRST_COMPLETED)
            for d in done:
                pending.discard(d)
                try:
                    return d.result()
                except Exception as e:  # noqa: BLE001 - lỗi mạng/dịch vụ đều thử lại
                    last = e
            if started < tries and len(pending) < MAX_PARALLEL:
                launch()
        raise last or RuntimeError("hết thời gian chờ Edge")
    finally:
        for p in pending:
            p.cancel()


async def serve():
    loop = asyncio.get_running_loop()
    sys.stdin.reconfigure(encoding="utf-8")
    sys.stdout.reconfigure(encoding="utf-8")
    tasks = set()

    async def handle(req):
        out = {"id": req.get("id")}
        try:
            audio = await hedged(req["text"], req["voice"], req["rate"], req["pitch"], req["volume"], int(req.get("tries", 6)))
            out["ok"], out["audio"] = True, base64.b64encode(audio).decode("ascii")
        except Exception as e:  # noqa: BLE001
            out["ok"], out["err"] = False, f"{type(e).__name__}: {e}"
        print(json.dumps(out), flush=True)

    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:   # server đóng ống (tắt / sập) → tự thoát, không để tiến trình mồ côi
            break
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            continue
        t = asyncio.ensure_future(handle(req))
        tasks.add(t)
        t.add_done_callback(tasks.discard)
    if tasks:
        await asyncio.gather(*tasks, return_exceptions=True)
    return 0


async def main():
    if sys.argv[1:2] == ["--serve"]:
        return await serve()
    voice, rate, pitch, volume, src, dst = sys.argv[1:7]
    tries = int(sys.argv[7]) if len(sys.argv) > 7 else 5
    with open(src, encoding="utf-8") as f:
        text = f.read()
    try:
        audio = await hedged(text, voice, rate, pitch, volume, tries)
    except Exception as e:  # noqa: BLE001
        print(f"fail after {tries}: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    with open(dst, "wb") as f:
        f.write(audio)
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
