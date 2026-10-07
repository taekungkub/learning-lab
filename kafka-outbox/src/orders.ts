import { db } from "./db";
import { orders, outboxEvents } from "./schema";
import { TOPIC } from "./kafka";

// หัวใจของ outbox: business row + event อยู่ใน transaction เดียวกัน
// commit ทั้งคู่ หรือ rollback ทั้งคู่ ไม่มีครึ่งๆ
export async function createOrder(customer: string, amount: number, failAfterInsert = false) {
  return db.transaction(async (tx) => {
    const [order] = await tx.insert(orders).values({ customer, amount }).returning();
    await tx.insert(outboxEvents).values({
      topic: TOPIC,
      key: String(order!.id),
      type: "OrderCreated",
      payload: order,
    });
    if (failAfterInsert) throw new Error("จำลอง error กลาง transaction");
    return order!;
  });
}
