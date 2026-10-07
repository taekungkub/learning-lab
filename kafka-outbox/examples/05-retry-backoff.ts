// bun run examples/05-retry-backoff.ts
// retry + exponential backoff + FAILED: handler ที่ fail 2 ครั้งแรก กับตัวที่ fail ตลอด
// ใช้ topic แยก + handler ปลอม ไม่ต้องมี Kafka
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { outboxEvents } from "../src/schema";
import { processBatch } from "../src/relay";

const topic = "demo.retry";
await db.delete(outboxEvents).where(eq(outboxEvents.topic, topic));
await db.insert(outboxEvents).values([
  { topic, type: "Flaky", payload: {} },
  { topic, type: "Broken", payload: {} },
]);

const attempts: Record<string, number> = {};
const opts = { topic, maxRetries: 3, baseBackoffMs: 200 };

for (let tick = 0; tick < 20; tick++) {
  await processBatch(async (e) => {
    attempts[e.type] = (attempts[e.type] ?? 0) + 1;
    if (e.type === "Broken" || attempts[e.type]! <= 2) throw new Error(`${e.type} attempt ${attempts[e.type]}`);
  }, opts);
  await Bun.sleep(150);
}

const rows = await db.select().from(outboxEvents).where(eq(outboxEvents.topic, topic));
console.table(rows.map(({ type, status, retryCount, lastError }) => ({ type, status, retryCount, lastError })));
console.log("attempts:", attempts);

// self-check: Flaky สำเร็จรอบ 3, Broken ลอง 1 + 3 retry แล้ว FAILED
const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
console.assert(byType.Flaky?.status === "COMPLETED", "Flaky should be COMPLETED");
console.assert(byType.Broken?.status === "FAILED", "Broken should be FAILED");
console.assert(attempts.Broken === 4, "Broken should be tried 4 times");
