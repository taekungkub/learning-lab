import { rows } from "./ch";

// grain → expression ของ bucket (whitelist: ห้ามรับ SQL จาก caller)
// ทุก grain อ่านจาก sensor_hourly แล้วตัดเวลาตามเวลาไทยตอน query
// ponytail: month/year อ่าน hourly (8,760 แถวต่อ series ต่อปี) ถ้าช้าค่อยชี้ไป sensor_daily
const GRAIN = {
  hour: "toTimeZone(hour, 'Asia/Bangkok')",
  day: "toDate(hour, 'Asia/Bangkok')",
  month: "toStartOfMonth(hour, 'Asia/Bangkok')",
  year: "toYear(hour, 'Asia/Bangkok')",
} as const;
export type Grain = keyof typeof GRAIN;

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

// from/to: เวลาไทย 'YYYY-MM-DD HH:MM:SS' (to ไม่รวม), metrics ว่าง = ทุก metric
// sensor ไม่ใส่ = ทุก device, groupBy ไม่ใส่ = "device"
// เรียงตาม (sensor), metric แล้ว t, ค่าที่ได้จริงจาก example 09:
//
// hour  getStats({ sensor: "th-1", grain: "hour", metrics: ["temp"], from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-27 00:00:00", metric: "temp", n: 12, avg: 22.74, min: 21.2, max: 25.5, sum: 272.9, diff: null },
//   { t: "2026-10-27 01:00:00", metric: "temp", n: 12, avg: 23.63, min: 21.1, max: 25.3, sum: 283.6, diff: 0.89 },
//   ... 24 แถว
// ]
//
// day   getStats({ sensor: "th-1", grain: "day", from: "2026-10-21 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-21", metric: "humidity", n: 288, avg: 60.04, min: 50, max: 69.9, sum: 17290.3, diff: null },
//   ...
//   { t: "2026-10-21", metric: "temp",     n: 288, avg: 22.8,  min: 20.3, max: 25.3, sum: 6566.9, diff: null },  // diff เริ่มใหม่ต่อ metric
//   { t: "2026-10-22", metric: "temp",     n: 288, avg: 22.72, min: 20.3, max: 25.3, sum: 6543.6, diff: -0.08 },
//   ... 7 วัน × 2 metric
// ]
//
// month getStats({ sensor: "pm-1", grain: "month", metrics: ["voltage"], ... })
// [
//   { t: "2025-09-01", metric: "voltage", n: 2136, avg: 220, min: 218, max: 222, sum: 469909.4, diff: null },  // t = วันแรกของเดือน
//   { t: "2025-10-01", metric: "voltage", n: 8928, avg: 220, min: 218, max: 222, sum: 1964134.4, diff: 0 },
//   ...
// ]
//
// year  getStats({ sensor: "th-1", grain: "year", metrics: ["temp"], ... })
// [
//   { t: 2025, metric: "temp", n: 28632, avg: 24.18, min: 20, max: 30, sum: 692350, diff: null },  // t เป็นตัวเลข
//   { t: 2026, metric: "temp", n: 86568, avg: 28.03, min: 20, max: 35, sum: 2426863.8, diff: 3.85 },
// ]
//
// ทุก device แยกตัว  getStats({ grain: "day", from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00" })
// [
//   { t: "2026-10-27", sensor: "pm-1", metric: "current",  n: 288, avg: 3.43,  min: 2,    max: 5,    sum: 987.3,  diff: null },
//   { t: "2026-10-27", sensor: "pm-1", metric: "voltage",  n: 288, avg: 219.9, min: 218,  max: 222,  sum: 63332.2, diff: null },
//   { t: "2026-10-27", sensor: "th-1", metric: "humidity", n: 288, avg: 59.51, min: 50,   max: 70,   sum: 17140.2, diff: null },
//   { t: "2026-10-27", sensor: "th-1", metric: "temp",     n: 288, avg: 22.87, min: 20.5, max: 25.5, sum: 6585.9, diff: null },
//   { t: "2026-10-27", sensor: "th-2", metric: "humidity", n: 288, avg: 49.51, min: 40,   max: 60,   sum: 14260.2, diff: null },
//   { t: "2026-10-27", sensor: "th-2", metric: "temp",     n: 288, avg: 27.87, min: 25.5, max: 30.5, sum: 8025.9, diff: null },
// ]
//
// รวมทั้ง fleet  getStats({ grain: "day", groupBy: "fleet", ... })
// [
//   { t: "2026-10-27", metric: "current",  devices: 1, n: 288, avg: 3.43,  min: 2,    max: 5,    sum: 987.3,   diff: null },
//   { t: "2026-10-27", metric: "humidity", devices: 2, n: 576, avg: 54.51, min: 40,   max: 70,   sum: 31400.4, diff: null },
//   { t: "2026-10-27", metric: "temp",     devices: 2, n: 576, avg: 25.37, min: 20.5, max: 30.5, sum: 14611.8, diff: null },  // th-1 + th-2
//   { t: "2026-10-27", metric: "voltage",  devices: 1, n: 288, avg: 219.9, min: 218,  max: 222,  sum: 63332.2, diff: null },
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
  const by = GROUP_BY[groupBy];
  return rows<StatsRow>(
    `SELECT *, if(row_number() OVER w = 1, NULL, round(avg - lagInFrame(avg) OVER w, 2)) AS diff
     FROM (
       SELECT ${GRAIN[q.grain]} AS t, ${by},
              ${groupBy === "fleet" ? "toUInt32(uniqExact(sensor)) AS devices," : ""}
              toUInt32(countMerge(samples))                     AS n,
              round(avgMerge(avg_v), 2)                         AS avg,
              min(min_v)                                        AS min,
              max(max_v)                                        AS max,
              round(avgMerge(avg_v) * countMerge(samples), 2)   AS sum
       FROM sensor_hourly
       WHERE (empty({sensor:String}) OR sensor = {sensor:String})
         AND hour >= toDateTime({from:String}, 'Asia/Bangkok')
         AND hour <  toDateTime({to:String}, 'Asia/Bangkok')
         AND (empty({metrics:Array(String)}) OR has({metrics:Array(String)}, metric))
       GROUP BY t, ${by}
     )
     WINDOW w AS (PARTITION BY ${by} ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
     ORDER BY ${by}, t`,
    { sensor: q.sensor ?? "", from: q.from, to: q.to, metrics: q.metrics ?? [] },
  );
}
