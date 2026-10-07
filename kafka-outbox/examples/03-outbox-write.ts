// bun run examples/03-outbox-write.ts
// เขียน order + outbox event ใน transaction เดียว ยังไม่แตะ Kafka เลย
import { db } from "../src/db";
import { outboxEvents } from "../src/schema";
import { createOrder } from "../src/orders";

const order = await createOrder("carol", 300);
console.log("created:", order);

try {
  await createOrder("dave", 400, true);
} catch (err) {
  console.log("rolled back:", (err as Error).message);
}

// dave ไม่มีทั้ง order และ event: consistent เสมอ
console.log("outbox:", await db.select().from(outboxEvents));
console.log("ต่อไป: รัน 04-relay.ts เพื่อส่ง PENDING ไป Kafka");
