# kafka-outbox

ฝึก Transactional Outbox Pattern กับ Kafka บน Bun + Drizzle + libSQL (SQLite)
ไอเดียมาจาก `core-platform-backend/pkg/outbox` (Go + Postgres) ดู `docs/outbox-pattern.md`

## Setup

ต้องมี Kafka-compatible broker ที่ `localhost:19092` (เปลี่ยนได้ด้วย `KAFKA_BROKER`)

```bash
# --- Kafka (Redpanda) ---
docker compose up -d      # start broker (:19092) + console GUI (:8089)
docker compose ps         # เช็คว่า container ขึ้นครบ
docker compose logs -f    # ดู log (Ctrl+C ออก)
docker compose stop       # หยุดชั่วคราว ข้อมูลยังอยู่
docker compose down       # ลบ container ข้อมูลใน Kafka หายหมด

# --- Bun + DB ---
bun install               # ลง dependencies
bun run db:push           # สร้าง/อัปเดตตารางใน kafka-outbox.sqlite จาก src/schema.ts
bun run reset             # ลบไฟล์ sqlite แล้วสร้างตารางใหม่ (เริ่มจากศูนย์)
bun run db:studio         # เปิด Drizzle Studio ดูข้อมูลในตาราง
```

## โครงสร้าง

- `src/schema.ts`: `orders`, `outbox_events`, `processed_events`
- `src/orders.ts`: `createOrder` เขียน order + event ใน transaction เดียว
- `src/relay.ts`: `processBatch` claim → handler → COMPLETED / retry / FAILED
- `src/kafka.ts`: kafkajs client, `ensureTopic`

## Examples

รันจบในตัว:

```bash
bun run examples/01-kafka-produce-consume.ts  # produce 3 msg แล้ว consume กลับ ดู key → partition
bun run examples/02-dual-write-problem.ts     # insert DB แล้ว crash ก่อน publish: event หาย
bun run examples/03-outbox-write.ts           # order + outbox event ใน tx เดียว, ตัวที่ rollback ไม่เหลืออะไร
bun run examples/05-retry-backoff.ts          # retry/backoff/FAILED ด้วย handler ปลอม (ไม่ต้องมี Kafka)
```

ดู outbox ทำงานครบเส้น (เปิด 3 terminal):

```bash
bun run examples/04-relay.ts                # terminal 1: poll outbox แล้ว publish ไป Kafka (Ctrl+C หยุด)
bun run examples/06-idempotent-consumer.ts  # terminal 2: consume + dedupe ด้วย event-id (Ctrl+C หยุด)
bun run examples/03-outbox-write.ts         # terminal 3: สร้าง order ใหม่ รันซ้ำได้เรื่อยๆ
```

Redpanda Console (จาก compose): http://localhost:8089 → Topics → `orders.events`
