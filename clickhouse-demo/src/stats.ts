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
// RESPONSE_EXAMPLES
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
