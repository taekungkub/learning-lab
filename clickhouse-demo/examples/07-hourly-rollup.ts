// bun run examples/07-hourly-rollup.ts
// raw เข้าทุก 1 วิ: MV hourly เขียน state บางส่วนของชั่วโมงปัจจุบันทุก insert แล้วค่อยรวมตอน merge/query
import { ch, rows } from "../src/ch";

for (const t of ["metrics_hourly_v", "metrics_hourly_mv", "metrics_hourly", "metrics_raw"])
  await ch.command({ query: `DROP TABLE IF EXISTS ${t}` });

await ch.command({
  query: `CREATE TABLE metrics_raw (ts DateTime, sensor LowCardinality(String), value Float64)
          ENGINE = MergeTree PARTITION BY toYYYYMMDD(ts) ORDER BY (sensor, ts)`,
});

await ch.command({
  query: `CREATE TABLE metrics_hourly (
            hour    DateTime,
            sensor  LowCardinality(String),
            samples AggregateFunction(count),
            avg_v   AggregateFunction(avg, Float64),
            max_v   SimpleAggregateFunction(max, Float64)  -- max/min ไม่ต้องเก็บ state ซับซ้อน
          ) ENGINE = AggregatingMergeTree ORDER BY (sensor, hour)`,
});

// toStartOfHour(ts) คือ "ตัดเป็นรายชั่วโมง" ไม่ต้องรอครบชั่วโมง
await ch.command({
  query: `CREATE MATERIALIZED VIEW metrics_hourly_mv TO metrics_hourly AS
          SELECT toStartOfHour(ts) AS hour, sensor,
                 countState() AS samples, avgState(value) AS avg_v, max(value) AS max_v
          FROM metrics_raw GROUP BY hour, sensor`,
});

// view ธรรมดา (ไม่เก็บข้อมูล) ครอบ -Merge ไว้: เปิดใน GUI อย่าง TablePlus แล้วอ่านออก
// เปิด metrics_hourly ตรงๆ จะเห็น state เป็น binary
await ch.command({
  query: `CREATE VIEW metrics_hourly_v AS
          SELECT hour, sensor, countMerge(samples) AS samples,
                 round(avgMerge(avg_v), 2) AS avg_v, max(max_v) AS max_v
          FROM metrics_hourly GROUP BY hour, sensor`,
});

const SECONDS = 10;
for (let i = 1; i <= SECONDS; i++) {
  // 1 batch ต่อวินาที: 100 แถวต่อ sensor
  const now = Math.floor(Date.now() / 1000);
  const values = ["s1", "s2"].flatMap((sensor) =>
    Array.from({ length: 100 }, () => ({ ts: now, sensor, value: Math.round(Math.random() * 1000) / 10 })),
  );
  const t = performance.now();
  await ch.insert({ table: "metrics_raw", format: "JSONEachRow", values });
  const ms = (performance.now() - t).toFixed(0);

  // แถวใน metrics_hourly เพิ่มทุก insert (state ย่อย) แต่ผลหลัง -Merge เป็น 1 แถวต่อ sensor ต่อชั่วโมง
  const [stored] = await rows<{ n: string }>("SELECT count() AS n FROM metrics_hourly");
  const merged = await rows<{ sensor: string; samples: string }>(
    "SELECT sensor, countMerge(samples) AS samples FROM metrics_hourly GROUP BY sensor ORDER BY sensor",
  );
  console.log(
    `#${i} insert ${ms}ms | แถวที่เก็บใน metrics_hourly=${stored?.n} | หลัง merge: ${merged.map((r) => `${r.sensor}=${r.samples}`).join(" ")}`,
  );
  await Bun.sleep(1000);
}

console.log("\nอ่าน hourly (ต้อง -Merge + GROUP BY เสมอ):");
const hourly = await rows(`
  SELECT hour, sensor, countMerge(samples) AS samples, round(avgMerge(avg_v), 2) AS avg, max(max_v) AS max
  FROM metrics_hourly GROUP BY hour, sensor ORDER BY hour, sensor`);
console.table(hourly);

// self-check: ตรงกับคำนวณจาก raw
const fromRaw = await rows(`
  SELECT toStartOfHour(ts) AS hour, sensor, count() AS samples, round(avg(value), 2) AS avg, max(value) AS max
  FROM metrics_raw GROUP BY hour, sensor ORDER BY hour, sensor`);
console.log("hourly ตรงกับ raw:", JSON.stringify(hourly) === JSON.stringify(fromRaw));
console.table(await rows("SELECT * FROM metrics_hourly_v ORDER BY hour, sensor"));

await ch.command({ query: "OPTIMIZE TABLE metrics_hourly FINAL" });
const [after] = await rows<{ n: string }>("SELECT count() AS n FROM metrics_hourly");
console.log(`หลัง OPTIMIZE FINAL แถวที่เก็บเหลือ ${after?.n} (background merge ทำแบบนี้เองตามเวลา)`);
await ch.close();
