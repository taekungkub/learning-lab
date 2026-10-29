// bun run examples/13-api-body.ts                 (ต้องรัน 08 + 11 ก่อน: อ่านอย่างเดียว รัน body จาก 13-body.json)
// bun run examples/13-api-body.ts body.json       (ส่ง body เอง)
// RUNS=10 CONCURRENCY=5 bun run examples/13-api-body.ts   (ยิงซ้ำ / ยิงพร้อมกัน)
// SUITE=1 bun run examples/13-api-body.ts         (ชุดทดสอบทุก interval)
//
// body แบบ API ระบบเก่า → query บนตารางสรุป: 1m/15m ใช้ sensor_1m (TTL 3 วัน), 1h-7d ใช้ sensor_hourly (TTL 2 ปี)
// bucket ตัดตาม UTC: 24h = วัน UTC (07:00 ไทย), 7d = จันทร์-อาทิตย์ UTC
import { fileURLToPath } from "node:url";
import { ch, rows } from "../src/ch";
import { type Agg, DAY, HOURLY_MAX_AGE, isoZ, toSec, utc } from "../src/api-utils";
import { TTL } from "../src/config";

type Interval = "1m" | "15m" | "1h" | "6h" | "12h" | "24h" | "7d";
type Body = {
  time_range: { from: string; to: string }; // ISO เช่น 2025-07-22T00:00:00Z
  filters: { device_ids: string[] };
  series: {
    name: string;
    metric_keys: string[];
    aggregation: Agg;
    interval: Interval;
    group_by: ("device_id" | "metric_key")[];
  }[];
};

// response: 1 object = 1 เส้นกราฟ / meta = สรุปต่อ series ไว้ debug
type RawSeriesResponse = { name: string; group: Record<string, string>; points: [string, number | null][] };
type Meta = { name: string; aggregation: Agg; interval: Interval; source: string; points_per_series: number; lines: number; rows: number };
type Row = { t: string; sensor?: string; metric?: string; value: number | null };

// จุดต่อเส้นสูงสุด (SUITE ใช้ 5000 ให้ case "เกิน MAX_POINTS" ทดสอบได้)
const MAX_POINTS = Number(process.env.MAX_POINTS ?? (process.env.SUITE ? 5000 : 20000));

// interval → ตาราง + bucket (whitelist) / maxAge = ย้อนหลังได้ตาม TTL ของตารางนั้น
const M1 = { table: "sensor_1m", maxAge: TTL.m1.days * DAY } as const;
const H = { table: "sensor_hourly", maxAge: HOURLY_MAX_AGE } as const;
const INTERVALS: Record<Interval, { table: string; maxAge: number; sec: number; bucket: string }> = {
  "1m": { ...M1, sec: 60, bucket: "ts" },
  "15m": { ...M1, sec: 900, bucket: "toStartOfFifteenMinutes(ts)" },
  "1h": { ...H, sec: 3600, bucket: "ts" },
  "6h": { ...H, sec: 6 * 3600, bucket: "toStartOfInterval(ts, INTERVAL 6 HOUR, 'UTC')" },
  "12h": { ...H, sec: 12 * 3600, bucket: "toStartOfInterval(ts, INTERVAL 12 HOUR, 'UTC')" },
  "24h": { ...H, sec: DAY, bucket: "toStartOfDay(ts, 'UTC')" },
  "7d": { ...H, sec: 7 * DAY, bucket: "toDateTime(toMonday(ts, 'UTC'), 'UTC')" },
};

// aggregation → expression บน state (whitelist) เหมือนกันทั้ง sensor_1m และ sensor_hourly
// last = ค่าล่าสุดตามเวลา (argMax) / diff = last ของ bucket - last ของ bucket ก่อน (หลัง - หน้า) ใช้กับ counter
const AGG: Record<Agg, string> = {
  mean: "round(avgMerge(avg_v), 3)",
  avg: "round(avgMerge(avg_v), 3)",
  sum: "round(avgMerge(avg_v) * countMerge(samples), 3)",
  count: "toUInt32(countMerge(samples))",
  min: "min(min_v)",
  max: "max(max_v)",
  last: "argMaxMerge(last_v)",
  diff: "argMaxMerge(last_v)",
};
const GROUP = { device_id: "sensor", metric_key: "metric" } as const;

