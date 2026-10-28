// bun run examples/05-materialized-view.ts
// Materialized View = insert trigger: ทุก insert เข้า source ถูก aggregate ต่อลง target table
import { ch, rows } from "../src/ch";

for (const t of ["orders_daily_mv", "orders_daily", "orders"]) await ch.command({ query: `DROP TABLE IF EXISTS ${t}` });

await ch.command({
  query: `CREATE TABLE orders (ts DateTime, shop LowCardinality(String), amount Decimal(10,2), user_id UInt32)
          ENGINE = MergeTree ORDER BY (shop, ts)`,
});

// AggregatingMergeTree เก็บ "state" ของ aggregate แล้ว merge state ได้
// (sum ใช้ SummingMergeTree ก็พอ แต่ uniq ต้องเก็บเป็น state)
await ch.command({
  query: `CREATE TABLE orders_daily (
            day     Date,
            shop    LowCardinality(String),
            revenue AggregateFunction(sum, Decimal(10,2)),
            buyers  AggregateFunction(uniq, UInt32)
          ) ENGINE = AggregatingMergeTree ORDER BY (shop, day)`,
});

// MV ทำงานเฉพาะข้อมูลที่ insert หลังสร้าง MV (ไม่ backfill เอง)
await ch.command({
  query: `CREATE MATERIALIZED VIEW orders_daily_mv TO orders_daily AS
          SELECT toDate(ts) AS day, shop, sumState(amount) AS revenue, uniqState(user_id) AS buyers
          FROM orders GROUP BY day, shop`,
});

const values = Array.from({ length: 1000 }, (_, i) => ({
  ts: `2026-10-0${(i % 3) + 1} 12:00:00`,
  shop: ["A", "B"][i % 2],
  amount: (i % 10) * 10,
  user_id: i % 37,
}));
// insert 2 รอบ: target มีหลายแถวต่อ key จนกว่าจะ merge
await ch.insert({ table: "orders", format: "JSONEachRow", values: values.slice(0, 500) });
await ch.insert({ table: "orders", format: "JSONEachRow", values: values.slice(500) });

console.log("แถวดิบใน orders_daily (state ยังไม่ merge):", (await rows("SELECT count() AS n FROM orders_daily"))[0]);

// อ่านต้องใช้ -Merge + GROUP BY เสมอ
const fromMv = await rows(`
  SELECT day, shop, sumMerge(revenue) AS revenue, uniqMerge(buyers) AS buyers
  FROM orders_daily GROUP BY day, shop ORDER BY day, shop`);
console.table(fromMv);

// เทียบกับคำนวณจาก source ตรงๆ: ต้องเท่ากัน
const fromSource = await rows(`
  SELECT toDate(ts) AS day, shop, sum(amount) AS revenue, uniq(user_id) AS buyers
  FROM orders GROUP BY day, shop ORDER BY day, shop`);
console.assert(JSON.stringify(fromMv) === JSON.stringify(fromSource), "MV ไม่ตรงกับ source");
console.log("MV ตรงกับ source:", JSON.stringify(fromMv) === JSON.stringify(fromSource));
await ch.close();
