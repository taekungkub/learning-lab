// bun run examples/10-simulator.ts            (ต้องรัน 08 ก่อน: ใช้ schema sensor_*)
// DEVICES=100 bun run examples/10-simulator.ts  (เปลี่ยนจำนวน device ได้)
// จำลอง device ส่งข้อมูลทุก 1 วิ: รวมทุก device เป็น 1 batch ต่อวินาที แล้ว insert เข้า sensor_raw
// (ระบบจริงตัวกลาง เช่น Kafka/service รวม batch ให้ device ห้าม insert เองทีละตัว)
// Ctrl+C หยุด
import { ch, rows } from "../src/ch";

const DEVICES = Number(process.env.DEVICES ?? 10);

// ครึ่งหนึ่งเป็นเครื่องวัดอุณหภูมิ (th-*) อีกครึ่งเป็นมิเตอร์ไฟ (pm-*) key ต่างกัน
const devices = Array.from({ length: DEVICES }, (_, i) =>
  i % 2 === 0 ? { id: `th-${i / 2 + 1}`, kind: "th" as const } : { id: `pm-${(i + 1) / 2}`, kind: "pm" as const },
);

// ค่าเดินแบบ random walk รอบค่ากลาง (ดูเป็นกราฟจริงกว่าสุ่มล้วน)
const state = new Map<string, number>();
const walk = (key: string, base: number, spread: number) => {
  const v = (state.get(key) ?? base) + (Math.random() - 0.5) * spread * 0.1;
  const clamped = Math.min(base + spread, Math.max(base - spread, v));
  state.set(key, clamped);
  return Math.round(clamped * 10) / 10;
};

const payload = (d: (typeof devices)[number], ts: number) =>
  d.kind === "th"
    ? { ts, sensor: d.id, data: { temp: walk(`${d.id}.temp`, 27, 5), humidity: walk(`${d.id}.hum`, 60, 15), status: "ok" } }
    : { ts, sensor: d.id, data: { voltage: walk(`${d.id}.v`, 220, 5), current: walk(`${d.id}.a`, 3, 2) } };

let running = true;
process.on("SIGINT", () => (running = false));

console.log(`ส่ง ${DEVICES} device ทุก 1 วิ (Ctrl+C หยุด)`);
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
