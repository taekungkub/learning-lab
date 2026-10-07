# Transactional Outbox Pattern

## ปัญหา: dual write

service ต้อง (1) บันทึก DB และ (2) publish event ไป Kafka แต่สองระบบนี้ไม่มี transaction ร่วมกัน

| ลำดับ | พังตรงกลาง | ผล |
|---|---|---|
| DB → Kafka | crash หลัง commit | event หาย downstream ไม่รู้ |
| Kafka → DB | DB rollback | ghost event: บอกว่ามี order แต่ไม่มีจริง |

## วิธีแก้

1. เขียน business row + event ลงตาราง `outbox_events` ใน **transaction เดียวกัน**
2. **relay** แยกออกมา poll ตาราง แล้ว publish ไป Kafka
3. publish สำเร็จ → mark `COMPLETED`, ล้มเหลว → retry ด้วย backoff → เกิน max → `FAILED`

```
PENDING ──claim──▶ PROCESSING ──ok──▶ COMPLETED
   ▲                   │
   └──retry (backoff)──┤ error
                       └─เกิน maxRetries─▶ FAILED
PROCESSING ที่ lease หมด (relay ตาย) ──▶ ถูก claim ใหม่
```

## Guarantee: at-least-once

relay publish สำเร็จแล้วตายก่อน mark `COMPLETED` → lease หมด → ส่งซ้ำ
ดังนั้น **consumer ต้อง idempotent**: เก็บ `event_id` ใน `processed_events` (PK) ใน transaction เดียวกับ side effect

## Ordering

- Kafka รักษาลำดับต่อ partition, ใช้ `key` = aggregate id (เช่น order id) → event ของ order เดียวกันเรียงถูก
- relay ส่งตาม `created_at`, แต่ถ้ามี event ของ key เดียวกัน fail แล้ว retry ทีหลัง ตัวถัดไปอาจแซง
  ของจริงที่ต้องการ strict order: หยุด key นั้นจนกว่าตัวก่อนหน้าจะผ่าน

## SQLite vs Postgres (core-platform-backend)

| | Postgres (Go, `pkg/outbox/relay.go`) | SQLite (demo นี้) |
|---|---|---|
| claim | `FOR UPDATE SKIP LOCKED` ให้หลาย relay ทำงานขนานกัน | `UPDATE ... WHERE id IN (SELECT ... LIMIT) RETURNING` statement เดียว, writer ทีละตัว |
| scale | หลาย relay instance | relay ตัวเดียวพอ |

## Polling vs CDC

- **polling** (demo นี้): ง่าย, มี latency = poll interval, query DB ตลอด
- **CDC** (Debezium อ่าน WAL): latency ต่ำ, ไม่ query ตาราง แต่ต้องมี infra เพิ่ม ไว้ศึกษาทีหลัง

## Checklist

- [ ] 01 produce/consume พื้นฐาน, key กับ partition
- [ ] 02 เห็น dual write พังกับตา
- [ ] 03 outbox write ใน transaction
- [ ] 04 relay publish จริง
- [ ] 05 retry / backoff / FAILED
- [ ] 06 idempotent consumer: kill relay ระหว่างส่ง แล้วดู duplicate skipped