// ตรวจ input แล้วสร้าง SQL ของ series เดียว
function plan(body: Body, s: Body["series"][number]) {
  if (!Array.isArray(s.metric_keys) || !Array.isArray(s.group_by)) throw new Error("series ต้องมี metric_keys และ group_by เป็น array");
  if (!Object.hasOwn(AGG, s.aggregation)) throw new Error(`aggregation ต้องเป็น ${Object.keys(AGG).join(" | ")}`);
  if (!Object.hasOwn(INTERVALS, s.interval)) throw new Error(`interval ต้องเป็น ${Object.keys(INTERVALS).join(" | ")}`);
  for (const g of s.group_by) if (!Object.hasOwn(GROUP, g)) throw new Error(`group_by ต้องเป็น ${Object.keys(GROUP).join(" | ")}`);
  if (s.metric_keys.length === 0 || s.metric_keys.length > 20) throw new Error("metric_keys ต้องมี 1-20 ตัว");
  // diff ข้าม device/metric ไม่มีความหมาย (ไฟทั้งอาคาร = ผลรวม diff ของแต่ละมิเตอร์ ไม่ใช่ diff ของ last รวม)
  if (s.aggregation === "diff" && !(s.group_by.includes("device_id") && s.group_by.includes("metric_key")))
    throw new Error('diff ต้อง group_by ["device_id", "metric_key"]');

  const iv = INTERVALS[s.interval];
  const from = toSec(body.time_range.from);
  const to = toSec(body.time_range.to);
  if (to <= from) throw new Error("time_range.to ต้องมากกว่า from");
  if (from < Date.now() / 1000 - iv.maxAge)
    throw new Error(`interval ${s.interval} ย้อนหลังได้ไม่เกิน ${Math.round(iv.maxAge / DAY)} วัน (${iv.table})`);
  const points = Math.ceil((to - from) / iv.sec);
  if (points > MAX_POINTS)
    throw new Error(`interval ${s.interval} ช่วงนี้ได้ ${points} จุดต่อ series เกิน ${MAX_POINTS} ใช้ interval ที่หยาบขึ้น`);

  const by = s.group_by.map((g) => GROUP[g]);
  const cols = by.length ? `, ${by.join(", ")}` : "";
  const diff = s.aggregation === "diff";
  // diff: ดึง bucket ก่อนหน้ามาอีก 1 interval ให้ bucket แรกมี "หน้า" แล้วตัดทิ้งหลังคำนวณ
  const inner = `
    SELECT ${iv.bucket} AS t${cols}, ${AGG[s.aggregation]} AS value
    FROM ${iv.table}
    WHERE has({devices:Array(String)}, sensor) AND has({metrics:Array(String)}, metric)
      AND ts >= toDateTime({from:String}, 'UTC') ${diff ? `- INTERVAL ${iv.sec} SECOND` : ""}
      AND ts <  toDateTime({to:String}, 'UTC')
    GROUP BY t${cols}`;
  const order = `ORDER BY ${[...by, "t"].join(", ")}`;
  const sql = !diff
    ? `${inner} ${order}`
    : `SELECT * FROM (
         SELECT t${cols}, if(row_number() OVER w = 1, NULL, round(value - lagInFrame(value) OVER w, 3)) AS value
         FROM (${inner})
         WINDOW w AS (PARTITION BY ${by.join(", ")} ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
       ) WHERE t >= toDateTime({from:String}, 'UTC') ${order}`;
  return { sql, source: iv.table, points, params: { metrics: s.metric_keys, from: utc(from), to: utc(to) } };
}

async function run(body: Body) {
  const devices = body.filters?.device_ids;
  if (!Array.isArray(devices) || !Array.isArray(body.series) || !body.time_range) throw new Error("body ต้องมี time_range, filters.device_ids, series");
  if (devices.length === 0 || devices.length > 100) throw new Error("device_ids ต้องมี 1-100 ตัว");
  const plans = body.series.map((s) => ({ s, p: plan(body, s) })); // ตรวจทุก series ก่อนยิง
  const t0 = performance.now();
  const results = await Promise.all(
    plans.map(async ({ s, p }) => ({ s, p, data: await rows<Row>(p.sql, { ...p.params, devices }) })),
  );
  // 1 เส้น = 1 (series × group) จุดละ [เวลา ISO UTC, ค่า] (diff bucket แรกเป็น null)
  const series: RawSeriesResponse[] = [];
  const meta: Meta[] = [];
  for (const { s, p, data } of results) {
    const lines = new Map<string, RawSeriesResponse>();
    for (const r of data) {
      const group = Object.fromEntries(s.group_by.map((g) => [g, String(r[GROUP[g]])]));
      const key = JSON.stringify(group);
      if (!lines.has(key)) lines.set(key, { name: s.name, group, points: [] });
      lines.get(key)!.points.push([isoZ(r.t), r.value]);
    }
    series.push(...lines.values());
    meta.push({ name: s.name, aggregation: s.aggregation, interval: s.interval, source: p.source,
      points_per_series: p.points, lines: lines.size, rows: data.length });
  }
  return { took_ms: Math.round(performance.now() - t0), meta, series };
}

