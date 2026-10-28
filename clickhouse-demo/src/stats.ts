import { rows } from "./ch";

// grain → ตารางต้นทาง + expression ของ bucket (whitelist: ห้ามรับ SQL จาก caller)
// hour/day อ่าน sensor_hourly (TTL 2 ปี) ตัดเวลาไทยตอน query
// month/year อ่าน sensor_daily (ไม่มี TTL, วันไทยถูกตัดไว้ตอน MV เขียน) ดูย้อนหลังได้เกิน 2 ปี
const GRAIN = {
  hour: { table: "sensor_hourly", time: "hour", bucket: "toTimeZone(hour, 'Asia/Bangkok')" },
  day: { table: "sensor_hourly", time: "hour", bucket: "toDate(hour, 'Asia/Bangkok')" },
  month: { table: "sensor_daily", time: "day", bucket: "toStartOfMonth(day)" },
  year: { table: "sensor_daily", time: "day", bucket: "toYear(day)" },
} as const;
export type Grain = keyof typeof GRAIN;

// from/to ตามชนิดคอลัมน์เวลา: hour = DateTime (UTC), day = Date (วันไทยอยู่แล้ว)
const RANGE = {
  hour: "hour >= toDateTime({from:String}, 'Asia/Bangkok') AND hour < toDateTime({to:String}, 'Asia/Bangkok')",
  day: "day >= toDate(toDateTime({from:String}, 'Asia/Bangkok')) AND day < toDate(toDateTime({to:String}, 'Asia/Bangkok'))",
} as const;

// groupBy → คอลัมน์ที่แยกกลุ่ม (whitelist เหมือน GRAIN)
// fleet: avg ถ่วงน้ำหนักตาม samples (device ที่ส่งถี่มีน้ำหนักมากกว่า)
const GROUP_BY = { device: "sensor, metric", fleet: "metric" } as const;
export type GroupBy = keyof typeof GROUP_BY;

export type StatsRow = {
  t: string | number;
  sensor?: string; // groupBy: "device"
  devices?: number; // groupBy: "fleet" จำนวน device ที่มีข้อมูลใน bucket นั้น
  metric: string;
  n: number;
  avg: number;
  min: number;
  max: number;
  sum: number;
  diff: number | null; // avg - avg ของ bucket ก่อนหน้า (bucket แรกเป็น NULL)
};

