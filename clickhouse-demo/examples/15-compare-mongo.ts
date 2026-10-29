// bun run examples/15-compare-mongo.ts   (ต้องรัน 08 + 11 ก่อน และ docker compose up -d: ClickHouse + mongo :27018)
// RUNS=5 ONLY=14 RELOAD=1 bun run examples/15-compare-mongo.ts   (ONLY = กรองชื่อ case, RELOAD = โหลด Mongo ใหม่)
//
// เทียบ query ของ 13 (กราฟ) และ 14 (aggregate) ระหว่าง ClickHouse กับ MongoDB time series ช่วงย้อนหลังเท่ากัน
//   CH rollup  sensor_1m / sensor_hourly / sensor_daily  (สรุปไว้ล่วงหน้าตอน insert: ที่ออกแบบไว้)
//   CH raw     sensor_long ค่าดิบ (เก็บแค่ TTL.long = 3 วัน จึงเทียบได้เฉพาะ case สั้น)
//   Mongo raw  ค่าดิบ + $group ตอน query (วิธีของทีม: ไม่มี pre-agg)
// Mongo เก็บค่าดิบทุก 60 วิ (จุดวัดชุดเดียวกับที่ 11 ใช้สร้าง hourly/daily) ตลอดช่วงเท่า sensor_daily
// ค่าดิบรายวินาที 2 ปี ~4,700 ล้านแถว ใส่ไม่ไหว: sum/count ของ Mongo จึงเป็น 1/60 ของ CH (CH นับทุกจุดเป็น 60) ค่าอื่นเท่ากัน
import { fileURLToPath } from "node:url";
import { type Document, MongoClient } from "mongodb";
import { ch, rows } from "../src/ch";
import { type Agg, DAY, HOURLY_MAX_AGE, toSec, utc } from "../src/api-utils";
import { longSql, makeDevices } from "../src/mock";
import { type Body as Body13, INTERVALS, type Interval, run as run13, type Fetch, type Series } from "./13-api-body";
import { aggregate as chAggregate, type Body as Body14, type FetchRange, run as run14 } from "./14-aggregate";

const RUNS = Number(process.env.RUNS ?? 5);
const ONLY = process.env.ONLY;
const STEP = 60; // วินาทีต่อจุดใน Mongo
const MONGO_URL = process.env.MONGO_URL ?? "mongodb://default:demo@localhost:27018/?authSource=admin";

const mongo = new MongoClient(MONGO_URL, { serverSelectionTimeoutMS: 5000 });
await mongo.connect();
const db = mongo.db("demo");
const coll = db.collection("sensor_raw_ts");

// ---------------------------------------------------------------------------
// 1) โหลด Mongo time series: สร้างจากสูตร mock เดียวกับ 11 ผ่าน ClickHouse แล้ว stream เข้า (ข้ามถ้าโหลดครบแล้ว)
// ---------------------------------------------------------------------------
const devices = makeDevices(Number(process.env.DEVICES ?? 10));
const [{ a: anchor, f: first }] = await rows<{ a: number; f: number }>(
  "SELECT toUnixTimestamp(toStartOfHour((SELECT max(ts) FROM sensor_long))) AS a, toUnixTimestamp((SELECT min(ts) FROM sensor_daily)) AS f");

