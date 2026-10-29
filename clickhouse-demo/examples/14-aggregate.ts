// bun run examples/14-aggregate.ts              (ต้องรัน 08 + 11 ก่อน: อ่านอย่างเดียว รัน body จาก 14-body.json)
// bun run examples/14-aggregate.ts other.json   (ส่ง body เอง)   OUT=path เปลี่ยนที่เก็บ response เต็ม
//
// aggregate ทั้งช่วง = 1 ค่าต่อ (device, metric) + compare กับอีกช่วงได้ delta
// อ่าน sensor_hourly (TTL 2 ปี) ช่วงเก่ากว่านั้นอ่าน sensor_daily
//   ponytail: daily ปัดขอบช่วงลงเป็นต้นวัน UTC (hourly ไม่ปัด)
//   ponytail: ไม่ใช้ compare.interval / group_by รองรับแค่ ["device_id"]
import { fileURLToPath } from "node:url";
import { ch, rows } from "../src/ch";
import { type Agg, HOURLY_MAX_AGE, toSec, utc } from "../src/api-utils";

export type TimeRange = { from: string; to: string };
export type Body = {
  scope: { device_ids: string[] };
  time_range: TimeRange;
  group_by: "device_id"[];
  metrics: { metric_key: string; aggregation: Agg }[];
  compare?: { mode: "previous_period" | "previous_year" | "custom"; interval?: string; custom_time_range?: TimeRange };
};
type AggregateDelta = { absolute: number; percent: number };
type AggregateResult = {
  group: Record<string, string>;
  result: { current: Record<string, number>; compare?: Record<string, number>; delta?: Record<string, AggregateDelta> };
};

// ดึงค่าสรุปของ 1 ช่วง: default ClickHouse / 15-compare-mongo ใส่ของ Mongo แทน
export type Fetched = { table: string; range: TimeRange; byDevice: Map<string, Record<string, number>> };
export type FetchRange = (body: Body, range: TimeRange) => Promise<Fetched>;

// c = เงื่อนไขแถวในช่วง / p = bucket ก่อนช่วง (ใช้กับ diff)
// last = argMax ตามเวลา / diff = last ในช่วง − last ก่อนช่วง (ใช้กับ counter เช่น kWh)
const AGG: Record<Agg, (c: string, p: string) => string> = {
  mean: (c) => `avgMergeIf(avg_v, ${c})`,
  avg: (c) => `avgMergeIf(avg_v, ${c})`,
  sum: (c) => `avgMergeIf(avg_v, ${c}) * countMergeIf(samples, ${c})`,
  count: (c) => `countMergeIf(samples, ${c})`,
  min: (c) => `minIf(min_v, ${c})`,
  max: (c) => `maxIf(max_v, ${c})`,
  last: (c) => `argMaxMergeIf(last_v, ${c})`,
  diff: (c, p) => `argMaxMergeIf(last_v, ${c}) - argMaxMergeIf(last_v, ${p})`,
};

// ค่าดิบ (sensor_long) แทน state: ไว้เทียบกับ Mongo ที่ไม่มี rollup (15-compare-mongo)
const AGG_RAW: Record<Agg, (c: string, p: string) => string> = {
  mean: (c) => `avgIf(value, ${c})`,
  avg: (c) => `avgIf(value, ${c})`,
  sum: (c) => `sumIf(value, ${c})`,
  count: (c) => `countIf(${c})`,
  min: (c) => `minIf(value, ${c})`,
  max: (c) => `maxIf(value, ${c})`,
  last: (c) => `argMaxIf(value, ts, ${c})`,
  diff: (c, p) => `argMaxIf(value, ts, ${c}) - argMaxIf(value, ts, ${p})`,
};

const HOURLY = { table: "sensor_hourly", time: "ts", from: "toDateTime({from:String}, 'UTC')", to: "toDateTime({to:String}, 'UTC')", step: "INTERVAL 1 HOUR" };
const RAW = { ...HOURLY, table: "sensor_long" };
const DAILY = { table: "sensor_daily", time: "ts", from: "toStartOfDay(toDateTime({from:String}, 'UTC'), 'UTC')", to: "toStartOfDay(toDateTime({to:String}, 'UTC'), 'UTC')", step: "INTERVAL 1 DAY" };

const iso = (s: number) => new Date(s * 1000).toISOString().replace(".000", "");

function checkRange(r: TimeRange) {
  if (toSec(r.to) <= toSec(r.from)) throw new Error("time_range.to ต้องมากกว่า from");
}

function compareRange(body: Body): TimeRange | undefined {
  const c = body.compare;
  if (!c) return;
  const f = toSec(body.time_range.from);
  const t = toSec(body.time_range.to);
  if (c.mode === "previous_period") return { from: iso(f - (t - f)), to: iso(f) };
  if (c.mode === "previous_year") {
    const back = (s: number) => { const d = new Date(s * 1000); d.setUTCFullYear(d.getUTCFullYear() - 1); return iso(d.getTime() / 1000); };
    return { from: back(f), to: back(t) };
  }
  if (c.mode === "custom" && c.custom_time_range) return c.custom_time_range;
  throw new Error('compare.mode ต้องเป็น previous_period | previous_year | custom (custom ต้องมี custom_time_range)');
}