// from/to: เวลาไทย 'YYYY-MM-DD HH:MM:SS' (to ไม่รวม) month/year ใช้แค่ส่วนวันที่
// metrics ว่าง = ทุก metric, sensor ไม่ใส่ = ทุก device, groupBy ไม่ใส่ = "device"
// เรียงตาม (sensor), metric แล้ว t
// ค่าที่ได้จริงจาก example 09 (ข้อมูล 11-backfill รายวินาที):
//
// hour  getStats({ sensor: "th-1", grain: "hour", metrics: ["temp"], from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-27 00:00:00", sensor: "th-1", metric: "temp", n: 3600, avg: 20.24, min: 19.25, max: 21.25, sum: 72871.2,  diff: null },
//   { t: "2026-10-27 01:00:00", sensor: "th-1", metric: "temp", n: 3600, avg: 19.77, min: 18.77, max: 20.77, sum: 71185.13, diff: -0.47 },
//   ... 24 แถว
// ]
//
// day   getStats({ sensor: "th-1", grain: "day", metrics: ["temp", "humidity"], from: "2026-10-21 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-21", sensor: "th-1", metric: "humidity", n: 86400, avg: 66.41, min: 55.4,  max: 77.46, sum: 5737560.91, diff: null },
//   { t: "2026-10-22", sensor: "th-1", metric: "humidity", n: 86400, avg: 66.36, min: 55.34, max: 77.4,  sum: 5733300.29, diff: -0.05 },
//   ...
//   { t: "2026-10-21", sensor: "th-1", metric: "temp", ... diff: null },  // diff เริ่มใหม่ต่อ metric
//   ... 7 วัน × 2 metric
// ]
//
// month getStats({ sensor: "pm-1", grain: "month", metrics: ["power_kw"], ... })  อ่าน sensor_daily
// [
//   { t: "2023-10-01", sensor: "pm-1", metric: "power_kw", n: 291600,  avg: 8.61, min: 3.91, max: 12.95, sum: 2509248.46,  diff: null },  // t = วันแรกของเดือน
//   { t: "2023-11-01", sensor: "pm-1", metric: "power_kw", n: 2592000, avg: 8.7,  min: 3.95, max: 13.49, sum: 22546083.54, diff: 0.09 },
//   ...
// ]
//
// year  getStats({ sensor: "th-1", grain: "year", metrics: ["temp"], ... })  อ่าน sensor_daily (เกิน TTL hourly 2 ปีได้)
// [
//   { t: 2023, sensor: "th-1", metric: "temp", n: 5562000,  avg: 24.02, min: 18.43, max: 30, sum: 133596994.94, diff: null },  // t เป็นตัวเลข
//   { t: 2024, sensor: "th-1", metric: "temp", n: 31622400, avg: 26,    min: 18,    max: 34, sum: 822183563.01, diff: 1.98 },
//   ...
// ]
//
// ทุก device แยกตัว  getStats({ grain: "day", metrics: ["temp"], from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-27", sensor: "th-1", metric: "temp", n: 86400, avg: 22.4,  min: 18.37, max: 26.4, sum: 1934957.17, diff: null },
//   { t: "2026-10-27", sensor: "th-2", metric: "temp", n: 86400, avg: 23.39, min: 19.37, max: 27.4, sum: 2020863.7,  diff: null },
//   ... th-1..5
// ]
//
// รวมทั้ง fleet  getStats({ grain: "day", groupBy: "fleet", metrics: ["temp", "power_kw"], ... })
// [
//   { t: "2026-10-27", metric: "power_kw", devices: 5, n: 432000, avg: 8.65,  min: 3.64,  max: 13.65, sum: 3735536.2,   diff: null },
//   { t: "2026-10-27", metric: "temp",     devices: 5, n: 432000, avg: 23.39, min: 18.37, max: 28.4,  sum: 10105443.43, diff: null },
// ]
//
// bucket ที่ไม่มีข้อมูลจะไม่มีแถว (ไม่เติม 0) / grain, groupBy นอก whitelist → throw Error
export async function getStats(q: {
  sensor?: string;
  groupBy?: GroupBy;
  grain: Grain;
  from: string;
  to: string;
  metrics?: string[];
}) {
  const groupBy = q.groupBy ?? "device";
  if (!Object.hasOwn(GRAIN, q.grain)) throw new Error(`grain ต้องเป็น ${Object.keys(GRAIN).join(" | ")}`);
  if (!Object.hasOwn(GROUP_BY, groupBy)) throw new Error(`groupBy ต้องเป็น ${Object.keys(GROUP_BY).join(" | ")}`);
  const g = GRAIN[q.grain];
  const by = GROUP_BY[groupBy];
  return rows<StatsRow>(
    `SELECT *, if(row_number() OVER w = 1, NULL, round(avg - lagInFrame(avg) OVER w, 2)) AS diff
     FROM (
       SELECT ${g.bucket} AS t, ${by},
              ${groupBy === "fleet" ? "toUInt32(uniqExact(sensor)) AS devices," : ""}
              toUInt32(countMerge(samples))                     AS n,
              round(avgMerge(avg_v), 2)                         AS avg,
              min(min_v)                                        AS min,
              max(max_v)                                        AS max,
              round(avgMerge(avg_v) * countMerge(samples), 2)   AS sum
       FROM ${g.table}
       WHERE (empty({sensor:String}) OR sensor = {sensor:String})
         AND ${RANGE[g.time]}
         AND (empty({metrics:Array(String)}) OR has({metrics:Array(String)}, metric))
       GROUP BY t, ${by}
     )
     WINDOW w AS (PARTITION BY ${by} ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
     ORDER BY ${by}, t`,
    { sensor: q.sensor ?? "", from: q.from, to: q.to, metrics: q.metrics ?? [] },
  );
}
