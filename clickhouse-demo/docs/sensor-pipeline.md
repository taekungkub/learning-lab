# Sensor pipeline (examples 08-11)

สรุปชุด sensor: schema (08), mock ย้อนหลัง (11), simulator (10), query service (09) และ config ที่ใช้ร่วมกัน

## ภาพรวม

```
device ──INSERT──► sensor_raw ──MV──► sensor_long ──MV──► sensor_hourly ──MV──► sensor_daily
                   (JSON)              (1 แถว/ค่า)         (สรุปรายชั่วโมง)       (สรุปรายวัน ไทย)
                   TTL 3 วัน            TTL 7 วัน           TTL 2 ปี               ไม่มี TTL
```

แอป/ตัวกลาง insert เข้า `sensor_raw` ตารางเดียว ที่เหลือ ClickHouse คำนวณต่อเองใน INSERT เดียวกัน

ลำดับรัน:

```bash
bun run examples/08-multi-metric.ts   # สร้าง schema (DROP sensor_* ทั้งหมด!)
bun run examples/11-backfill.ts       # mock ย้อนหลัง (~1 นาที)
bun run examples/10-simulator.ts      # ข้อมูลใหม่ต่อเนื่อง ถ้าต้องการ (Ctrl+C หยุด)
bun run examples/09-query-service.ts  # getStats() อ่านอย่างเดียว
```

Query สำหรับ TablePlus: `docs/queries.sql`

---

## `src/config.ts`: TTL ที่เดียว

```ts
raw:    { days: 3 }    // payload JSON เดิม ไว้ debug
long:   { days: 7 }    // ค่ารายวินาที
hourly: { years: 2 }   // กราฟรายชั่วโมง
// daily ไม่มี TTL
```

- 08 ใช้ตั้ง TTL ตอนสร้างตาราง, 11 ใช้กำหนดว่าจะ mock ช่วงไหนลงตารางไหน
- TTL ต้องยาวขึ้นตามชั้น: สรุปถูกเขียนไว้ตั้งแต่ตอน insert ลบชั้นล่างแล้วชั้นบนยังอยู่
- long ลดจาก 30 เหลือ 7 วัน: ที่ 10k device ส่งทุกวินาที long ~12 GiB/วัน (30 วัน ~350 GiB, 7 วัน ~85 GiB)
- แก้ค่าแล้ว: demo รัน 08 ใหม่ / ระบบจริง `ALTER TABLE ... MODIFY TTL` (ข้อมูลไม่หาย)

---

## Example 08: schema + MV

| ตาราง | engine | PARTITION BY | ORDER BY | หมายเหตุ |
|---|---|---|---|---|
| `sensor_raw` | MergeTree | รายวัน | `(sensor, ts)` | `data JSON` แยก key เป็น subcolumn ให้เอง |
| `sensor_long` | MergeTree | รายวัน | `(sensor, metric, ts)` | 1 แถวต่อ 1 ค่า รับ metric ใหม่โดยไม่ต้อง ALTER |
| `sensor_hourly` | AggregatingMergeTree | รายเดือน | `(sensor, metric, hour)` | เก็บ state: `samples`, `avg_v` เป็น binary |
| `sensor_daily` | AggregatingMergeTree | ไม่แบ่ง | `(sensor, metric, day)` | วันตัดตามเวลาไทยตั้งแต่ตอนเขียน |

คอลัมน์เวลา: raw/long = `ts`, hourly = `hour`, daily = `day`

MV แต่ละชั้น:

1. `sensor_long_mv`: แตก JSON เป็นแถว `ARRAY JOIN JSONExtractKeysAndValues(...)` key ที่ไม่ใช่ตัวเลข (`status`) ตัดทิ้ง
2. `sensor_hourly_mv`: `toStartOfHour(ts)` + `countState` / `avgState` / `min` / `max`
3. `sensor_daily_mv`: อ่าน hourly ที่เป็น state อยู่แล้ว ต้องใช้ `-MergeState`