// 1 query ต่อช่วง: 1 คอลัมน์ต่อ metric (-If) → Map device → { metric: ค่า } / ไม่มีข้อมูล (หรือ diff ไม่มีก่อนช่วง) = ไม่ใส่ key
export async function aggregate(body: Body, range: TimeRange, raw = false): Promise<Fetched> {
  checkRange(range);
  const t = raw ? RAW : toSec(range.from) < Date.now() / 1000 - HOURLY_MAX_AGE ? DAILY : HOURLY;
  const agg = raw ? AGG_RAW : AGG;
  const params: Record<string, unknown> = {
    devices: body.scope.device_ids, metrics: body.metrics.map((m) => m.metric_key), from: utc(toSec(range.from)), to: utc(toSec(range.to)),
  };
  const cols = body.metrics.map((m, i) => {
    params[`m${i}`] = m.metric_key;
    const c = `metric = {m${i}:String} AND ${t.time} >= ${t.from} AND ${t.time} < ${t.to}`;
    const p = `metric = {m${i}:String} AND ${t.time} >= ${t.from} - ${t.step} AND ${t.time} < ${t.from}`;
    const n = (w: string) => (raw ? `countIf(${w})` : `countMergeIf(samples, ${w})`);
    const need = m.aggregation === "diff" ? `${n(c)} = 0 OR ${n(p)} = 0` : `${n(c)} = 0`;
    return `if(${need}, NULL, toFloat64(round(${agg[m.aggregation](c, p)}, 3))) AS c${i}`;
  });
  const sql = `SELECT sensor, ${cols.join(", ")} FROM ${t.table}
    WHERE has({devices:Array(String)}, sensor) AND has({metrics:Array(String)}, metric)
      AND ${t.time} >= ${t.from} - ${t.step} AND ${t.time} < ${t.to}
    GROUP BY sensor`;
  const data = await rows<Record<string, unknown>>(sql, params);
  const byDevice = new Map(data.map((r) => [
    r.sensor as string,
    Object.fromEntries(body.metrics.flatMap((m, i) => (r[`c${i}`] == null ? [] : [[m.metric_key, r[`c${i}`] as number]]))),
  ]));
  return { table: t.table, range, byDevice };
}

export async function run(body: Body, fetchRange: FetchRange = aggregate) {
  const ids = body.scope?.device_ids;
  if (!Array.isArray(ids) || !Array.isArray(body.metrics) || !body.time_range) throw new Error("body ต้องมี scope.device_ids, time_range, metrics");
  if (ids.length === 0 || ids.length > 100) throw new Error("scope.device_ids ต้องมี 1-100 ตัว");
  if (body.metrics.length === 0 || body.metrics.length > 20) throw new Error("metrics ต้องมี 1-20 ตัว");
  for (const m of body.metrics) if (!Object.hasOwn(AGG, m.aggregation)) throw new Error(`aggregation ต้องเป็น ${Object.keys(AGG).join(" | ")}`);
  if (JSON.stringify(body.group_by) !== '["device_id"]') throw new Error('group_by ต้องเป็น ["device_id"]');
  checkRange(body.time_range);
  const cmpRange = compareRange(body);

  const t0 = performance.now();
  const [cur, cmp] = await Promise.all([fetchRange(body, body.time_range), cmpRange ? fetchRange(body, cmpRange) : undefined]);

  const results: AggregateResult[] = ids.filter((d) => cur.byDevice.has(d)).map((d) => {
    const current = cur.byDevice.get(d)!;
    const compare = cmp?.byDevice.get(d) ?? (cmp ? {} : undefined);
    const delta: Record<string, AggregateDelta> = {};
    // compare = 0 หา percent ไม่ได้ → ข้าม
    for (const [k, v] of Object.entries(current)) {
      const c = compare?.[k];
      if (c !== undefined && c !== 0) delta[k] = { absolute: Math.round((v - c) * 1000) / 1000, percent: Math.round(((v - c) / Math.abs(c)) * 10000) / 100 };
    }
    return { group: { device_id: d }, result: { current, ...(compare && { compare, delta }) } };
  });
  const meta = { current: { table: cur.table, ...cur.range }, ...(cmp && { compare: { table: cmp.table, ...cmp.range } }) };
  return { took_ms: Math.round(performance.now() - t0), meta, results };
}

if (import.meta.main) {
  const file = process.argv[2];
  const body: Body = await Bun.file(file ?? new URL("./14-body.json", import.meta.url)).json();
  const r = await run(body);
  console.log(JSON.stringify({ ...r, results: [...r.results.slice(0, 2), `... ${r.results.length} device`] }, null, 2));
  // self-check (body เริ่มต้น): pm-1 เพิ่ม 10.5 kWh/ชม. × 455 วัน × 24 = 114,660
  if (!file) console.assert(r.results.find((x) => x.group.device_id === "pm-1")?.result.current.energy_kwh === 114660, "energy_kwh ของ pm-1 ไม่ตรง 114660");
  const out = process.env.OUT ?? fileURLToPath(new URL("./14-response.json", import.meta.url));
  await Bun.write(out, JSON.stringify(r, null, 2));
  console.log(`response เต็ม → ${out}`);
  await ch.close();
}
