// bun run examples/09-query-service.ts   (ต้องรัน 08 แล้ว 11-backfill ก่อน: อ่านข้อมูลที่มีอยู่ ไม่เขียนอะไร)
// service function getStats (src/stats.ts): หลาย sensor, หลาย metric, response { meta, data }
// + toSeries / toWide แปลงรูปแบบตาม use case
import { ch, rows } from "../src/ch";
import { getStats, MAX_SENSORS, toSeries, toWide, type StatsQuery, type StatsRow } from "../src/stats";

// วันที่ตามเวลาไทย 'YYYY-MM-DD' (offset วันจากวันนี้)
const bkkDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const ALL = { from: "2000-01-01 00:00:00", to: "2100-01-01 00:00:00" };
const yesterday = { from: `${bkkDate(-1)} 00:00:00`, to: `${bkkDate(0)} 00:00:00` };
const last7 = { from: `${bkkDate(-7)} 00:00:00`, to: `${bkkDate(0)} 00:00:00` };

async function show(label: string, q: StatsQuery, limit = 6) {
  const r = await getStats(q);
  console.log(`\n== ${label}`);
  console.log("meta:", JSON.stringify(r.meta));
  console.table(r.data.slice(0, limit));
  return r;
}

// use case 1: กราฟ device เดียว หลาย metric
const one = await show("1) th-1 temp + humidity รายชั่วโมงเมื่อวาน", {
  sensors: ["th-1"], metrics: ["temp", "humidity"], grain: "hour", ...yesterday,
});

// use case 2: เทียบหลาย device (กราฟหลายเส้น) → toSeries
const multi = await show("2) th-1..3 temp รายวัน 7 วัน", {
  sensors: ["th-1", "th-2", "th-3"], metrics: ["temp"], grain: "day", ...last7,
});
const series = toSeries(multi.data);
console.log("toSeries:", series.map((s) => `${s.key} (${s.points.length} จุด)`).join(", "));
console.log("ตัวอย่าง series[0]:", JSON.stringify({ ...series[0], points: series[0]!.points.slice(0, 2) }));

// use case 3: ตาราง/CSV 1 แถวต่อวัน คอลัมน์ = device → toWide
console.log("\ntoWide (avg):");
console.table(toWide(multi.data));

// use case 4: กลุ่ม device (เช่น อาคาร A = pm-1, pm-2) รวมเป็นค่าเดียว → groupBy fleet + sensors
const group = await show("4) อาคาร A (pm-1 + pm-2) power_kw รายเดือน", {
  sensors: ["pm-1", "pm-2"], metrics: ["power_kw"], grain: "month", groupBy: "fleet", ...ALL,
}, 3);

// use case 5: ทั้ง fleet (ไม่ระบุ sensors)
const fleet = await show("5) ทั้ง fleet temp + power_kw เมื่อวาน", {
  metrics: ["temp", "power_kw"], grain: "day", groupBy: "fleet", ...yesterday,
});

// use case 6: รายปีย้อนหลังเกิน TTL hourly (อ่าน daily)
const year = await show("6) th-1 temp รายปี", { sensors: ["th-1"], metrics: ["temp"], grain: "year", ...ALL });

// ---- self-check ----
// 1: 2 metric × 24 ชม. ครบชั่วโมงละ 3600
const ok1 = one.data.length === 48 && one.data.every((r) => r.n === 3600) && one.meta.source === "sensor_hourly";

// 2: แต่ละ sensor ใน multi ต้องเท่ากับ query sensor นั้นตัวเดียว
const singles = await Promise.all(
  ["th-1", "th-2", "th-3"].map((s) => getStats({ sensors: [s], metrics: ["temp"], grain: "day", ...last7 })),
);
const ok2 =
  series.length === 3 &&
  JSON.stringify(multi.data) === JSON.stringify(singles.flatMap((r) => r.data));

// 3: toWide 7 แถว คอลัมน์ t + 3 sensor และค่าตรงกับ data
const wide = toWide(multi.data);
const ok3 =
  wide.length === 7 &&
  Object.keys(wide[0]!).join() === "t,th-1.temp,th-2.temp,th-3.temp" &&
  wide[0]!["th-2.temp"] === multi.data.find((r) => r.sensor === "th-2" && r.t === wide[0]!.t)!.avg;

// 4: กลุ่ม = รวม pm-1 + pm-2 (n รวม, avg ถ่วงน้ำหนัก) อ่าน daily
const parts = await getStats({ sensors: ["pm-1", "pm-2"], metrics: ["power_kw"], grain: "month", ...ALL });
const g0 = group.data[0]!;
const p0 = parts.data.filter((r) => r.t === g0.t);
const ok4 =
  group.meta.source === "sensor_daily" && g0.devices === 2 &&
  g0.n === p0.reduce((s, r) => s + r.n, 0) &&
  Math.abs(g0.avg - p0.reduce((s, r) => s + r.avg * r.n, 0) / g0.n) <= 0.01;

// 5: fleet temp devices = จำนวน th ทั้งหมด
const [{ th }] = await rows<{ th: number }>("SELECT uniqExact(sensor) AS th FROM sensor_daily WHERE metric = 'temp'");
const ok5 = fleet.data.find((r) => r.metric === "temp")?.devices === th;

// 6: year ครอบคลุมเกิน 2 ปี
const ok6 = year.data.length >= 3 && year.meta.source === "sensor_daily";

console.assert(ok1 && ok2 && ok3 && ok4 && ok5 && ok6, "ผลไม่ตรง");
console.log(`\ncheck: 1=${ok1} 2=${ok2} 3=${ok3} 4=${ok4} 5=${ok5} 6=${ok6}`);

// input ผิดต้องถูกปฏิเสธ
const err = (q: StatsQuery) => getStats(q).then(() => "ไม่ error", (e: Error) => e.message);
console.log("grain ผิด:", await err({ sensors: ["th-1"], grain: "minute" as never, ...ALL }));
console.log("groupBy ผิด:", await err({ sensors: ["th-1"], grain: "day", groupBy: "x; DROP TABLE y" as never, ...ALL }));
console.log("device ไม่ระบุ sensors:", await err({ grain: "day", ...ALL }));
console.log("sensors เกิน:", await err({ sensors: Array.from({ length: MAX_SENSORS + 1 }, (_, i) => `x-${i}`), grain: "day", ...ALL }));
// sensor ชื่อแปลกส่งผ่าน query_params ไม่หลุดเป็น SQL
console.log("sensor injection:", (await getStats({ sensors: ["th-1' OR 1=1 --"], grain: "day", ...ALL })).meta.rows, "แถว");
await ch.close();