View สำหรับ TablePlus: `sensor_hourly_v` / `sensor_daily_v` ครอบ `-Merge` ไว้ เปิดแล้วอ่านออก

ตั้งค่าเพิ่ม:

- `ttl_only_drop_parts = 1`: TTL ลบ part ทั้งก้อน ไม่ตัดทีละแถว
- Codec: `ts` = `Delta, ZSTD(1)`, `value` = `ZSTD(1)` → long เล็กลง 3.7 เท่า (`ts` 662 MiB → 834 KiB)

08 ตรวจอะไร:

- กับดัก JSON: แปลงด้วย `::Nullable(Float64)` / `::Float64` เปลี่ยนค่าที่ไม่มีเป็น 0 / `.:Float64` ข้ามค่า Int64 เงียบๆ
- hourly และ daily ตรงกับคำนวณจาก raw
- daily แยกวันตามเวลาไทยถูก (ทดสอบข้อมูลคร่อมเที่ยงคืน)

---

## `src/mock.ts`: device + metric จำลอง

- device: `DEVICES` ตัว (default 10) สลับ `th-1, pm-1, th-2, ...`
- metric:
  - `th` 5 ตัว: temp, humidity, dew_point, battery_v, rssi (+ status เป็น string)
  - `pm` 10 ตัว: voltage_l1..l3, current_l1..l3, power_kw, power_factor, frequency, energy_kwh
- ค่า = ค่ากลาง + ฤดู + รอบวัน (ชั่วโมงไทย) + noise แต่ละ device เลื่อนค่าไม่เท่ากัน
- `energy_kwh` เป็น counter สะสมแบบมิเตอร์จริง ยอดที่ใช้ = max − min
- สูตรฝั่ง JS (simulator) กับ SQL (backfill) ตรงกัน ข้อมูลจาก 11 กับ 10 ต่อกันไม่สะดุด

---

## Example 11: backfill ตาม TTL

mock ย้อนหลัง `YEARS` ปี (default 3) แต่ละช่วงเขียนลงตารางที่เก็บช่วงนั้น ไม่สร้างข้อมูลที่ TTL จะลบอยู่ดี

| ช่วง | เขียนลง | วิธี |
|---|---|---|
| 3 วันล่าสุด | `sensor_raw` | JSON รายวินาที (MV ทำต่อทุกชั้น) |
| 3-7 วัน | `sensor_long` | ค่ารายวินาที |
| 7 วัน - 2 ปี | `sensor_hourly` | aggregate ฝั่ง server |
| 2-3 ปี | `sensor_daily` | aggregate ตรง |

- `COARSE=60` (default): ช่วง hourly/daily สร้างค่าทุก 60 วิ นับแต่ละค่าเป็น 60 จุด
  `samples` ยังถูก, avg แทบเท่าเดิม, min/max แคบลงนิดหน่อย / 17 นาที → ~1 นาที / `COARSE=1` = รายวินาทีจริง
- insert ทีละก้อน: client timeout 30 วิ
- ตรวจ: ทุกวันเต็มวันครบ 86,400 จุด (1,095 วัน)

ผลที่ได้ (10 device):

| ตาราง | แถว | ขนาด |
|---|---|---|
| `sensor_long` | 45 ล้าน | 82.7 MiB |
| `sensor_raw` | 2.6 ล้าน | 62.2 MiB |
| `sensor_hourly` | 1.3 ล้าน | 15.8 MiB |
| `sensor_daily` | 82,650 | 1.0 MiB |

env:

- `DEVICES=100` จำนวน device (10, 11)
- `YEARS=5` ช่วงย้อนหลัง (11)
- `COARSE=1` สร้าง hourly/daily จากค่ารายวินาทีจริง (11)
- PowerShell: `$env:DEVICES=100; bun run examples/10-simulator.ts`

---

## Example 09 + `src/stats.ts`: query service