async function load() {
  const marker = db.collection<{ _id: string; from: number; to: number; rows: number }>("load_marker");
  const done = await marker.findOne({ _id: "raw" });
  if (done && done.from === first && done.to === anchor && !process.env.RELOAD) {
    return console.log(`Mongo: มีแล้ว ${done.rows.toLocaleString()} แถว (ข้าม)`);
  }
  await coll.drop().catch(() => {});
  await marker.deleteOne({ _id: "raw" });
  await db.createCollection("sensor_raw_ts", { timeseries: { timeField: "ts", metaField: "meta", granularity: "minutes" } });

  const chunk = 30 * DAY;
  const total = Math.ceil((anchor - first) / chunk);
  const t0 = performance.now();
  let n = 0;
  for (let from = first, i = 1; from < anchor; from += chunk, i++) {
    const points = Math.ceil((Math.min(from + chunk, anchor) - from) / STEP);
    const rs = await ch.query({
      query: `SELECT toUnixTimestamp(ts), sensor, metric, value FROM (${longSql(devices, STEP)})`,
      query_params: { from, n: points }, format: "JSONCompactEachRow",
    });
    let batch: Document[] = [];
    for await (const part of rs.stream()) {
      for (const r of part) {
        const [ts, sensor, metric, value] = r.json() as [number, string, string, number];
        batch.push({ ts: new Date(ts * 1000), meta: { sensor, metric }, value });
        if (batch.length >= 50_000) { await coll.insertMany(batch, { ordered: false }); n += batch.length; batch = []; }
      }
    }
    if (batch.length) { await coll.insertMany(batch, { ordered: false }); n += batch.length; }
    console.log(`  โหลด ${i}/${total} ก้อน  ${(n / 1e6).toFixed(1)}M แถว  ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  }
  console.log("  สร้าง index (meta.sensor, meta.metric, ts)...");
  await coll.createIndex({ "meta.sensor": 1, "meta.metric": 1, ts: 1 });
  await marker.insertOne({ _id: "raw", from: first, to: anchor, rows: n });
  console.log(`Mongo: โหลด ${n.toLocaleString()} แถว ใน ${((performance.now() - t0) / 1000).toFixed(0)}s`);
}
console.log("โหลด Mongo:");
await load();

// ---------------------------------------------------------------------------
// 2) aggregation pipeline ฝั่ง Mongo (แปลงจาก SQL ของ 13/14 ตรงๆ จากค่าดิบ)
// ---------------------------------------------------------------------------
function accs(agg: Agg): Document {
  switch (agg) {
    case "mean": case "avg": return { v: { $avg: "$value" } };
    case "sum": return { v: { $sum: "$value" } };
    case "count": return { v: { $sum: 1 } };
    case "min": return { v: { $min: "$value" } };
    case "max": return { v: { $max: "$value" } };
    default: return { v: { $top: { sortBy: { ts: -1 }, output: "$value" } } }; // last, diff
  }
}

// bucket ตัด UTC เหมือน SQL (7d = จันทร์-อาทิตย์)
const TRUNC: Record<Interval, Document> = {
  "1m": { unit: "minute", binSize: 1 }, "15m": { unit: "minute", binSize: 15 },
  "1h": { unit: "hour", binSize: 1 }, "6h": { unit: "hour", binSize: 6 }, "12h": { unit: "hour", binSize: 12 },
  "24h": { unit: "day", binSize: 1 }, "7d": { unit: "week", binSize: 1, startOfWeek: "monday" },
};

// 13: ดึงแถวของ series เดียว (รูปแบบ Row เดียวกับ ClickHouse จึงผ่าน run() ตัวเดิม)
const mongoFetch13: Fetch = async (s: Series, p, devs) => {
  const diff = s.aggregation === "diff";
  const id: Document = { t: { $dateTrunc: { date: "$ts", timezone: "UTC", ...TRUNC[s.interval] } } };
  if (s.group_by.includes("device_id")) id.sensor = "$meta.sensor";
  if (s.group_by.includes("metric_key")) id.metric = "$meta.metric";
  const sortKeys = [...(id.sensor ? ["_id.sensor"] : []), ...(id.metric ? ["_id.metric"] : []), "_id.t"];
  const pipeline: Document[] = [
    // diff: เอา bucket ก่อนหน้ามาอีก 1 interval ให้ bucket แรกมีตัวลบ (เหมือน SQL)
    { $match: { ts: { $gte: new Date((p.from - (diff ? INTERVALS[s.interval].sec : 0)) * 1000), $lt: new Date(p.to * 1000) },
                "meta.sensor": { $in: devs }, "meta.metric": { $in: s.metric_keys } } },
    { $group: { _id: id, ...accs(s.aggregation) } },
  ];
  if (diff) pipeline.push(
    { $setWindowFields: { partitionBy: { sensor: "$_id.sensor", metric: "$_id.metric" }, sortBy: { "_id.t": 1 }, output: { prev: { $shift: { output: "$v", by: -1 } } } } },
    { $set: { v: { $cond: [{ $eq: [{ $ifNull: ["$prev", null] }, null] }, null, { $subtract: ["$v", "$prev"] }] } } },
    { $match: { "_id.t": { $gte: new Date(p.from * 1000) } } },
  );
  pipeline.push({ $sort: Object.fromEntries(sortKeys.map((k) => [k, 1])) });
  const docs = await coll.aggregate(pipeline, { allowDiskUse: true }).toArray();
  return docs.map((d) => ({ t: utc(d._id.t.getTime() / 1000), sensor: d._id.sensor, metric: d._id.metric, value: d.v == null ? null : Math.round(d.v * 1000) / 1000 }));
};

// 14: aggregate ทั้งช่วง (ขอบช่วงเหมือน ClickHouse: เก่ากว่า TTL hourly → ปัดเป็นวัน UTC)
// ClickHouse ทำทุก metric ใน query เดียว (-If) / Mongo แยก pipeline ตาม aggregation ที่ต่างกัน + 1 อันหา "ก่อนช่วง" ของ diff
const mongoAggregate14: FetchRange = async (body: Body14, range) => {
  const daily = toSec(range.from) < Date.now() / 1000 - HOURLY_MAX_AGE;
  const step = daily ? DAY : 3600;
  const snap = (iso: string) => (daily ? Math.floor(toSec(iso) / DAY) * DAY : toSec(iso));
  const f = snap(range.from);
  const t = snap(range.to);
  const gid = { sensor: "$meta.sensor", metric: "$meta.metric" };
  const match = (metrics: string[], from: number, to: number): Document => ({
    $match: { ts: { $gte: new Date(from * 1000), $lt: new Date(to * 1000) }, "meta.sensor": { $in: body.scope.device_ids }, "meta.metric": { $in: metrics } },
  });

  const byAgg = new Map<Agg, string[]>();
  for (const m of body.metrics) byAgg.set(m.aggregation, [...(byAgg.get(m.aggregation) ?? []), m.metric_key]);

  const cur = new Map<string, Record<string, number>>();
  const put = (sensor: string, metric: string, v: number) => cur.set(sensor, { ...cur.get(sensor), [metric]: Math.round(v * 1000) / 1000 });
  await Promise.all([...byAgg].map(async ([agg, metrics]) => {
    const run = (from: number, to: number, a: Agg) => coll.aggregate([match(metrics, from, to), { $group: { _id: gid, ...accs(a) } }], { allowDiskUse: true }).toArray();
    const [now, before] = await Promise.all([run(f, t, agg), agg === "diff" ? run(f - step, f, "last") : Promise.resolve([])]);
    const prev = new Map(before.map((d) => [`${d._id.sensor}|${d._id.metric}`, d.v as number]));
    for (const d of now) {
      const k = `${d._id.sensor}|${d._id.metric}`;
      if (agg !== "diff") put(d._id.sensor, d._id.metric, d.v);
      else if (prev.has(k)) put(d._id.sensor, d._id.metric, d.v - prev.get(k)!);
    }
  }));
  return { table: "mongo:sensor_raw_ts", range, byDevice: cur };
};

// ---------------------------------------------------------------------------
// 3) case ทดสอบ: body จริงของ 13/14 + ช่วงสั้นที่มีค่าดิบทั้งสองฝั่ง (ให้เทียบ raw ต่อ raw ได้)
// ---------------------------------------------------------------------------
type Variant = "CH rollup" | "CH raw" | "Mongo raw";
const LONG: Variant[] = ["CH rollup", "Mongo raw"];
const ALL: Variant[] = ["CH rollup", "CH raw", "Mongo raw"];
type Case = { label: string; kind: 13 | 14; body: Body13 | Body14; variants: Variant[] };

const iso = (s: number) => new Date(s * 1000).toISOString();
const range = (hours: number) => ({ from: iso(anchor - hours * 3600), to: iso(anchor) });
const pm = ["pm-1", "pm-2", "pm-3", "pm-4", "pm-5"];
const m4 = ["power_kw", "voltage_l1", "current_l1", "energy_kwh"];
const s13 = (name: string, aggregation: Agg, interval: Interval, metric_keys: string[]): Series =>
  ({ name, aggregation, interval, metric_keys, group_by: ["device_id", "metric_key"] });
const b13 = (hours: number, series: Series[]): Body13 => ({ time_range: range(hours), filters: { device_ids: pm }, series });
const json = (f: string) => Bun.file(new URL(f, import.meta.url)).json();
const body14 = (await json("./14-body.json")) as Body14;

const CASES: Case[] = [
  { label: "13 body จริง (13-body.json, 455 วัน)", kind: 13, body: (await json("./13-body.json")) as Body13, variants: LONG },
  { label: "13 | 24h mean 1 ปี 5 dev × 4 metric", kind: 13, body: b13(365 * 24, [s13("a", "mean", "24h", m4)]), variants: LONG },
  { label: "13 | 6h max 30 วัน 5 dev × 4 metric", kind: 13, body: b13(30 * 24, [s13("a", "max", "6h", m4)]), variants: LONG },
  { label: "13 | 1h diff energy 2 วัน", kind: 13, body: b13(48, [s13("a", "diff", "1h", ["energy_kwh"])]), variants: ALL },
  { label: "13 | 15m avg 2 วัน 5 dev × 4 metric", kind: 13, body: b13(48, [s13("a", "avg", "15m", m4)]), variants: ALL },
  { label: "13 | 1m avg 3 ชม. 5 dev × 4 metric", kind: 13, body: b13(3, [s13("a", "avg", "1m", m4)]), variants: ALL },
  { label: "14 body จริง (14-body.json, 455 วัน + compare)", kind: 14, body: body14, variants: LONG },
  { label: "14 | metric ผสม 2 วัน (ไม่มี compare)", kind: 14, body: { ...body14, time_range: range(48), compare: undefined }, variants: ALL },
];

const impl13: Record<Variant, (b: Body13) => Promise<any>> = {
  "CH rollup": (b) => run13(b),
  "CH raw": (b) => run13(b, undefined, true),
  "Mongo raw": (b) => run13(b, mongoFetch13),
};
const impl14: Record<Variant, (b: Body14) => Promise<any>> = {
  "CH rollup": (b) => run14(b),
  "CH raw": (b) => run14(b, (bb, r) => chAggregate(bb, r, true)),
  "Mongo raw": (b) => run14(b, mongoAggregate14),
};

// response → Map(key → ค่า) ไว้เทียบว่า 2 ฝั่งได้ค่าเดียวกัน
function flat(kind: 13 | 14, r: any): Map<string, number | null> {
  const m = new Map<string, number | null>();
  if (kind === 13) for (const l of r.series) for (const [t, v] of l.points) m.set(`${l.name}|${JSON.stringify(l.group)}|${t}`, v);
  else for (const x of r.results) {
    const d = x.group.device_id;
    for (const [k, v] of Object.entries(x.result.current)) m.set(`${d}|current|${k}`, v as number);
    for (const [k, v] of Object.entries(x.result.compare ?? {})) m.set(`${d}|compare|${k}`, v as number);
  }
  return m;
}
// ค่าต่างกันเกิน 1% ถือว่าไม่ตรง (Mongo เก็บทุก 60 วิ, ClickHouse นับทุกจุดเป็น 60: avg/min/max ต่างนิดหน่อยได้)
const same = (a: number | null | undefined, b: number | null | undefined) =>
  a == null || b == null ? a == b : Math.abs(a - b) <= 0.01 * Math.max(Math.abs(a), Math.abs(b)) + 0.01;
const mismatches = (ref: Map<string, number | null>, m: Map<string, number | null>) => {
  let bad = 0;
  for (const k of new Set([...ref.keys(), ...m.keys()])) if (!same(ref.get(k), m.get(k))) bad++;
  return bad;
};

// ---------------------------------------------------------------------------
// 4) วัด: warmup 1 รอบ แล้ววัด RUNS รอบ (end-to-end ฝั่ง client เท่ากันทั้งสองฝั่ง: query + จัดรูป response)
// ---------------------------------------------------------------------------
const table: Record<string, unknown>[] = [];
for (const c of CASES) {
  if (ONLY && !c.label.includes(ONLY)) continue;
  console.log(`\n== ${c.label}`);
  let ref: Map<string, number | null> | undefined;
  let refMs = 0;
  for (const v of c.variants) {
    const fn = c.kind === 13 ? impl13[v] : impl14[v];
    try {
      const flatRes = flat(c.kind, await fn(c.body as never)); // warmup
      const times: number[] = [];
      for (let i = 0; i < RUNS; i++) {
        const t0 = performance.now();
        await fn(c.body as never);
        times.push(performance.now() - t0);
      }
      times.sort((a, b) => a - b);
      const median = times[Math.floor(times.length / 2)]!;
      if (!ref) { ref = flatRes; refMs = median; }
      const bad = mismatches(ref, flatRes);
      table.push({ case: c.label, variant: v, values: flatRes.size, median_ms: Math.round(median), max_ms: Math.round(times.at(-1)!),
        vs_first: `${(median / refMs).toFixed(1)}x`, same_as_first: bad === 0 ? "ตรง" : `ต่าง ${bad}` });
      console.log(`  ${v.padEnd(10)} median ${Math.round(median)} ms  (${flatRes.size.toLocaleString()} ค่า, ${bad === 0 ? "ตรง" : `ต่าง ${bad}`})`);
    } catch (e) {
      table.push({ case: c.label, variant: v, error: (e as Error).message.slice(0, 120) });
      console.log(`  ${v.padEnd(10)} error: ${(e as Error).message.slice(0, 120)}`);
    }
  }
}
console.log("\nสรุป (vs_first = เทียบกับแถวแรกของ case นั้น = CH rollup):");
console.table(table);
const out = process.env.OUT ?? fileURLToPath(new URL("./15-result.json", import.meta.url));
await Bun.write(out, JSON.stringify({ runs: RUNS, anchor: iso(anchor), from: iso(first), table }, null, 2));
console.log(`ผลเต็ม → ${out}`);
await mongo.close();
await ch.close();