const RUNS = Number(process.env.RUNS ?? 1); // >1 = ยิงซ้ำวัด p50/p95 (default ยิงครั้งเดียว)
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 1);
async function bench(body: Body) {
  const times: number[] = [];
  for (let i = 0; i < RUNS; i++) times.push(...(await Promise.all(Array.from({ length: CONCURRENCY }, () => run(body)))).map((r) => r.took_ms));
  times.sort((a, b) => a - b);
  return { p50: times[Math.floor(times.length / 2)]!, p95: times[Math.min(times.length - 1, Math.floor(times.length * 0.95))]! };
}

// ---- body อยู่ที่ examples/13-body.json (แก้ที่นั่น ไม่ต้องแตะโค้ด) ----
// bun run examples/13-api-body.ts            → รัน 13-body.json 1 ครั้ง
// bun run examples/13-api-body.ts other.json → รัน body จากไฟล์อื่นแทน
// SUITE=1 bun run examples/13-api-body.ts    → ชุดทดสอบทุก interval + case ที่ต้อง error
const file = process.argv[2];
if (!process.env.SUITE) {
  const body: Body = await Bun.file(file ?? new URL("./13-body.json", import.meta.url)).json();
  const r = await run(body);
  // terminal แสดง 2 เส้นแรก เส้นละ 3 จุด / ที่เหลืออยู่ในไฟล์
  const head = r.series.slice(0, 2).map((l) => ({ ...l, points: [...l.points.slice(0, 3), `... ${l.points.length} จุด`] }));
  console.log(JSON.stringify({ took_ms: r.took_ms, meta: r.meta, series: [...head, `... ${r.series.length} เส้น`] }, null, 2));
  // response เต็มลงไฟล์ (OUT=path เปลี่ยนที่เก็บ)
  const out = process.env.OUT ?? fileURLToPath(new URL("./13-response.json", import.meta.url));
  await Bun.write(out, JSON.stringify(r, null, 2));
  console.log(`response เต็ม → ${out}`);
  if (RUNS > 1 || CONCURRENCY > 1) {
    const b = await bench(body);
    console.log(`${RUNS} รอบ × ${CONCURRENCY} พร้อมกัน | p50 ${b.p50} ms | p95 ${b.p95} ms`);
  } else console.log(`took ${r.took_ms} ms`);
  await ch.close();
  process.exit(0);
}

// ---- ชุดทดสอบทุก interval (ช่วงเวลาอิงตอนรัน: ข้อมูล 11 จบที่ต้นชั่วโมงที่รัน backfill) ----
const nowH = Math.floor(Date.now() / 1000 / 3600) * 3600;
const today = Math.floor(Date.now() / 1000 / DAY) * DAY; // 00:00 UTC
const iso = (s: number) => new Date(s * 1000).toISOString();
const range = (from: number, to: number) => ({ from: iso(from), to: iso(to) });
const pm = ["pm-1", "pm-2", "pm-3", "pm-4", "pm-5"];
const series = (name: string, aggregation: Agg, interval: Interval, metric_keys: string[]): Body["series"][number] => ({
  name, aggregation, interval, metric_keys, group_by: ["device_id", "metric_key"],
});

const CASES: { label: string; body: Body }[] = [
  { label: "1m 3 ชม.ล่าสุด avg", body: { time_range: range(nowH - 3 * 3600, nowH), filters: { device_ids: ["pm-1", "th-1"] },
    series: [series("p", "avg", "1m", ["power_kw", "temp"])] } },
  { label: "15m 2 วัน last energy", body: { time_range: range(nowH - 2 * DAY, nowH), filters: { device_ids: pm },
    series: [series("e", "last", "15m", ["energy_kwh"])] } },
  // 2 วัน (ไม่เกิน TTL.long): hourly ก่อนรอยต่อ long/hourly ของ 11 สร้างจากการสุ่มทุก 60 วิ last จึงเป็นค่า :59:00 diff ตรงรอยต่อเพี้ยน ~0.17
  { label: "1h 2 วัน diff energy", body: { time_range: range(today - 2 * DAY, today), filters: { device_ids: pm },
    series: [series("e", "diff", "1h", ["energy_kwh"])] } },
  { label: "6h 30 วัน max power", body: { time_range: range(today - 30 * DAY, today), filters: { device_ids: pm },
    series: [series("p", "max", "6h", ["power_kw"])] } },
  // body ระบบเก่า: 1 series diff 24h 8 metric 5 device (แมปชื่อ UUID/metric เป็นของ mock: active_power→power_kw,
  // voltage→voltage_l1, current→current_l1, temperature→temp, energy_total→energy_kwh; th-1 ไว้ให้ temp/humidity)
  { label: "24h body ระบบเก่า (diff)", body: { time_range: { from: "2025-07-22T00:00:00Z", to: "2026-10-20T00:00:00Z" },
    filters: { device_ids: ["pm-1", "pm-2", "pm-3", "pm-4", "th-1"] },
    series: [series("n", "diff", "24h", ["power_kw", "voltage_l1", "current_l1", "temp", "humidity", "energy_kwh", "power_factor", "frequency"])] } },
  { label: "7d 6 เดือน sum + count", body: { time_range: range(today - 182 * DAY, today), filters: { device_ids: pm },
    series: [series("s", "sum", "7d", ["power_kw"]), series("c", "count", "7d", ["power_kw"])] } },
];

