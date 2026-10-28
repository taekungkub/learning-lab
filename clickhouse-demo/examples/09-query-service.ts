// bun run examples/09-query-service.ts   (ต้องรัน 08 แล้ว 11-backfill ก่อน: อ่านข้อมูลที่มีอยู่ ไม่เขียนอะไร)
// service function getStats (src/stats.ts): hour/day จาก sensor_hourly, month/year จาก sensor_daily
import { ch, rows } from "../src/ch";
import { getStats, type StatsRow } from "../src/stats";

// วันที่ตามเวลาไทย 'YYYY-MM-DD' (offset วันจากวันนี้)
const bkkDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const ALL = { from: "2000-01-01 00:00:00", to: "2100-01-01 00:00:00" };
const yesterday = { from: `${bkkDate(-1)} 00:00:00`, to: `${bkkDate(0)} 00:00:00` };

async function show(label: string, q: Parameters<typeof getStats>[0], limit = 6) {
  const t0 = performance.now();
  const r = await getStats(q);
  console.log(`\n${label}  (${r.length} แถว, ${(performance.now() - t0).toFixed(0)} ms)`);
  console.table(r.slice(0, limit));
  return r;
}

const hour = await show("รายชั่วโมง เมื่อวาน (th-1 temp)", { sensor: "th-1", grain: "hour", metrics: ["temp"], ...yesterday });
await show("รายวัน 7 วันล่าสุด (th-1 temp, humidity)", {
  sensor: "th-1", grain: "day", metrics: ["temp", "humidity"],
  from: `${bkkDate(-7)} 00:00:00`, to: `${bkkDate(0)} 00:00:00`,
});
await show("รายเดือน (pm-1 power_kw)", { sensor: "pm-1", grain: "month", metrics: ["power_kw"], ...ALL });
const year = await show("รายปี (th-1 temp) จาก daily: เห็นเกิน TTL hourly 2 ปี", {
  sensor: "th-1", grain: "year", metrics: ["temp"], ...ALL,
});
const perDevice = await show("เมื่อวาน ทุก device แยกตัว (temp)", { grain: "day", metrics: ["temp"], ...yesterday });
const fleet = await show("เมื่อวาน รวมทั้ง fleet (temp, power_kw)", {
  grain: "day", groupBy: "fleet", metrics: ["temp", "power_kw"], ...yesterday,
});

// ---- self-check ----
const near = (a: StatsRow, b: Omit<StatsRow, "sum" | "diff">) =>
  String(a.t) === String(b.t) && a.n === b.n && a.min === b.min && a.max === b.max && Math.abs(a.avg - b.avg) <= 0.01;
const same = (got: StatsRow[], want: Omit<StatsRow, "sum" | "diff">[]) =>
  got.length === want.length && got.every((g, i) => near(g, want[i]!));

const okHour = hour.length === 24 && hour[0]?.diff === null && hour.every((r) => r.n === 3600);

// day (อ่าน hourly) ต้องตรงกับ sensor_daily ช่วงที่ hourly ยังมี (2 ปีล่าสุด)
const recent = { from: `${bkkDate(-365)} 00:00:00`, to: `${bkkDate(0)} 00:00:00` };
const dayGot = await getStats({ sensor: "th-1", grain: "day", metrics: ["temp"], ...recent });
const dayWant = await rows<Omit<StatsRow, "sum" | "diff">>(
  `SELECT day AS t, metric, toUInt32(countMerge(samples)) AS n, round(avgMerge(avg_v), 2) AS avg,
          min(min_v) AS min, max(max_v) AS max
   FROM sensor_daily
   WHERE sensor = 'th-1' AND metric = 'temp'
     AND day >= toDate({from:String}) AND day < toDate({to:String})
   GROUP BY t, metric ORDER BY metric, t`,
  { from: recent.from.slice(0, 10), to: recent.to.slice(0, 10) },
);
const okDay = dayGot.length === 365 && same(dayGot, dayWant);

// year (อ่าน daily) ต้องครอบคลุมเกิน 2 ปี และ n รวม = จำนวนวินาทีทั้งหมดใน sensor_daily
const [d] = await rows<{ n: number; years: number }>(
  `SELECT toUInt32(countMerge(samples)) AS n, uniqExact(toYear(day)) AS years
   FROM sensor_daily WHERE sensor = 'th-1' AND metric = 'temp'`,
);
const okYear = year.length === d?.years && year.length >= 3 && year.reduce((s, r) => s + r.n, 0) === d.n;

// fleet = รวมทุก th-*: devices = จำนวน th, n รวมกัน, avg ถ่วงน้ำหนัก, min/max ของทั้งหมด
const fleetTemp = fleet.find((r) => r.metric === "temp");
const weighted = perDevice.reduce((s, r) => s + r.avg * r.n, 0) / perDevice.reduce((s, r) => s + r.n, 0);
const okFleet =
  fleetTemp?.devices === perDevice.length &&
  fleetTemp.n === perDevice.reduce((s, r) => s + r.n, 0) &&
  fleetTemp.min === Math.min(...perDevice.map((r) => r.min)) &&
  fleetTemp.max === Math.max(...perDevice.map((r) => r.max)) &&
  Math.abs(fleetTemp.avg - weighted) <= 0.01;

console.assert(okHour && okDay && okYear && okFleet, "ผลไม่ตรง");
console.log(`\nhour 24 ชม. ครบชั่วโมงละ 3600: ${okHour} | day (hourly) ตรงกับ sensor_daily 365 วัน: ${okDay}`);
console.log(`year ครอบคลุม ${year.length} ปี n ตรงกับ daily: ${okYear} | fleet temp = รวม ${perDevice.length} device (avg ถ่วงน้ำหนัก ${weighted.toFixed(2)}): ${okFleet}`);

// grain / groupBy นอก whitelist ต้องถูกปฏิเสธ
const bad = await getStats({ sensor: "th-1", grain: "minute" as never, ...ALL }).catch((e: Error) => e.message);
console.log("grain ผิด:", bad);
const badBy = await getStats({ grain: "day", groupBy: "sensor; DROP TABLE x" as never, ...ALL }).catch((e: Error) => e.message);
console.log("groupBy ผิด:", badBy);
await ch.close();
