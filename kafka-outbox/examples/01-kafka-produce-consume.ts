// bun run examples/01-kafka-produce-consume.ts
// พื้นฐาน Kafka: produce แล้ว consume กลับมา ยังไม่เกี่ยวกับ outbox
import { kafka, ensureTopic } from "../src/kafka";

const topic = "demo.hello";
await ensureTopic(topic);

const producer = kafka.producer();
await producer.connect();
// key เดียวกันลง partition เดียวกัน: ลำดับต่อ key ถูกรักษา
await producer.send({
  topic,
  messages: [
    { key: "user-1", value: "hello 1" },
    { key: "user-1", value: "hello 2" },
    { key: "user-2", value: "hi from user-2" },
  ],
});
await producer.disconnect();
console.log("produced 3 messages");

// groupId ใหม่ทุกครั้ง + fromBeginning: อ่านตั้งแต่ต้น topic
const consumer = kafka.consumer({ groupId: `demo-${Date.now()}` });
await consumer.connect();
await consumer.subscribe({ topic, fromBeginning: true });

let seen = 0;
await new Promise<void>((resolve) => {
  consumer.run({
    eachMessage: async ({ partition, message }) => {
      console.log(`p${partition} key=${message.key} value=${message.value}`);
      if (++seen >= 3) resolve();
    },
  });
});
await consumer.disconnect();
