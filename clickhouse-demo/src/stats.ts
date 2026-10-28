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
// fleet: รวมทุก sensor ที่เลือก avg ถ่วงน้ำหนักตาม samples (device ที่ส่งถี่มีน้ำหนักมากกว่า)
const GROUP_BY = { device: "sensor, metric", fleet: "metric" } as const;
export type GroupBy = keyof typeof GROUP_BY;

// กัน request เดียว scan ทั้ง fleet 10k device แบบแยกตัว: เกินนี้ให้ใช้ groupBy "fleet" (sensors ว่าง)
// ponytail: ค่าคงที่ ถ้าต่าง tenant ต่างเพดานค่อยย้ายไป config
export const MAX_SENSORS = 100;

export type StatsQuery = {
  sensors?: string[]; // ว่าง = ทุก device (ใช้ได้กับ groupBy "fleet" เท่านั้น)
  metrics?: string[]; // ว่าง = ทุก metric
  grain: Grain;
  groupBy?: GroupBy; // default "device"
  from: string; // เวลาไทย 'YYYY-MM-DD HH:MM:SS' (รวม)
  to: string; // ไม่รวม / month, year ใช้แค่ส่วนวันที่
};

export type StatsRow = {
  t: string | number; // hour "YYYY-MM-DD HH:MM:SS", day "YYYY-MM-DD", month วันแรกของเดือน, year ตัวเลข
  sensor?: string; // groupBy "device"
  devices?: number; // groupBy "fleet": จำนวน device ที่มีข้อมูลใน bucket นั้น
  metric: string;
  n: number;
  avg: number;
  min: number;
  max: number;
  sum: number;
  diff: number | null; // avg - avg ของ bucket ก่อนหน้าใน series เดียวกัน (bucket แรก null)
};

export type StatsResponse = {
  meta: {
    grain: Grain;
    groupBy: GroupBy;
    from: string;
    to: string;
    tz: "Asia/Bangkok";
    source: "sensor_hourly" | "sensor_daily";
    sensors: string[]; // ที่ขอมา ([] = ทุก device)
    metrics: string[]; // ที่ขอมา ([] = ทุก metric)
    rows: number;
    took_ms: number;
  };
  data: StatsRow[]; // long: 1 แถวต่อ (sensor), metric, t เรียงตาม (sensor), metric, t
};

