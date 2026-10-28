# ClickHouse: คำศัพท์ + เทียบ PostgreSQL

ไว้ตัดสินใจว่า ClickHouse คุ้มไหม ตัวเลขในไฟล์นี้วัดจาก examples ใน repo (Docker เครื่องเดียว ClickHouse 26.3)
**ยังไม่ได้ benchmark Postgres กับข้อมูลชุดเดียวกัน** ฝั่ง PG จึงเป็นความสามารถตาม docs ไม่ใช่ตัวเลขที่วัดเอง

---

## สรุปก่อน

| | ClickHouse | PostgreSQL (+ TimescaleDB) |
|---|---|---|
| ออกแบบมาเพื่อ | OLAP: aggregate ข้อมูลเยอะ insert อย่างเดียว | OLTP: อ่าน/เขียน/แก้ทีละแถว + transaction |
| เก็บข้อมูล | แยกคอลัมน์ (columnar) | แยกแถว (row) / Timescale compress เป็น columnar ได้ |
| เด่น | scan + aggregate หลักร้อยล้าน-พันล้านแถว, บีบอัดสูง, MV incremental ทุก insert | transaction, UPDATE/DELETE, constraint, JOIN ซับซ้อน, ecosystem |
| อ่อน | UPDATE/DELETE, transaction, unique, insert ทีละแถว | aggregate ข้อมูลใหญ่มาก, ไม่มี TTL/MV incremental ในตัว |