const summary = [];
const results: Record<string, Awaited<ReturnType<typeof run>>> = {};
for (const c of CASES) {
  const r = await run(c.body);
  results[c.label] = r;
  const b = RUNS > 1 || CONCURRENCY > 1 ? await bench(c.body) : { p50: r.took_ms, p95: r.took_ms };
  for (const m of r.meta)
    summary.push({ case: c.label, series: m.name, agg: m.aggregation, interval: m.interval, source: m.source,
      points: m.points_per_series, lines: m.lines, rows: m.rows, p50_ms: b.p50, p95_ms: b.p95 });
}
console.table(summary);

console.log("\nตัวอย่าง (เส้นแรก จุดแรกของแต่ละ case):");
for (const [label, r] of Object.entries(results)) {
  const l = r.series[0]!;
  console.log(`${label.padEnd(32)} ${JSON.stringify({ ...l, points: l.points.slice(0, 1) })}`);
}

// input ที่ต้องถูกปฏิเสธ
console.log("\ninput ที่ต้อง error:");
const bad: [string, Body][] = [
  ["1m ย้อนหลัง 7 วัน (เกิน TTL 3 วัน)", { time_range: range(nowH - 7 * DAY, nowH), filters: { device_ids: pm }, series: [series("x", "avg", "1m", ["power_kw"])] }],
  ["1h 15 เดือน (เกิน MAX_POINTS)", { time_range: { from: "2025-07-22T00:00:00Z", to: "2026-10-20T00:00:00Z" }, filters: { device_ids: pm }, series: [series("x", "avg", "1h", ["power_kw"])] }],
  ["diff group_by แค่ metric", { time_range: range(today - DAY, today), filters: { device_ids: pm }, series: [{ ...series("x", "diff", "1h", ["energy_kwh"]), group_by: ["metric_key"] }] }],
  ["interval 5m (ไม่รองรับ)", { time_range: range(nowH - 3600, nowH), filters: { device_ids: pm }, series: [series("x", "avg", "5m" as Interval, ["power_kw"])] }],
];
const errors: string[] = [];
for (const [label, b] of bad) {
  const msg = await run(b).then(() => "ไม่ error", (e: Error) => e.message);
  errors.push(msg);
  console.log(`  ${label.padEnd(36)} → ${msg}`);
}

// ---- self-check (mock pm-1 rate 1.05: energy เพิ่ม 10.5 kWh/ชม.) ----
const lines = (label: string) => results[label]!.series;
const pts = (label: string) => lines(label).flatMap((l) => l.points);
const pm1e = (label: string) => lines(label).find((l) => l.group.device_id === "pm-1" && l.group.metric_key === "energy_kwh")!.points;
const ok = {
  m1: pts("1m 3 ชม.ล่าสุด avg").length === 2 * 180, // pm-1/power_kw + th-1/temp (device ละ metric ที่มีจริงแค่ตัวเดียวจาก 2 ที่ขอ)
  m15_last_increasing: pm1e("15m 2 วัน last energy").every(([, v], i, a) => i === 0 || (v ?? 0) > (a[i - 1]![1] ?? 0)),
  h1_diff: pm1e("1h 2 วัน diff energy").length === 48 && pm1e("1h 2 วัน diff energy").every(([, v]) => Math.abs((v ?? 0) - 10.5) < 0.01),
  d1_diff: pm1e("24h body ระบบเก่า (diff)").length === 455 && pm1e("24h body ระบบเก่า (diff)").every(([, v]) => Math.abs((v ?? 0) - 252) < 0.01),
  w7_monday: pts("7d 6 เดือน sum + count").every(([t]) => new Date(t).getUTCDay() === 1),
  errors: errors.every((m) => m !== "ไม่ error"),
};
console.assert(Object.values(ok).every(Boolean), "ผลไม่ตรง");
console.log("\ncheck:", JSON.stringify(ok));
await ch.close();
