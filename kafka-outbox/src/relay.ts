// relay: ดึง event ที่ถึงเวลาส่งจาก outbox แล้วส่งต่อให้ handler (ไม่ผูกกับ Kafka)
// เทียบ core-platform-backend/pkg/outbox/relay.go
import { and, asc, eq, inArray, isNull, lte, or } from "drizzle-orm";
import { db } from "./db";
import { outboxEvents, type OutboxEvent } from "./schema";

export type Handler = (event: OutboxEvent) => Promise<void>;

export type RelayOptions = {
  batchSize?: number;
  leaseMs?: number; // นานแค่ไหนก่อน PROCESSING ที่ค้างถูกหยิบใหม่
  maxRetries?: number;
  baseBackoffMs?: number; // backoff = base * 2^(retry-1)
  topic?: string; // จำกัดเฉพาะ topic เดียว (ใช้ใน example 05)
};

export async function processBatch(handler: Handler, opts: RelayOptions = {}) {
  const { batchSize = 50, leaseMs = 60_000, maxRetries = 5, baseBackoffMs = 1000, topic } = opts;
  const now = new Date();
  const e = outboxEvents;

  // claim แบบ atomic: Postgres ใช้ FOR UPDATE SKIP LOCKED
  // SQLite มี writer ได้ทีละตัว เลยใช้ UPDATE ... WHERE id IN (SELECT ... LIMIT) RETURNING statement เดียวแทนได้
  const due = db
    .select({ id: e.id })
    .from(e)
    .where(
      and(
        topic ? eq(e.topic, topic) : undefined,
        or(
          and(eq(e.status, "PENDING"), or(isNull(e.nextRetryAt), lte(e.nextRetryAt, now))),
          and(eq(e.status, "PROCESSING"), lte(e.nextRetryAt, now)), // lease หมดอายุ
        ),
      ),
    )
    .orderBy(asc(e.createdAt))
    .limit(batchSize);

  const claimed = await db
    .update(e)
    .set({ status: "PROCESSING", nextRetryAt: new Date(now.getTime() + leaseMs) })
    .where(inArray(e.id, due))
    .returning();
  // RETURNING ไม่การันตีลำดับ ต้อง sort เอง
  claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  for (const event of claimed) {
    try {
      await handler(event);
      await db
        .update(e)
        .set({ status: "COMPLETED", processedAt: new Date(), lastError: null })
        .where(eq(e.id, event.id));
    } catch (err) {
      const retryCount = event.retryCount + 1;
      const lastError = err instanceof Error ? err.message : String(err);
      const update =
        retryCount > maxRetries
          ? { status: "FAILED" as const, processedAt: new Date(), lastError }
          : {
              status: "PENDING" as const,
              retryCount,
              lastError,
              nextRetryAt: new Date(Date.now() + baseBackoffMs * 2 ** (retryCount - 1)),
            };
      await db.update(e).set(update).where(eq(e.id, event.id));
    }
  }
  return claimed.length;
}
