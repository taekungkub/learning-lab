// bun run examples/01-hello.ts
// พื้นฐาน: สร้างตาราง MergeTree, insert, select
import { ch, rows } from "../src/ch";

await ch.command({ query: "DROP TABLE IF EXISTS events" });
// ORDER BY = sorting key + primary index (sparse) ไม่ใช่ unique constraint
// LowCardinality: dictionary encoding เหมาะกับ string ที่ค่าซ้ำเยอะ
await ch.command({
  query: `
    CREATE TABLE events (
      ts      DateTime,
      user_id UInt32,
      event   LowCardinality(String),
      amount  Decimal(10, 2)
    )
    ENGINE = MergeTree
    ORDER BY (event, ts)
  `,
});

// insert ด้วย JSONEachRow: client ส่งเป็น batch เดียว
await ch.insert({
  table: "events",
  format: "JSONEachRow",
  values: [
    { ts: "2026-10-01 10:00:00", user_id: 1, event: "view", amount: 0 },
    { ts: "2026-10-01 10:05:00", user_id: 1, event: "purchase", amount: 199.5 },
    { ts: "2026-10-01 11:00:00", user_id: 2, event: "view", amount: 0 },
    { ts: "2026-10-02 09:00:00", user_id: 2, event: "purchase", amount: 49 },
  ],
});

console.table(await rows("SELECT * FROM events ORDER BY ts"));

// query_params: {name:Type} ป้องกัน SQL injection
console.table(
  await rows("SELECT event, count() AS n, sum(amount) AS total FROM events WHERE user_id = {uid:UInt32} GROUP BY event", {
    uid: 1,
  }),
);
await ch.close();
