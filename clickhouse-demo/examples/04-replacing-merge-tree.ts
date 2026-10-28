// bun run examples/04-replacing-merge-tree.ts
// ClickHouse ไม่เน้น UPDATE: วิธีปกติคือ insert version ใหม่ แล้วให้ ReplacingMergeTree dedupe ตอน merge
import { ch, rows } from "../src/ch";

await ch.command({ query: "DROP TABLE IF EXISTS users" });
await ch.command({
  query: `
    CREATE TABLE users (id UInt32, name String, plan String, version UInt64)
    ENGINE = ReplacingMergeTree(version)  -- key ซ้ำ เก็บแถว version สูงสุด
    ORDER BY id                           -- dedupe ตาม ORDER BY ไม่ใช่ PRIMARY KEY
  `,
});

// insert แยก 2 ครั้ง = 2 parts ยังไม่ merge
await ch.insert({ table: "users", format: "JSONEachRow", values: [
  { id: 1, name: "Ann", plan: "free", version: 1 },
  { id: 2, name: "Bob", plan: "free", version: 1 },
]});
await ch.insert({ table: "users", format: "JSONEachRow", values: [
  { id: 1, name: "Ann", plan: "pro", version: 2 },
]});

console.log("ก่อน merge (เห็นซ้ำ):");
console.table(await rows("SELECT * FROM users ORDER BY id, version"));

console.log("FINAL: dedupe ตอน query (ถูกต้องแต่แพงขึ้น):");
console.table(await rows("SELECT * FROM users FINAL ORDER BY id"));

console.log("argMax: ทางเลือกที่ไม่ใช้ FINAL");
console.table(await rows("SELECT id, argMax(plan, version) AS plan FROM users GROUP BY id ORDER BY id"));

// บังคับ merge ทันที (ใช้ใน demo เท่านั้น production ปล่อย background merge)
await ch.command({ query: "OPTIMIZE TABLE users FINAL" });
console.log("หลัง OPTIMIZE FINAL:");
console.table(await rows("SELECT * FROM users ORDER BY id"));
await ch.close();