```ts
getStats({
  sensors: ["th-1", "th-2"],   // ไม่เกิน MAX_SENSORS (100) / ว่าง = ทุก device (ใช้กับ total เท่านั้น)
  metrics: ["temp"],            // ว่าง = ทุก metric
  grain: "day",                 // hour | day (อ่าน hourly) / month | year (อ่าน daily)
  groupBy: "device",            // device = แยกตัว / total = รวมที่เลือกเป็นค่าเดียว
  from: "2026-10-21 00:00:00",  // เวลาไทย
  to: "2026-10-28 00:00:00",    // ไม่รวม
})
// → { meta: { grain, groupBy, source, rows, took_ms, ... }, data: [{ t, sensor?, devices?, metric, n, avg, min, max, sum, diff }] }
```

- `toSeries(data)`: กราฟเส้น 1 series ต่อ (sensor, metric)
- `toWide(data, "avg")`: ตาราง/CSV 1 แถวต่อ t คอลัมน์ = `sensor.metric`
- grain / groupBy เป็น whitelist ค่าอื่นส่งผ่าน `query_params` (กัน injection)
- `has(sensors, sensor)` ยังใช้ primary index ได้ (ตรวจด้วย EXPLAIN)
- ข้อจำกัด: `total` ใช้ avg กับทุก metric ถูกกับ temp/voltage แต่ power_kw ควรเป็นผลรวม energy_kwh ควรเป็นผลรวมของ (max − min)

---

## เรื่องที่ได้เรียนระหว่างทาง

- **part / merge**: insert 1 ครั้ง = 1 part แล้ว background merge รวมเป็นก้อนใหญ่ ต้อง insert เป็น batch ไม่งั้น `Too many parts`
- **partition pruning**: อัตโนมัติ ขอแค่มีเงื่อนไขเวลาใน WHERE (อ่าน 5 จาก 120 part)
- **TTL**: ลบข้อมูลทีละ part ที่หมดอายุทั้งก้อน partition หายเองเมื่อไม่เหลือ part ลบตอน merge ไม่ตรงเวลาเป๊ะ
- **จำนวน partition / part คงที่**: TTL ลบของเก่า merge รวมของใหม่ ไม่บวม
- **query ตาราง aggregate**: `GROUP BY` + `-Merge` เสมอ (`countMerge`, `avgMerge`) / `count()` นับแถวในตาราง ไม่ใช่จำนวนข้อมูล
- **`samples`**: จำนวนค่าที่วัดได้ในช่วงนั้น (3,600/ชม., 86,400/วัน) ใช้ตรวจข้อมูลครบ
- **ReplacingMergeTree**: ใช้กับข้อมูลที่แก้ได้ (ตาราง `devices` ในอนาคต) ไม่ใช้กับ raw เพราะ MV นับไปแล้วตั้งแต่ตอน insert
- **raw เก็บแค่ device_id**: location มาจากตาราง `devices` ถามตาม location = location ปัจจุบัน ถามตาม device ถูกเสมอ
- **daily ไม่มี TTL**: โตช้า (~350 MiB/ปี ที่ 10k device) ตัวที่กิน disk จริงคือ raw กับ long

## ดูสถานะ (query ใน `docs/queries.sql`)

- disk ต่อตาราง / ต่อคอลัมน์ / ทั้งเครื่อง: `system.parts`, `system.columns`, `system.disks`
- part ใน partition และเวลาที่ TTL จะลบ: `system.parts` (`delete_ttl_info_max`)
- เวลา + `read_rows` ของ query: `system.query_log` (ต้อง `SYSTEM FLUSH LOGS` ก่อน)
- ปกติไม่ต้องดู เปิดเฉพาะตอนมีปัญหา: `Too many parts`, disk โตไม่หยุด, query ช้า

## ขั้นต่อไป

ดู README หัวข้อ "ขั้นต่อไป": ตาราง `devices` + location, รวมข้าม device ตามชนิด metric, ข้อมูลไม่สมบูรณ์, benchmark 10k device / PG
