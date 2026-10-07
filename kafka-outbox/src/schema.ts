import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

const now = () => new Date();

// business table ตัวอย่าง
export const orders = sqliteTable("orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  customer: text("customer").notNull(),
  amount: integer("amount").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

// outbox: เขียนใน transaction เดียวกับ business row แล้ว relay ค่อยส่งไป Kafka
// เทียบ core-platform-backend/pkg/outbox (Go)
export const outboxEvents = sqliteTable(
  "outbox_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()), // event id ให้ consumer dedupe
    topic: text("topic").notNull(),
    key: text("key"), // Kafka partition key: ลำดับ event ต่อ key ถูกรักษา
    type: text("type").notNull(),
    payload: text("payload", { mode: "json" }).notNull(),
    status: text("status", { enum: ["PENDING", "PROCESSING", "COMPLETED", "FAILED"] })
      .notNull()
      .default("PENDING"),
    retryCount: integer("retry_count").notNull().default(0),
    lastError: text("last_error"),
    // PENDING: เวลาที่ retry ได้ / PROCESSING: lease หมดอายุ (relay ตายกลางทาง ตัวอื่นหยิบต่อได้)
    nextRetryAt: integer("next_retry_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
    processedAt: integer("processed_at", { mode: "timestamp_ms" }),
  },
  (t) => [index("outbox_status_created_idx").on(t.status, t.createdAt)],
);

// consumer side: กัน process ซ้ำ (outbox ให้แค่ at-least-once)
// ponytail: ใช้ไฟล์ DB เดียวกับ producer เพื่อ demo, ของจริง consumer มี DB ของตัวเอง
export const processedEvents = sqliteTable("processed_events", {
  eventId: text("event_id").primaryKey(),
  processedAt: integer("processed_at", { mode: "timestamp_ms" }).notNull().$defaultFn(now),
});

export type OutboxEvent = typeof outboxEvents.$inferSelect;
