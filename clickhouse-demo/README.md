# clickhouse-demo

ฝึก ClickHouse (columnar OLAP database) บน Bun + `@clickhouse/client` (HTTP interface)
ดูแนวคิดหลักใน `docs/concepts.md`, คำศัพท์ + เทียบ PostgreSQL (ไว้ตัดสินใจ) ใน `docs/glossary-vs-pg.md`

## Setup

```bash
docker compose up -d      # clickhouse-server:26.3, user default / password demo, database demo
docker compose ps
docker compose down -v    # ลบ container + volume (ข้อมูลหาย)

bun install
```

- Web SQL UI: http://localhost:8123/play (user `default`, password `demo`)
- CLI ใน container: `docker compose exec clickhouse clickhouse-client --password demo -d demo`

## Examples

```bash
bun run examples/01-hello.ts                 # CREATE MergeTree, insert, select, query_params
bun run examples/02-bulk-aggregate.ts        # สร้าง 10M แถวด้วย numbers(), aggregate, ขนาด compress ต่อคอลัมน์
bun run examples/03-primary-key.ts           # (หลัง 02) EXPLAIN indexes: sparse index ข้าม granule ได้แค่ไหน, parts
bun run examples/04-replacing-merge-tree.ts  # upsert แบบ ClickHouse: ReplacingMergeTree, FINAL, argMax
bun run examples/05-materialized-view.ts     # MV + AggregatingMergeTree (sumState/uniqState → -Merge)
bun run examples/06-update-delete.ts         # (หลัง 01) lightweight DELETE, ALTER UPDATE mutation
bun run examples/07-hourly-rollup.ts         # insert ทุก 1 วิ + MV hourly, ดู state ย่อยถูก merge, view สำหรับ GUI
bun run examples/08-multi-metric.ts          # sensor key ต่างกัน: raw JSON → MV แตกเป็น long format → hourly → daily (เวลาไทย)
bun run examples/09-query-service.ts         # (หลัง 11) getStats(): hour/day จาก hourly, month/year จาก daily (อ่านอย่างเดียว)
bun run examples/10-simulator.ts             # (หลัง 08) device ส่งทุก 1 วิ เข้า sensor_raw (Ctrl+C หยุด)
bun run examples/11-backfill.ts              # (หลัง 08) mock ย้อนหลังรายวินาที เต็มช่วง TTL ของแต่ละตาราง
```

ทุก example DROP/CREATE ตารางเอง รันซ้ำได้ ยกเว้น 09 ที่อ่านอย่างเดียว

**ระวัง: 08 DROP ตาราง `sensor_*` ทั้งหมด** (ข้อมูลที่ 10/11 ใส่ไว้หาย) และ 11 TRUNCATE ก่อนใส่ใหม่

## ชุด sensor (08-11)

ลำดับรัน: `08` (schema) → `11` (mock ย้อนหลัง) → `10` (ข้อมูลใหม่ต่อเนื่อง ถ้าต้องการ) → `09` / `docs/queries.sql`

| ไฟล์ | ตั้งค่า |
|---|---|
| `src/config.ts` | TTL ของ raw / long / hourly (08 สร้างตาราง, 11 ใช้กำหนดช่วงที่ mock) |
| `src/mock.ts` | device + metric จำลอง (th-*: temp, humidity, ... / pm-*: 3 เฟส, kW, kWh counter) |
| `src/stats.ts` | `getStats()` สำหรับ API/service: grain, groupBy device/fleet |

env ของ 10/11:
- `DEVICES=100` จำนวน device (ค่าเริ่มต้น 10)
- `YEARS=5` ช่วงย้อนหลังของ 11 (ค่าเริ่มต้น 3: เกิน TTL hourly 2 ปีมีแค่ใน `sensor_daily`)
- `COARSE=1` ให้ 11 สร้าง hourly/daily จากค่ารายวินาทีจริง (ค่าเริ่มต้น 60: ค่าทุก 60 วิ นับเป็น 60 จุด เร็วกว่า ~30 เท่า)

PowerShell: `$env:DEVICES=100; bun run examples/10-simulator.ts`

Query พร้อม copy ไปรันใน TablePlus (ชั่วโมง/วัน/เดือน/ปี, raw, หลาย meter, aggregation, ดูเวลา query, TTL, partition): `docs/queries.sql`
