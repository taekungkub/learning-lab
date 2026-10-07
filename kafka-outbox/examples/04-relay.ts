// bun run examples/04-relay.ts   (รันค้างไว้, Ctrl+C หยุด)
// relay: poll outbox แล้ว publish ไป Kafka ใช้ event.id เป็น header ให้ consumer dedupe
import { kafka, ensureTopic } from "../src/kafka";
import { processBatch, type Handler } from "../src/relay";

await ensureTopic();
const producer = kafka.producer({ idempotent: true }); // กัน duplicate จาก producer retry (ไม่ใช่จาก relay)
await producer.connect();

const publishToKafka: Handler = async (event) => {
  await producer.send({
    topic: event.topic,
    messages: [
      {
        key: event.key,
        value: JSON.stringify(event.payload),
        headers: { "event-id": event.id, "event-type": event.type },
      },
    ],
  });
};

let running = true;
process.on("SIGINT", () => (running = false));

console.log("relay started");
while (running) {
  const n = await processBatch(publishToKafka);
  if (n) console.log(`published ${n} event(s)`);
  else await Bun.sleep(1000); // ว่าง: รอ 1 วิ, มีงาน: วนต่อทันที
}
await producer.disconnect();
console.log("relay stopped");
