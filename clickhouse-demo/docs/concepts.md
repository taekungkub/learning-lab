# ClickHouse concepts

## OLAP vs OLTP

- **Columnar**: เก็บแยกคอลัมน์ query อ่านเฉพาะคอลัมน์ที่ใช้ ค่าในคอลัมน์คล้ายกันเลย compress ดี
  (ex 02: `country` LowCardinality 9 MiB เหลือ ~45 KiB)
- เหมาะ: aggregate ข้อมูลเยอะ (log, event, metric, analytics) insert เป็น batch
- ไม่เหมาะ: update/delete ทีละแถวถี่ๆ, transaction, point lookup แบบ OLTP

## MergeTree

- ทุก `INSERT` สร้าง **part** ใหม่ (immutable) background merge รวม part ให้ใหญ่ขึ้น
  → insert เป็น batch ใหญ่ (หลักพัน–แสนแถว) ไม่ใช่ทีละแถว ไม่งั้น "too many parts"
- `ORDER BY` = sorting key และ (ถ้าไม่ระบุ `PRIMARY KEY`) primary key
- **Primary key ไม่ unique** เป็น sparse index: 1 entry ต่อ granule (8192 แถว)
  filter ตาม prefix ของ key ข้าม granule ได้ คอลัมน์ที่ไม่อยู่ใน key ต้อง scan (ex 03)
- เลือก key: คอลัมน์ที่ filter บ่อย, cardinality ต่ำไปสูง
- `PARTITION BY`: หน่วยจัดการข้อมูล (drop partition เก่า, TTL) อย่าละเอียดเกิน (เดือน/วัน พอ)

## Engine ตระกูล MergeTree

| Engine | ตอน merge ทำอะไร | ใช้เมื่อ |
| --- | --- | --- |
| `MergeTree` | รวม part เฉยๆ | ทั่วไป |
| `ReplacingMergeTree(ver)` | key ซ้ำเก็บ ver สูงสุด | upsert / CDC (ex 04) |
| `SummingMergeTree` | sum คอลัมน์ตัวเลขของ key เดียวกัน | counter |
| `AggregatingMergeTree` | merge aggregate state | ปลายทางของ MV (ex 05) |

dedupe/aggregate เกิด **ตอน merge** ซึ่งไม่รู้ว่าเมื่อไหร่ → query ต้อง `FINAL` หรือ `GROUP BY` เองเสมอ

## Materialized View

- เป็น insert trigger: ประมวลผลเฉพาะ block ที่ insert ใหม่ ไม่ใช่ snapshot ทั้งตาราง
- ไม่ backfill อัตโนมัติ ข้อมูลเก่าต้อง `INSERT INTO target SELECT ...` เอง
- คู่ `xxxState` (เขียน) กับ `xxxMerge` (อ่าน)

## Update / Delete

- `DELETE FROM` (lightweight): mark แถว ลบจริงตอน merge
- `ALTER TABLE ... UPDATE/DELETE` = mutation เขียน part ใหม่ async ดูสถานะที่ `system.mutations`
- ทางที่ถูกส่วนใหญ่: insert version ใหม่ + ReplacingMergeTree หรือ TTL

## Sensor ที่มี key ต่างกัน (ex 08)

- **Long format** `(ts, sensor, metric, value)`: 1 แถวต่อค่า รับ key ใหม่โดยไม่ต้อง ALTER ทำ rollup ง่าย
- **คอลัมน์ `JSON`**: เก็บ payload ทั้งก้อน แต่ละ key เป็น subcolumn type `Dynamic`
  - ค่า `220` ถูกเก็บเป็น `Int64`, `220.1` เป็น `Float64` ปนกันใน key เดียว
  - แปลงเป็นตัวเลขต้องใช้ `data.x::Nullable(Float64)`
    - `::Float64` → key ที่ไม่มีกลายเป็น 0 แล้วถูกเฉลี่ยด้วย
    - `.:Float64` → เลือกเฉพาะค่าที่เก็บเป็น Float64 ค่า Int64 หายเงียบ
- แบบผสม: raw เป็น JSON แล้ว MV แตกเป็น long ด้วย `ARRAY JOIN JSONExtractKeysAndValues(...)`

## TTL + partition (ex 08)

- `TTL ts + INTERVAL n DAY`: ลบเฉพาะแถวที่ `ts` เก่ากว่า n วัน นับจากค่าในคอลัมน์ ไม่ใช่วันที่ insert
- ลบตอน merge ไม่ตรงเวลา query ที่ต้องการ n วันพอดีให้ใส่ `WHERE` เอง
- ตารางใหญ่: partition ให้ขนาดใกล้ช่วง TTL + `ttl_only_drop_parts = 1` เพื่อลบทั้ง partition ไม่ต้องเขียน part ใหม่
- จำนวน partition คงที่ (≈ TTL ÷ ขนาด partition) ที่โตคือขนาดต่อ partition
- TTL ยาวขึ้นตามชั้น: raw 7 วัน → long 30 วัน → hourly 2 ปี → daily ไม่ลบ ลบชั้นล่างไม่กระทบชั้นบน
- ห้าม `PARTITION BY` ตาม device: 10k device = 10k partition, insert แตกเป็นหลายพัน part

## Codec (ex 08)

- ClickHouse บีบทุกคอลัมน์ด้วย LZ4 อยู่แล้ว แต่ LZ4 หาก้อนซ้ำ เวลาที่เพิ่มทีละ 1 วิไม่มีก้อนซ้ำ บีบได้ 1 เท่า
- `ts`: `CODEC(Delta, ZSTD(1))` เก็บส่วนต่าง (เรียงตาม ORDER BY แล้วเป็น 1 แทบทั้งหมด) 676 MiB → 834 KiB
- `value`: ทดสอบกับ mock แล้ว `ZSTD(1)` ดีสุด `Gorilla` ใหญ่กว่า LZ4 (noise สุ่มทำให้ค่าติดกันกระโดด) ข้อมูลจริงวัดซ้ำ
- `sensor_long` 30 วัน: 1.29 GiB → 356.65 MiB, query scan รายชั่วโมงเร็วขึ้นเล็กน้อย (อ่าน disk น้อยลง)
- แก้ทีหลังได้: `ALTER TABLE ... MODIFY COLUMN ts DateTime CODEC(...)` (part เดิมบีบใหม่ตอน merge) ไม่เหมือน ORDER BY / PARTITION BY

## Q&A

- **ทำไม ex 03 ใช้ sum() ไม่ใช่ count()?** `count()` อาจถูกตอบจาก metadata/primary index (`_exact_count_projection`) โดยไม่อ่านข้อมูล plan เลยไม่สะท้อนการ scan จริง
- **`uniq` vs `uniqExact`?** `uniq` ประมาณค่า (HyperLogLog-ish) เร็ว/ใช้ RAM น้อย `uniqExact` แม่นแต่แพง