**กรณี sensor ของเรา** (5k-10k device, insert อย่างเดียว, dashboard aggregate รายชั่วโมง-ปี):
ClickHouse เหมาะกว่าถ้าส่งถี่ (ระดับวินาที) ถ้าส่งห่าง (ระดับนาที) PG + TimescaleDB ก็ไหว ดูหัวข้อ [ตัดสินใจ](#ตัดสินใจ)

---

## คำศัพท์

### การเก็บข้อมูล

| คำ | ความหมาย | ใน repo |
|---|---|---|
| **Columnar** | เก็บแต่ละคอลัมน์แยกไฟล์ query อ่านเฉพาะคอลัมน์ที่ใช้ ค่าคล้ายกันอยู่ติดกันเลยบีบอัดดี | ex 02 |
| **MergeTree** | engine หลัก ทุก engine ตระกูลนี้ทำงานแบบ part + merge | ทุกตาราง |
| **Part** | ก้อนข้อมูล immutable ที่เกิดจาก insert 1 ครั้ง (ต่อ partition) | `system.parts` |
| **Merge** | background รวม part เล็กเป็นก้อนใหญ่ ตอนนี้ engine พิเศษทำงาน (dedupe, รวม state, TTL) | ex 07 เห็น 10 แถวเหลือ 2 |
| **Granule** | หน่วยอ่านที่เล็กที่สุด default 8,192 แถว | ex 03 |
| **Sparse primary index** | index 1 entry ต่อ granule (ไม่ใช่ต่อแถว) เล็กพอจะอยู่ใน RAM ข้าม granule ที่ไม่เกี่ยวได้ | ex 03 |
| **ORDER BY** (sorting key) | ลำดับการเรียงข้อมูลบน disk = primary key ถ้าไม่ระบุแยก ตัดสินว่า query ไหนเร็ว **แก้ทีหลังไม่ได้** | `(sensor, metric, ts)` |
| **PRIMARY KEY** | **ไม่ unique** แค่ prefix ของ ORDER BY ที่ใช้ทำ index | |
| **PARTITION BY** | แบ่งข้อมูลเป็นกลุ่ม ใช้จัดการข้อมูล (drop ทั้งก้อน) ไม่ใช่ตัวเร่ง query หลัก **แก้ทีหลังไม่ได้** | รายวัน/รายเดือน |
| **TTL** | ลบแถว (หรือล้างคอลัมน์/ย้าย disk) ที่เก่ากว่ากำหนด ทำตอน merge ไม่ตรงเวลา | `src/config.ts` |
| **ttl_only_drop_parts** | TTL ลบทั้ง part ทีเดียว ไม่ตัดทีละแถว (ต้อง partition ให้ขนาดใกล้ช่วง TTL) | ex 08 |
| **LowCardinality(T)** | dictionary encoding สำหรับค่าที่ซ้ำเยอะ (ชื่อ device, metric) | ex 02: 9 MiB → 45 KiB |
| **Codec** | วิธีบีบอัดต่อคอลัมน์ `LZ4` (default), `ZSTD`, `Delta` (เวลา), `Gorilla` (float ขยับทีละนิด) | |

### Engine

| Engine | ตอน merge ทำอะไร | ใช้เมื่อ |
|---|---|---|
| `MergeTree` | รวม part | ทั่วไป, raw |
| `ReplacingMergeTree(ver)` | key ซ้ำเก็บ version สูงสุด | upsert, CDC (ex 04) |
| `SummingMergeTree` | sum คอลัมน์ตัวเลขของ key เดียวกัน | counter ง่ายๆ |
| `AggregatingMergeTree` | merge aggregate state | ปลายทาง MV (ex 05, 07, 08) |

ทุกตัว dedupe/รวม **ตอน merge** ซึ่งไม่รู้ว่าเมื่อไหร่ query ต้อง `GROUP BY` + `-Merge` หรือ `FINAL` เสมอ

### Aggregate

| คำ | ความหมาย |
|---|---|
| **Aggregate state** | ค่าระหว่างทางของ aggregate (avg เก็บ sum + count) merge ข้ามแถว/ช่วงได้ถูก เปิดใน GUI เห็นเป็น binary |
| **`AggregateFunction(f, T)`** | ชนิดคอลัมน์ที่เก็บ state |
| **`SimpleAggregateFunction(f, T)`** | สำหรับ f ที่ state = ค่าเอง (min, max, sum) อ่านได้ตรงๆ |
| **`-State`** | `avgState(x)` สร้าง state จากค่าดิบ (ใน MV) |
| **`-Merge`** | `avgMerge(s)` รวม state เป็นค่าสุดท้าย (ตอน query) |
| **`-MergeState`** | รวม state แล้วเก็บเป็น state ต่อ (MV ซ้อน hourly → daily) |
| **`-If`** | `avgMergeIf(s, metric = 'temp')` aggregate เฉพาะแถวที่ตรงเงื่อนไข (pivot เป็นคอลัมน์) |
| **`argMax(v, t)`** | ค่า v ที่ t สูงสุด = ค่าล่าสุด |
| **`uniq` / `uniqExact`** | distinct count แบบประมาณ (เร็ว) / แม่น (แพง) |
| **`quantile(p)`** | percentile แบบประมาณจาก sample |
| **`finalizeAggregation(s)`** | แปลง state ทีละแถวโดยไม่รวม (ไว้ debug) |

### View / Pre-aggregation

| คำ | ความหมาย |
|---|---|
| **Materialized View (MV)** | insert trigger: ทุก INSERT เข้าตารางต้นทาง คำนวณ**เฉพาะ block ใหม่** แล้วเขียนลงตารางปลายทาง (`TO table`) ไม่เห็น UPDATE/DELETE ไม่ backfill เอง |
| **MV ซ้อน (cascade)** | MV อ่านตารางปลายทางของ MV อื่น (long → hourly → daily) ทำงานใน INSERT เดียวกัน |
| **Refreshable MV** | `REFRESH EVERY 1 HOUR` คำนวณใหม่ทั้งหมดตามรอบ (แบบ PG MV) |
| **View** | query ที่ตั้งชื่อไว้ ไม่เก็บข้อมูล (`sensor_hourly_v`) |
| **Parameterized view** | view รับ parameter `{sensor:String}` เรียกเหมือน function |
| **Projection** | สำเนาข้อมูลเรียงลำดับอื่นหรือ pre-aggregate ในตารางเดียวกัน ClickHouse เลือกใช้เองตอน query |
| **Backfill** | `INSERT INTO ... SELECT` ข้อมูลเก่าที่มีก่อนสร้าง MV (ex 11) |

### เขียน / แก้ข้อมูล

| คำ | ความหมาย |
|---|---|
| **Batch insert** | insert ทีละก้อนใหญ่ ไม่เกิน ~1 ครั้ง/วิ/ตาราง (ex 10 รวม 10 device เป็น 1 insert) |
| **Too many parts** | insert ถี่/เล็กเกินจน merge ตามไม่ทัน ClickHouse ปฏิเสธ insert |
| **`async_insert`** | ให้ server รวม insert เล็กเป็น batch ให้ |
| **Mutation** | `ALTER TABLE ... UPDATE/DELETE` เขียน part ใหม่ async หนัก ดูที่ `system.mutations` |
| **Lightweight DELETE** | `DELETE FROM` mark แถวไว้ ลบจริงตอน merge |
| **`FINAL`** | บังคับ dedupe/merge ตอน query (ถูกแต่แพงขึ้น) |
| **`OPTIMIZE ... FINAL`** | บังคับ merge ทันที (ใช้ใน demo/maintenance) |

### Query

| คำ | ความหมาย |
|---|---|
| **`toStartOfInterval`** | ตัดเวลาเป็น bucket (15 นาที, ชั่วโมง) |
| **`WITH FILL`** | เติม bucket ที่ไม่มีข้อมูลตอน ORDER BY |
| **Window function** | `lagInFrame`, `avg() OVER` ทำ diff, moving average |
| **`ASOF JOIN`** | join กับแถวที่เวลาใกล้สุดก่อนหน้า (ราคาล่าสุดก่อน order) |
| **`ARRAY JOIN`** | แตก array เป็นหลายแถว (แตก JSON เป็น long format ใน ex 08) |
| **`JSON` type** | เก็บ JSON โดยแยกแต่ละ key เป็น subcolumn (columnar) type ของ key เป็น `Dynamic` แปลงด้วย `::Nullable(Float64)` |
| **`query_params`** | `{name:Type}` ส่งค่าแยกจาก SQL กัน injection |

### ระบบ

| คำ | ความหมาย |
|---|---|
| **HTTP interface :8123** | client ใน repo, TablePlus (driver HTTP), Web UI `/play` |
| **Native protocol :9000** | `clickhouse-client` |
| **`system.parts`** | part / partition / ขนาด / TTL ของแต่ละตาราง |
| **`system.query_log`** | เวลา + `read_rows` ของทุก query (ต้อง `SYSTEM FLUSH LOGS`) |
| **Kafka engine** | ตารางที่อ่านจาก Kafka topic + MV เขียนต่อเข้า MergeTree (ingest แบบ batch ให้เอง) |
| **Keeper / ReplicatedMergeTree / Distributed** | replication และ cluster (ยังไม่ได้ลองใน repo) |

---

## ClickHouse ทำได้ แต่ PG ไม่มีในตัว

| ความสามารถ | ClickHouse | PostgreSQL ในตัว | ทางเลือกฝั่ง PG |
|---|---|---|---|
| Columnar storage | ทุกตาราง | ไม่มี (row/heap) | TimescaleDB compression, Citus columnar |
| บีบอัดต่อคอลัมน์ | codec ต่อคอลัมน์ | บีบอัดแค่ค่าใหญ่ (TOAST) | TimescaleDB compression |
| Vectorized execution, ใช้ทุก core ใน query เดียว | ใช่ | ทีละแถว + parallel query บางส่วน | |
| MV คำนวณเฉพาะข้อมูลใหม่ทุก insert | ใช่ | `REFRESH` ใหม่ทั้งหมด | `pg_ivm`, TimescaleDB continuous aggregate (ตามรอบ) |
| MV ซ้อน hourly → daily แบบ incremental | ใช่ | ไม่มี | TimescaleDB hierarchical cagg |
| Aggregate state (`-State`/`-Merge`) | ใช่ | ไม่มี ต้องเก็บ sum/count เองแล้วหาร | Timescale Toolkit (บาง function) |
| TTL ลบแถว/คอลัมน์/ย้าย disk | ใช่ | ไม่มี | `pg_partman` + `pg_cron`, Timescale retention policy |
| Sparse index | ใช่ | **BRIN** ใกล้เคียง (สรุปต่อ block range) | |
| `uniq` / `quantile` แบบประมาณ | ใช่ | มีแต่แบบแม่น (`count(DISTINCT)`, `percentile_cont`) | `postgresql-hll`, Timescale Toolkit |
| `WITH FILL` | ใช่ | `generate_series` + LEFT JOIN | Timescale `time_bucket_gapfill` |
| `ASOF JOIN` | ใช่ | `LATERAL ... ORDER BY LIMIT 1` | |
| `argMax` | ใช่ | `DISTINCT ON` / `ORDER BY LIMIT 1` | |
| JSON เก็บแบบ columnar | `JSON` type | `jsonb` เก็บทั้งก้อน (GIN index) | |
| ingest จาก Kafka ในตัว | Kafka engine | ไม่มี | Kafka Connect / Debezium |

หมายเหตุ TimescaleDB: compression กับ continuous aggregate อยู่ใต้ Timescale License ใช้ self-host ฟรี แต่ห้ามเอาไปขายเป็น DBaaS

## PG ทำได้ แต่ ClickHouse ทำไม่ได้ / ทำได้แย่

| ความสามารถ | PostgreSQL | ClickHouse |
|---|---|---|
| Transaction หลาย statement (ACID) | ใช่ | ไม่มีแบบเต็ม insert atomic ต่อ block |
| UPDATE/DELETE ถี่ ทีละแถว | ใช่ | mutation หนัก / lightweight delete ลบจริงตอน merge |
| UNIQUE, FOREIGN KEY, CHECK constraint | ใช่ | ไม่มี (primary key ไม่ unique) |
| Insert ทีละแถว ถี่ๆ | ใช่ | ต้อง batch ไม่งั้น too many parts |
| Point lookup ด้วยคอลัมน์ที่ไม่ใช่ key | B-tree index | ไม่มี secondary index ปกติ (มี data skipping index) |
| MV ตรงกับต้นทางเสมอ | หลัง REFRESH ใช่ | MV ไม่เห็น UPDATE/DELETE, JOIN ฝั่งขวาเปลี่ยนไม่คำนวณใหม่ |
| Dedupe ทันที | unique constraint | ReplacingMergeTree dedupe ตอน merge ต้อง `FINAL`/`argMax` |
| JOIN หลายตารางใหญ่ | optimizer ดี | ทำได้ แต่ต้องระวัง memory (ฝั่งขวาเข้า hash table) |
| ORM / tooling | เยอะมาก | น้อยกว่า (ใน repo ใช้ client ตรง ไม่มี ORM) |
| ดูแล | ทีมส่วนใหญ่คุ้น | ต้องเรียนเพิ่ม: part, merge, ORDER BY แก้ไม่ได้, cluster ต้องมี Keeper |

---

## ตัวเลขที่วัดได้ใน repo

| อะไร | ผล | ที่มา |
|---|---|---|
| insert 10M แถว (ฝั่ง server) | 1.8 วิ | ex 02 |
| aggregate 10M แถว group by country | 74 ms | ex 02 |
| บีบอัด `country` (LowCardinality) | 9.27 MiB → 45.73 KiB | ex 02 |
| บีบอัด `url` | 146 MiB → 35 MiB | ex 02 |
| filter ด้วย prefix ของ ORDER BY | อ่าน 7 / 1,224 granule | ex 03 |
| filter ด้วยคอลัมน์นอก ORDER BY | อ่าน 1,224 / 1,224 granule (ทั้งตาราง) | ex 03 |
| insert 1 batch/วิ ผ่าน MV 1 ตัว | 7-9 ms ต่อ insert | ex 07 |
| 1 ปีรายวินาที 31.5M แถว: รายวันจาก hourly | 3.4 ms, อ่าน 8,760 แถว | benchmark ในแชท |
| เหมือนกันแต่จาก raw | 83.7 ms, อ่าน 31.5M แถว | benchmark ในแชท |
| avg ข้ามชั้น hourly → day/month/year เทียบ raw | count/min/max ตรงทุกแถว avg ต่าง ≤ 7×10⁻¹³ | benchmark ในแชท |
| 20 series × 30 วัน รายวินาที (`sensor_long`) | 51.8M แถว = 340 MiB | ex 11 รุ่นแรก |

ข้อจำกัด: เครื่องเดียว, query ไม่มีคนแย่ง, ข้อมูล mock (noise สุ่ม บีบอัดแย่กว่าข้อมูลจริงที่ขยับช้า)

---

## ตัดสินใจ

### ขนาดข้อมูล

แถวต่อวินาที = device × metric ÷ ความถี่ (วินาที)
ตัวอย่าง 10,000 device × 7.5 metric (เฉลี่ยของ mock ตอนนี้):

| ส่งทุก | แถว/วิ | แถว/วัน (long) | เหมาะกับ |
|---|---|---|---|
| 1 วิ | 75,000 | 6.5 พันล้าน | ClickHouse |
| 10 วิ | 7,500 | 648 ล้าน | ClickHouse (Timescale ต้องจูนเยอะ) |
| 1 นาที | 1,250 | 108 ล้าน | ได้ทั้งคู่ |
| 5 นาที | 250 | 21.6 ล้าน | PG + Timescale สบาย |

### เลือก ClickHouse เมื่อ

- ข้อมูลหลักร้อยล้านแถวต่อวันขึ้นไป หรือเก็บหลายปี
- insert อย่างเดียว แทบไม่แก้ข้อมูลย้อนหลัง
- dashboard aggregate ช่วงยาว / รวมทั้ง fleet และต้องตอบเร็ว
- disk เป็นต้นทุนสำคัญ (บีบอัดสูง)
- รับข้อมูลผ่าน Kafka อยู่แล้ว

### เลือก PG (+ TimescaleDB) เมื่อ

- ข้อมูลหลักสิบล้านแถวต่อวันหรือน้อยกว่า
- ต้องแก้/ลบข้อมูลย้อนหลังบ่อย หรือต้องการ transaction
- ต้อง JOIN กับข้อมูลหลักของแอป (user, device master) บ่อย
- ทีมไม่อยากดูแล DB เพิ่มอีกตัว

### ใช้ทั้งคู่ (เจอบ่อยที่สุด)

```
แอป ──► Postgres (device master, user, config: แก้ได้, มี transaction)
device ──► Kafka ──► ClickHouse (ค่าวัด: insert อย่างเดียว, aggregate)
```

dashboard อ่านค่าวัดจาก ClickHouse แล้วเอาชื่อ/ข้อมูล device จาก Postgres (หรือ sync master เข้า ClickHouse เป็น dictionary)

### ยังต้องพิสูจน์ก่อนสรุปจริง

1. ความถี่ที่ device ส่งจริง (กำหนดขนาดข้อมูลทั้งหมด)
2. Benchmark PG + Timescale กับข้อมูลชุดเดียวกัน (Postgres รันอยู่ในเครื่องที่ :54321)
3. ทดสอบกับ 10k device จริง (`DEVICES=10000`) อย่างน้อย 1 วัน
4. ข้อมูลไม่สมบูรณ์: device หาย, ส่งซ้ำ, ส่งย้อนหลัง, counter reset
