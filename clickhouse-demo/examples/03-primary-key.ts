// bun run examples/03-primary-key.ts   (ต้องรัน 02 ก่อน)
// sparse primary index: filter ตาม prefix ของ ORDER BY อ่านน้อย granule, filter คอลัมน์อื่นต้อง scan
import { ch, rows } from "../src/ch";

async function explain(label: string, where: string) {
  // sum(latency) ไม่ใช่ count(): count() อาจตอบจาก metadata โดยไม่อ่านข้อมูล
  const plan = await rows<{ explain: string }>(`EXPLAIN indexes = 1 SELECT sum(latency) FROM hits WHERE ${where}`);
  // index แต่ละชั้นกรองต่อกัน: Granules x/y = เหลืออ่านกี่ granule (granule = 8192 แถว)
  const granules = plan
    .map((r) => r.explain.trim())
    .filter((l) => /^(MinMax|Partition|PrimaryKey|Granules)/.test(l))
    .map((l) => (l.startsWith("Granules") ? `  ${l}` : l));
  console.log(`\n${label}  WHERE ${where}\n  ${granules.join("\n  ")}`);
}

await explain("ใช้ prefix ของ key", "country = 'TH'");
await explain("ใช้ key ครบ", "country = 'TH' AND ts < '2026-08-02'");
await explain("ไม่อยู่ใน key", "user_id = 42");

// parts: ทุก insert สร้าง part ใหม่ แล้ว background merge รวมกัน (ที่มาของชื่อ MergeTree)
console.table(
  await rows(`
    SELECT partition, name, rows, formatReadableSize(bytes_on_disk) AS size
    FROM system.parts WHERE database = 'demo' AND table = 'hits' AND active
    ORDER BY name
  `),
);
await ch.close();
