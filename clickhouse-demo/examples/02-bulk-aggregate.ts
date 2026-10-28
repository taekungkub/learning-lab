// bun run examples/02-bulk-aggregate.ts
// สร้าง 10 ล้านแถวฝั่ง server ด้วย numbers() แล้วลอง aggregate ดูความเร็ว (columnar)
import { ch, rows } from "../src/ch";

await ch.command({ query: "DROP TABLE IF EXISTS hits" });
await ch.command({
  query: `
    CREATE TABLE hits (
      ts      DateTime,
      user_id UInt32,
      country LowCardinality(String),
      url     String,
      latency UInt16
    )
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(ts)   -- partition = หน่วยจัดการข้อมูล (drop/move) ไม่ใช่ตัวเร่ง query หลัก
    ORDER BY (country, ts)
  `,
});

let t = performance.now();
// INSERT ... SELECT: ข้อมูลไม่ผ่าน client เลย
await ch.command({
  query: `
    INSERT INTO hits
    SELECT
      toDateTime('2026-08-01 00:00:00') + (number % (90 * 86400)) AS ts,
      rand() % 100000                                            AS user_id,
      ['TH','JP','US','DE','SG'][rand() % 5 + 1]                 AS country,
      concat('/page/', toString(rand() % 50))                    AS url,
      rand() % 2000                                              AS latency
    FROM numbers(10000000)
  `,
});
console.log(`insert 10M rows: ${(performance.now() - t).toFixed(0)} ms`);

t = performance.now();
console.table(
  await rows(`
    SELECT country,
           count()                     AS hits,
           uniq(user_id)               AS users,        -- approx distinct (เร็ว)
           round(avg(latency))         AS avg_ms,
           quantile(0.95)(latency)     AS p95_ms
    FROM hits
    GROUP BY country
    ORDER BY hits DESC
  `),
);
console.log(`aggregate: ${(performance.now() - t).toFixed(0)} ms`);

// ขนาดบน disk: columnar + compression
console.table(
  await rows(`
    SELECT name,
           formatReadableSize(data_compressed_bytes)   AS compressed,
           formatReadableSize(data_uncompressed_bytes) AS raw
    FROM system.columns WHERE database = 'demo' AND table = 'hits'
  `),
);
await ch.close();
