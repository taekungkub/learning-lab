// bun run examples/02-dual-write-problem.ts
// ปัญหา dual write: เขียน DB กับ Kafka เป็นสองระบบแยกกัน ไม่มี transaction ครอบทั้งคู่
import { db } from "../src/db";
import { orders } from "../src/schema";
import { kafka, TOPIC, ensureTopic } from "../src/kafka";

await ensureTopic();
const producer = kafka.producer();
await producer.connect();

async function createOrderNaive(customer: string, amount: number, crashBeforePublish: boolean) {
  const [order] = await db.insert(orders).values({ customer, amount }).returning();
  // DB commit ไปแล้ว ถ้า process ตาย / Kafka ล่ม ตรงนี้ event หายถาวร
  if (crashBeforePublish) throw new Error("จำลอง process crash หลัง commit DB");
  await producer.send({
    topic: TOPIC,
    messages: [{ key: String(order!.id), value: JSON.stringify({ type: "OrderCreated", order }) }],
  });
  return order;
}

await createOrderNaive("alice", 100, false);
try {
  await createOrderNaive("bob", 200, true);
} catch (err) {
  console.log("crash:", (err as Error).message);
}

// สลับลำดับ (publish ก่อน แล้วค่อย insert) ก็พังอีกแบบ: event ออกไปแต่ DB rollback = ghost event
console.log("orders in DB:", await db.select().from(orders));
console.log("bob อยู่ใน DB แต่ไม่มี OrderCreated ใน Kafka: downstream ไม่มีวันรู้");
await producer.disconnect();
