import { Kafka, logLevel } from "kafkajs";

// ปิด warning เรื่อง default partitioner ของ v2 (demo นี้ไม่สนใจ legacy behavior)
process.env.KAFKAJS_NO_PARTITIONER_WARNING = "1";
// หมายเหตุ: TimeoutNegativeWarning ตอนรันบน Bun เป็น warning ของ kafkajs ไม่กระทบการทำงาน

export const kafka = new Kafka({
  clientId: "kafka-outbox",
  brokers: [process.env.KAFKA_BROKER ?? "localhost:19092"],
  logLevel: logLevel.WARN,
});

export const TOPIC = "orders.events";

// สร้าง topic ถ้ายังไม่มี (createTopics คืน false ถ้ามีอยู่แล้ว ไม่ throw)
export async function ensureTopic(topic = TOPIC) {
  const admin = kafka.admin();
  await admin.connect();
  await admin.createTopics({ topics: [{ topic, numPartitions: 3 }] });
  await admin.disconnect();
}
