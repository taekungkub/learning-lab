// bun run examples/08-multi-metric.ts
// sensor แต่ละตัวส่ง key ไม่เหมือนกัน: เก็บ raw เป็น JSON แล้วใช้ MV แตกเป็น long format (1 แถว = 1 ค่า) ไปทำ hourly rollup

// การทำงาน
// sensor_raw (JSON) ──MV──► sensor_long (ts, sensor, metric, value) ──MV──► sensor_hourly ──MV──► sensor_daily
//                                                                           ▲ sensor_hourly_v       ▲ sensor_daily_v

import { ch, rows } from "../src/ch";
import { TTL, ttlSql } from "../src/config";

for (const t of [
  "sensor_daily_v", "sensor_daily_mv", "sensor_daily",
  "sensor_hourly_v", "sensor_hourly_mv", "sensor_hourly",
  "sensor_long_mv", "sensor_long", "sensor_raw",
])
  await ch.command({ query: `DROP TABLE IF EXISTS ${t}` });

// TTL ตั้งค่าที่ src/config.ts
// PARTITION ขนาดใกล้ช่วง TTL + ttl_only_drop_parts = ลบทั้ง partition ไม่ตัดทีละแถว:
// raw, long  partition รายวัน
// hourly     partition รายเดือน
// daily      ไม่แบ่ง partition (เล็ก ไม่มี TTL)

// 1) raw: เก็บ payload ทั้งก้อน ClickHouse แยกแต่ละ key เป็น subcolumn ให้เอง
await ch.command({
  query: `CREATE TABLE sensor_raw (ts DateTime, sensor LowCardinality(String), data JSON)
          ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (sensor, ts)
          TTL ts + ${ttlSql(TTL.raw)}
          SETTINGS ttl_only_drop_parts = 1`,
});

// 2) long format: 1 แถวต่อ 1 metric รับ sensor/key ใหม่ได้โดยไม่ต้อง ALTER
await ch.command({
  query: `CREATE TABLE sensor_long (
            ts DateTime, sensor LowCardinality(String), metric LowCardinality(String), value Float64
          ) ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (sensor, metric, ts)
          TTL ts + ${ttlSql(TTL.long)}
          SETTINGS ttl_only_drop_parts = 1`,
});

// แตก JSON เป็นแถว: key ที่ไม่ใช่ตัวเลข (เช่น status) ได้ NULL แล้วถูกตัดทิ้ง
await ch.command({
  query: `CREATE MATERIALIZED VIEW sensor_long_mv TO sensor_long AS
          SELECT ts, sensor, kv.1 AS metric, assumeNotNull(kv.2) AS value
          FROM sensor_raw
          ARRAY JOIN JSONExtractKeysAndValues(toJSONString(data), 'Nullable(Float64)') AS kv
          WHERE kv.2 IS NOT NULL`,
});

// 3) hourly rollup จาก long (cascade: MV นี้ทำงานเมื่อ sensor_long_mv เขียนลง sensor_long)
await ch.command({
  query: `CREATE TABLE sensor_hourly (
            hour DateTime, sensor LowCardinality(String), metric LowCardinality(String),
            samples AggregateFunction(count),
            avg_v   AggregateFunction(avg, Float64),
            min_v   SimpleAggregateFunction(min, Float64),
            max_v   SimpleAggregateFunction(max, Float64)
          ) ENGINE = AggregatingMergeTree PARTITION BY toYYYYMM(hour) ORDER BY (sensor, metric, hour)
          TTL hour + ${ttlSql(TTL.hourly)}
          SETTINGS ttl_only_drop_parts = 1`,
});
await ch.command({
  query: `CREATE MATERIALIZED VIEW sensor_hourly_mv TO sensor_hourly AS
          SELECT toStartOfHour(ts) AS hour, sensor, metric,
                 countState() AS samples, avgState(value) AS avg_v, min(value) AS min_v, max(value) AS max_v
          FROM sensor_long GROUP BY hour, sensor, metric`,
});
// view ไว้เปิดใน TablePlus (state เป็น binary)
await ch.command({
  query: `CREATE VIEW sensor_hourly_v AS
          SELECT hour, sensor, metric, countMerge(samples) AS samples,
                 round(avgMerge(avg_v), 2) AS avg_v, min(min_v) AS min_v, max(max_v) AS max_v
          FROM sensor_hourly GROUP BY hour, sensor, metric`,
});