// ตัวอย่าง response (ค่าจริงจาก example 09):
//
// 1) device เดียว หลาย metric
// getStats({ sensors: ["th-1"], metrics: ["temp", "humidity"], grain: "hour", from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00" })
// {
//   meta: { grain: "hour", groupBy: "device", from: "2026-10-27 00:00:00", to: "2026-10-28 00:00:00", tz: "Asia/Bangkok",
//           source: "sensor_hourly", sensors: ["th-1"], metrics: ["temp", "humidity"], rows: 48, took_ms: 39 },
//   data: [
//     { t: "2026-10-27 00:00:00", sensor: "th-1", metric: "humidity", n: 3600, avg: 71.74, min: 68.73, max: 74.73, sum: 258256.31, diff: null },
//     { t: "2026-10-27 01:00:00", sensor: "th-1", metric: "humidity", n: 3600, avg: 73.04, min: 70,    max: 76,    sum: 262941.92, diff: 1.3 },
//     ... 24 ชม. × 2 metric (diff เริ่มใหม่ต่อ series)
//   ]
// }
//
// 2) หลาย device → data 1 แถวต่อ (sensor, metric, t)
// getStats({ sensors: ["th-1", "th-2", "th-3"], metrics: ["temp"], grain: "day", ...7 วัน })
//   data: [{ t: "2026-10-21", sensor: "th-1", metric: "temp", n: 86400, avg: 22.23, ... }, ... 3 × 7 แถว]
//
//   toSeries(data) → กราฟเส้น 1 series ต่อ (sensor, metric)
//   [{ key: "th-1.temp", sensor: "th-1", metric: "temp",
//      points: [{ t: "2026-10-21", n: 86400, avg: 22.23, min: 18.22, max: 26.24, sum: 1920562.98, diff: null }, ...] }, ...]
//
//   toWide(data, "avg") → ตาราง/CSV 1 แถวต่อ t
//   [{ t: "2026-10-21", "th-1.temp": 22.23, "th-2.temp": 23.24, "th-3.temp": 24.23 }, ...]
//
// 3) กลุ่ม device รวมเป็นค่าเดียว (groupBy "fleet" + sensors) / ทั้ง fleet (sensors ว่าง)
// getStats({ sensors: ["pm-1", "pm-2"], metrics: ["power_kw"], grain: "month", groupBy: "fleet", ... })  อ่าน sensor_daily
//   data: [{ t: "2023-10-01", metric: "power_kw", devices: 2, n: 576000, avg: 8.8, min: 3.93, max: 13.43, sum: 5071146.6, diff: null }, ...]
//
// 4) รายปี t เป็นตัวเลข อ่าน sensor_daily (เกิน TTL hourly 2 ปีได้)
//   data: [{ t: 2023, sensor: "th-1", metric: "temp", n: 5558400, avg: 24.02, ... }, { t: 2024, ..., diff: 1.98 }, ...]
//
// bucket ที่ไม่มีข้อมูลไม่มีแถว (ไม่เติม 0) / input นอก whitelist หรือเกินเพดาน → throw Error
export async function getStats(q: StatsQuery): Promise<StatsResponse> {
  const groupBy = q.groupBy ?? "device";
  const sensors = q.sensors ?? [];
  const metrics = q.metrics ?? [];
  if (!Object.hasOwn(GRAIN, q.grain)) throw new Error(`grain ต้องเป็น ${Object.keys(GRAIN).join(" | ")}`);
  if (!Object.hasOwn(GROUP_BY, groupBy)) throw new Error(`groupBy ต้องเป็น ${Object.keys(GROUP_BY).join(" | ")}`);
  if (sensors.length > MAX_SENSORS) throw new Error(`sensors ได้ไม่เกิน ${MAX_SENSORS} ตัว`);
  if (groupBy === "device" && sensors.length === 0) throw new Error(`groupBy "device" ต้องระบุ sensors (ทุก device ใช้ "fleet")`);

  const g = GRAIN[q.grain];
  const by = GROUP_BY[groupBy];
  const t0 = performance.now();
  // has() ยังใช้ primary index (sensor ตัวแรกของ ORDER BY) ได้ ตรวจด้วย EXPLAIN แล้ว
  const data = await rows<StatsRow>(
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
       WHERE (empty({sensors:Array(String)}) OR has({sensors:Array(String)}, sensor))
         AND ${RANGE[g.time]}
         AND (empty({metrics:Array(String)}) OR has({metrics:Array(String)}, metric))
       GROUP BY t, ${by}
     )
     WINDOW w AS (PARTITION BY ${by} ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
     ORDER BY ${by}, t`,
    { sensors, metrics, from: q.from, to: q.to },
  );
  return {
    meta: {
      grain: q.grain, groupBy, from: q.from, to: q.to, tz: "Asia/Bangkok", source: g.table,
      sensors, metrics, rows: data.length, took_ms: Math.round(performance.now() - t0),
    },
    data,
  };
}

// ---- แปลงรูปแบบ (ฝั่ง API เลือกตาม use case ไม่ต้อง query ใหม่) ----

const keyOf = (r: StatsRow) => (r.sensor ? `${r.sensor}.${r.metric}` : r.metric);

// กราฟเส้น: 1 series ต่อ (sensor, metric)
export type Series = {
  key: string; // "th-1.temp" หรือ "temp" (fleet)
  sensor?: string;
  metric: string;
  points: Omit<StatsRow, "sensor" | "metric">[];
};
export function toSeries(data: StatsRow[]): Series[] {
  const map = new Map<string, Series>();
  for (const { sensor, metric, ...p } of data) {
    const key = keyOf({ sensor, metric } as StatsRow);
    if (!map.has(key)) map.set(key, { key, ...(sensor ? { sensor } : {}), metric, points: [] });
    map.get(key)!.points.push(p);
  }
  return [...map.values()];
}

// ตาราง/CSV/กราฟหลายเส้นแกนเดียว: 1 แถวต่อ t คอลัมน์ = "sensor.metric" (หรือ "metric" ถ้า fleet)
// bucket ที่ series ไหนไม่มีข้อมูล คอลัมน์นั้นเป็น null (แถวยังอยู่ ไม่หาย)
export type WideRow = { t: string | number } & Record<string, number | null>;
export function toWide(data: StatsRow[], field: "avg" | "min" | "max" | "sum" | "n" | "diff" = "avg"): WideRow[] {
  const keys = [...new Set(data.map(keyOf))];
  const byT = new Map<string | number, WideRow>();
  for (const r of data) {
    if (!byT.has(r.t)) byT.set(r.t, Object.fromEntries([["t", r.t], ...keys.map((k) => [k, null])]) as WideRow);
    byT.get(r.t)![keyOf(r)] = r[field];
  }
  return [...byT.values()].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
}
