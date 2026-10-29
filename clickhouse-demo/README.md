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
bun run examples/08-multi-metric.ts          # sensor key ต่างกัน: raw JSON → MV แตกเป็น long format → hourly → daily (วัน UTC)
bun run examples/09-query-service.ts         # (หลัง 11) getStats(): hour/day จาก hourly, month/year จาก daily (อ่านอย่างเดียว)
bun run examples/10-simulator.ts             # (หลัง 08) device ส่งทุก 1 วิ เข้า sensor_raw (Ctrl+C หยุด)
bun run examples/11-backfill.ts              # (หลัง 08) mock ย้อนหลังรายวินาที เต็มช่วง TTL ของแต่ละตาราง
bun run examples/13-api-body.ts              # (หลัง 11) body แบบ API เก่า (13-body.json) → กราฟ 1 เส้นต่อ (device, metric) แก้ body ที่ JSON ได้เลย
bun run examples/14-aggregate.ts             # (หลัง 11) aggregate ทั้งช่วง 1 ค่าต่อ device + เทียบช่วงก่อนหน้า (14-body.json)
```

ทุก example DROP/CREATE ตารางเอง รันซ้ำได้ ยกเว้น 09 ที่อ่านอย่างเดียว

**ระวัง: 08 DROP ตาราง `sensor_*` ทั้งหมด** (ข้อมูลที่ 10/11 ใส่ไว้หาย) และ 11 TRUNCATE ก่อนใส่ใหม่

## ชุด sensor (08-11, 13-14)

ลำดับรัน: `08` (schema) → `11` (mock ย้อนหลัง) → `10` (ข้อมูลใหม่ต่อเนื่อง ถ้าต้องการ) → `09` / `13` / `14` / `docs/queries.sql`

| ไฟล์ | ตั้งค่า |
|---|---|
| `src/config.ts` | TTL ของ raw / long / 1m / hourly (08 สร้างตาราง, 11 ใช้กำหนดช่วงที่ mock) |
| `src/api-utils.ts` | type `Agg` + แปลงเวลา ISO ↔ UTC ที่ 13, 14 ใช้ร่วมกัน |
| `src/mock.ts` | device + metric จำลอง (th-*: temp, humidity, ... / pm-*: 3 เฟส, kW, kWh counter) |
| `src/stats.ts` | `getStats()` สำหรับ API/service: หลาย sensor/metric, grain, groupBy device/total, response `{ meta, data }` + `toSeries` / `toWide` |

env ของ 10/11:
- `DEVICES=100` จำนวน device (ค่าเริ่มต้น 10)
- `YEARS=5` ช่วงย้อนหลังของ 11 (ค่าเริ่มต้น 2 = เท่า TTL hourly / ตั้ง 3 ขึ้นไปถึงจะมีช่วงที่มีแค่ใน `sensor_daily`)
- `COARSE=1` ให้ 11 สร้าง hourly/daily จากค่ารายวินาทีจริง (ค่าเริ่มต้น 60: ค่าทุก 60 วิ นับเป็น 60 จุด เร็วกว่า ~30 เท่า)

PowerShell: `$env:DEVICES=100; bun run examples/10-simulator.ts`

env ของ 13: `MAX_POINTS` (จุดต่อเส้นสูงสุด default 20000) / `RUNS`, `CONCURRENCY` (วัด p50/p95) / `SUITE=1` (ชุดทดสอบทุก interval) / `OUT` (ที่เก็บ response เต็ม)
ใช้ชื่อ device/metric ของ mock (`pm-1`, `power_kw`, ...) ไม่ใช่ UUID ของระบบจริง รายละเอียดใน `docs/sensor-pipeline.md`

## ขั้นต่อไป (ยังไม่ทำ ทำทีละขั้น)

1. ตาราง `devices` (id, type, location เป็น path `site/plant/building`) ให้ `getStats()` เลือกตาม location/type และ groupBy location ได้
   - กรองด้วย `sensor IN (SELECT id FROM devices ...)` (ใช้ index: 114/165 granule) ห้าม `dictGet` ใน WHERE (165/165)
   - `dictGet` ใช้ได้แค่ใน GROUP BY / dictionary อัปเดตตาม LIFETIME device ใหม่อาจยังไม่อยู่
2. รวมข้าม device ตามชนิด metric: avg (temp, voltage), **sum** (power_kw, current), counter (energy_kwh: sum ของ max-min ต่อ device)
   ตอนนี้ `groupBy: "total"` ใช้ avg กับทุก metric ซึ่งผิดสำหรับ power_kw / energy_kwh
3. device ย้าย location: **ตัดสินใจแล้ว** raw เก็บแค่ device_id, location มาจากตาราง `devices` (ปัจจุบัน) ถาม location ข้อมูลก่อนย้ายไปนับที่ location ใหม่ ถามตาม device ถูกเสมอ (ต้องแยกจริงค่อยเพิ่มตารางประวัติการย้าย ไม่ต้องแก้ raw)
4. ข้อมูลไม่สมบูรณ์ (device หาย, ส่งซ้ำ, ส่งย้อนหลัง, counter reset), benchmark 10k device, benchmark PG

Query พร้อม copy ไปรันใน TablePlus:
- `docs/queries.sql` ข้อมูล: นาที/ชั่วโมง/วัน/เดือน/ปี, raw, หลาย meter, aggregation
- `docs/monitoring.sql` ตรวจระบบ: เวลา query, TTL, disk, partition, part