// 4) daily จาก hourly (cascade ชั้นที่ 2): input เป็น state แล้ว ต้องใช้ -MergeState ไม่ใช่ -State
// ตัดวันตามเวลาไทยตั้งแต่ตอนเขียน (เปลี่ยน timezone ทีหลังต้อง rebuild) ใช้กับรายเดือน/ปี
// จำเป็นจริงเมื่อจะตั้ง TTL ให้ hourly: daily ต้องมีก่อน hourly เริ่มถูกลบ
await ch.command({
  query: `CREATE TABLE sensor_daily (
            day Date, sensor LowCardinality(String), metric LowCardinality(String),
            samples AggregateFunction(count),
            avg_v   AggregateFunction(avg, Float64),
            min_v   SimpleAggregateFunction(min, Float64),
            max_v   SimpleAggregateFunction(max, Float64)
          ) ENGINE = AggregatingMergeTree ORDER BY (sensor, metric, day)`,
});
await ch.command({
  query: `CREATE MATERIALIZED VIEW sensor_daily_mv TO sensor_daily AS
          SELECT toDate(hour, 'Asia/Bangkok') AS day, sensor, metric,
                 countMergeState(samples) AS samples, avgMergeState(avg_v) AS avg_v,
                 min(min_v) AS min_v, max(max_v) AS max_v
          FROM sensor_hourly GROUP BY day, sensor, metric`,
});
await ch.command({
  query: `CREATE VIEW sensor_daily_v AS
          SELECT day, sensor, metric, countMerge(samples) AS samples,
                 round(avgMerge(avg_v), 2) AS avg_v, min(min_v) AS min_v, max(max_v) AS max_v
          FROM sensor_daily GROUP BY day, sensor, metric`,
});

// ข้อมูล 3 ชั่วโมง ทุก 10 วิ: th-1 = temp/humidity/status, pm-1 = voltage/current
// เมื่อวาน 22:00-01:00 เวลาไทย (15:00-18:00 UTC): คร่อมเที่ยงคืนไทย แต่ยังวันเดียวกันใน UTC
// อิงวันที่รัน ไม่ fix วัน: ถ้า fix ไว้ รันเกิน 7 วันข้อมูลจะเก่ากว่า TTL แล้วถูกลบ
const yesterday = new Date();
yesterday.setUTCDate(yesterday.getUTCDate() - 1);
yesterday.setUTCHours(15, 0, 0, 0);
const start = yesterday.getTime() / 1000;
const r = (base: number, spread: number) => Math.round((base + Math.random() * spread) * 10) / 10;
const payloads = Array.from({ length: (3 * 3600) / 10 }, (_, i) => {
  const ts = start + i * 10;
  return [
    { ts, sensor: "th-1", data: { temp: r(25, 5), humidity: r(50, 20), status: "ok" } },
    { ts, sensor: "pm-1", data: { voltage: r(218, 4), current: r(2, 3) } },
  ];
}).flat();

// insert เป็น batch ละ 1 ชั่วโมง (MV ทำงานทุก batch)
for (let i = 0; i < payloads.length; i += 720)
  await ch.insert({ table: "sensor_raw", format: "JSONEachRow", values: payloads.slice(i, i + 720) });

console.log("key ที่เจอใน JSON:");
console.table(await rows("SELECT DISTINCT arrayJoin(JSONAllPaths(data)) AS path FROM sensor_raw ORDER BY path"));

console.log("raw อ่าน key ตรงๆ (sensor ที่ไม่มี key ได้ NULL):");
console.table(await rows("SELECT ts, sensor, data.temp, data.voltage, data.status FROM sensor_raw ORDER BY ts, sensor LIMIT 4"));

// กับดัก 2 ข้อของ JSON subcolumn (type เป็น Dynamic):
// - ค่า 220 (ไม่มีทศนิยม) ถูกเก็บเป็น Int64, 220.1 เป็น Float64 ปนกันในคอลัมน์เดียว
console.table(await rows("SELECT dynamicType(data.voltage) AS type, count() AS n FROM sensor_raw WHERE sensor = 'pm-1' GROUP BY type"));
// - ::Float64            key ที่ไม่มีกลายเป็น 0 แล้วถูกนำมาเฉลี่ย
// - .:Float64            เลือกเฉพาะค่าที่เก็บเป็น Float64 ค่า Int64 หายเงียบ
// - ::Nullable(Float64)  ถูก: แปลงทุก type และ key ที่ไม่มีเป็น NULL
const trap = await rows<{ sensor: string; ok: number | null; zero: number; typed: number | null; truth: number | null }>(`
  SELECT sensor,
         avg(data.voltage::Nullable(Float64)) AS ok,
         avg(data.voltage::Float64)           AS zero,
         avg(data.voltage.:Float64)           AS typed,
         (SELECT avg(value) FROM sensor_long WHERE metric = 'voltage' AND sensor = s.sensor) AS truth
  FROM sensor_raw AS s GROUP BY sensor ORDER BY sensor`);
