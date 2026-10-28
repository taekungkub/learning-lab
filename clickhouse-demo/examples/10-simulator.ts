// bun run examples/10-simulator.ts            (ต้องรัน 08 ก่อน: ใช้ schema sensor_*)
// DEVICES=100 bun run examples/10-simulator.ts  (เปลี่ยนจำนวน device ได้)
// จำลอง device ส่งข้อมูลทุก 1 วิ: รวมทุก device เป็น 1 batch ต่อวินาที แล้ว insert เข้า sensor_raw
// (ระบบจริงตัวกลาง เช่น Kafka/service รวม batch ให้ device ห้าม insert เองทีละตัว)
// device/metric นิยามที่ src/mock.ts (ชุดเดียวกับ 11-backfill ข้อมูลต่อกันได้)
// Ctrl+C หยุด
import { ch, rows } from "../src/ch";
import { makeDevices, payload } from "../src/mock";

const devices = makeDevices(Number(process.env.DEVICES ?? 10));

let running = true;
process.on("SIGINT", () => (running = false));

console.log(`ส่ง ${devices.length} device ทุก 1 วิ (Ctrl+C หยุด)`);
let tick = 0;
while (running) {
  const started = Date.now();
  const ts = Math.floor(started / 1000);
  try {
    await ch.insert({ table: "sensor_raw", format: "JSONEachRow", values: devices.map((d) => payload(d, ts)) });
  } catch (e) {
    console.error("insert ล้ม:", (e as Error).message); // ไม่หยุด simulator ลองใหม่รอบหน้า
  }
  const insertMs = Date.now() - started;

  // ทุก 10 วิ: สถานะ parts (ดูว่า merge ตามทัน) + จำนวนแถว
  if (++tick % 10 === 0) {
    const [s] = await rows<{ raw: number; long: number; hourly_parts: number; long_parts: number }>(`
      SELECT (SELECT count() FROM sensor_raw)  AS raw,
             (SELECT count() FROM sensor_long) AS long,
             (SELECT count() FROM system.parts WHERE database = 'demo' AND table = 'sensor_long'   AND active) AS long_parts,
             (SELECT count() FROM system.parts WHERE database = 'demo' AND table = 'sensor_hourly' AND active) AS hourly_parts`);
    console.log(
      `${new Date().toLocaleTimeString("th-TH")} | insert ${insertMs}ms | raw ${s?.raw} แถว, long ${s?.long} แถว | parts: long ${s?.long_parts}, hourly ${s?.hourly_parts}`,
    );
  }

  await Bun.sleep(Math.max(0, 1000 - (Date.now() - started))); // รักษาจังหวะ 1 วิ
}
await ch.close();
console.log("หยุดแล้ว");
