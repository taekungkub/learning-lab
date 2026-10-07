// bun run examples/06-idempotent-consumer.ts   (รันค้างไว้คู่กับ 04-relay.ts)
// outbox = at-least-once: relay ส่งแล้วตายก่อน mark COMPLETED -> ส่งซ้ำ
// consumer ต้อง dedupe ด้วย event-id ใน transaction เดียวกับ side effect
import { db } from "../src/db";
import { processedEvents } from "../src/schema";
import { kafka, TOPIC, ensureTopic } from "../src/kafka";

await ensureTopic();
const consumer = kafka.consumer({ groupId: "order-notifier" });
await consumer.connect();
await consumer.subscribe({ topic: TOPIC, fromBeginning: true });

process.on("SIGINT", async () => {
  await consumer.disconnect();
  process.exit(0);
});

await consumer.run({
  eachMessage: async ({ message }) => {
    const eventId = message.headers?.["event-id"]?.toString();
    if (!eventId) return;

    const isNew = await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(processedEvents)
        .values({ eventId })
        .onConflictDoNothing()
        .returning();
      if (!inserted.length) return false;
      // side effect จริงอยู่ตรงนี้ (เขียน DB ของ consumer) commit พร้อม processed_events
      return true;
    });

    console.log(isNew ? "processed" : "duplicate skipped", eventId, message.value?.toString());
  },
});