console.log("avg voltage แต่ละวิธี (truth = จาก long format):");
console.table(trap);
const th = trap.find((x) => x.sensor === "th-1");
const pm = trap.find((x) => x.sensor === "pm-1");
console.assert(th?.ok === null && th?.zero === 0, "th-1 ไม่มี voltage: ok ต้อง NULL, ::Float64 ต้องได้ 0");
console.assert(pm?.ok === pm?.truth && pm?.typed !== pm?.truth, "pm-1: ::Nullable(Float64) ต้องตรง, .:Float64 ต้องเพี้ยน");

console.log("long format (status ถูกตัดเพราะไม่ใช่ตัวเลข):");
console.table(await rows("SELECT * FROM sensor_long ORDER BY ts, sensor, metric LIMIT 4"));

console.log("hourly ต่อ sensor ต่อ metric:");
const hourly = await rows("SELECT * FROM sensor_hourly_v ORDER BY sensor, metric, hour");
console.table(hourly);

// pivot กลับเป็นคอลัมน์ ถ้า dashboard อยากได้ 1 แถวต่อชั่วโมง
console.log("pivot th-1:");
console.table(
  await rows(`
    SELECT hour, anyIf(avg_v, metric = 'temp') AS temp, anyIf(avg_v, metric = 'humidity') AS humidity
    FROM sensor_hourly_v WHERE sensor = 'th-1' GROUP BY hour ORDER BY hour`),
);

// self-check: hourly ผ่าน 2 MV ต้องตรงกับคำนวณจาก JSON raw ตรงๆ
const fromRaw = await rows(`
  SELECT toStartOfHour(ts) AS hour, sensor, kv.1 AS metric, count() AS samples,
         round(avg(kv.2), 2) AS avg_v, min(kv.2) AS min_v, max(kv.2) AS max_v
  FROM sensor_raw
  ARRAY JOIN JSONExtractKeysAndValues(toJSONString(data), 'Nullable(Float64)') AS kv
  WHERE kv.2 IS NOT NULL
  GROUP BY hour, sensor, metric ORDER BY sensor, metric, hour`);
const same = JSON.stringify(hourly) === JSON.stringify(fromRaw);
console.assert(same, "hourly ไม่ตรงกับ raw");
console.log("hourly ตรงกับ raw:", same);

// daily: แยกเป็น 2 วันตามเวลาไทย (เมื่อวาน 22:00-23:59, วันนี้ 00:00-00:59)
console.log("daily (วันตามเวลาไทย):");
const daily = await rows("SELECT * FROM sensor_daily_v ORDER BY sensor, metric, day");
console.table(daily);
const dailyFromRaw = await rows(`
  SELECT toDate(ts, 'Asia/Bangkok') AS day, sensor, kv.1 AS metric, count() AS samples,
         round(avg(kv.2), 2) AS avg_v, min(kv.2) AS min_v, max(kv.2) AS max_v
  FROM sensor_raw
  ARRAY JOIN JSONExtractKeysAndValues(toJSONString(data), 'Nullable(Float64)') AS kv
  WHERE kv.2 IS NOT NULL
  GROUP BY day, sensor, metric ORDER BY sensor, metric, day`);
const sameDaily = JSON.stringify(daily) === JSON.stringify(dailyFromRaw);
console.assert(sameDaily, "daily ไม่ตรงกับ raw");
console.log("daily ตรงกับ raw:", sameDaily);

// รายเดือน/ปี อ่านจาก daily (365 แถวต่อปีแทน 8,760)
console.log("รายเดือน / รายปี จาก daily:");
console.table(
  await rows(`
    SELECT toStartOfMonth(day) AS month, toYear(day) AS year, sensor, metric,
           countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
    FROM sensor_daily GROUP BY month, year, sensor, metric ORDER BY sensor, metric`),
);

console.log("partition + TTL ของแต่ละตาราง:");
console.table(
  await rows(`
    SELECT table, groupUniqArray(partition) AS partitions, sum(rows) AS rows,
           min(delete_ttl_info_max) AS first_drop_at
    FROM system.parts
    WHERE database = 'demo' AND active AND table IN ('sensor_raw', 'sensor_long', 'sensor_hourly', 'sensor_daily')
    GROUP BY table ORDER BY table`),
);
await ch.close();
