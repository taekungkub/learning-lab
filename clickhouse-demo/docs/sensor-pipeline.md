# Sensor pipeline (examples 08-11, 13-14)

สรุปชุด sensor: schema (08), mock ย้อนหลัง (11), simulator (10), query service (09), API แบบ body (13, 14) และ config ที่ใช้ร่วมกัน

## ภาพรวม

```
device ──INSERT──► sensor_raw ──MV──► sensor_long ──MV──► sensor_hourly ──MV──► sensor_daily
                   (JSON)              (1 แถว/ค่า)    │     (สรุปรายชั่วโมง)       (สรุปรายวัน ไทย)
                   TTL 3 วัน            TTL 3 วัน     │      TTL 2 ปี               ไม่มี TTL
                                                      └──MV──► sensor_1m (สรุปรายนาที TTL 3 วัน)
```

`sensor_1m` แยกกิ่งจาก `sensor_long` ไม่ได้ป้อน hourly จึงมี TTL สั้นกว่า long ได้

แอป/ตัวกลาง insert เข้า `sensor_raw` ตารางเดียว ที่เหลือ ClickHouse คำนวณต่อเองใน INSERT เดียวกัน

ลำดับรัน:

```bash
bun run examples/08-multi-metric.ts   # สร้าง schema (DROP sensor_* ทั้งหมด!)
bun run examples/11-backfill.ts       # mock ย้อนหลัง (~1 นาที)
bun run examples/10-simulator.ts      # ข้อมูลใหม่ต่อเนื่อง ถ้าต้องการ (Ctrl+C หยุด)
bun run examples/09-query-service.ts  # getStats() อ่านอย่างเดียว
bun run examples/13-api-body.ts       # body แบบ API เก่า → กราฟ (อ่านอย่างเดียว)
bun run examples/14-aggregate.ts      # aggregate ทั้งช่วง + compare (อ่านอย่างเดียว)
```

Query สำหรับ TablePlus: `docs/queries.sql` (ข้อมูล) / `docs/monitoring.sql` (ตรวจ disk, partition, TTL, query_log)

---

## `src/config.ts`: TTL ที่เดียว

```ts
raw:    { days: 3 }    // payload JSON เดิม ไว้ debug
long:   { days: 3 }    // ค่ารายวินาที
m1:     { days: 3 }    // สรุปรายนาที (interval 1m, 15m)
hourly: { years: 2 }   // กราฟรายชั่วโมง
// daily ไม่มี TTL
```

- 08 ใช้ตั้ง TTL ตอนสร้างตาราง, 11 ใช้กำหนดว่าจะ mock ช่วงไหนลงตารางไหน
- TTL ต้องยาวขึ้นตามชั้น: สรุปถูกเขียนไว้ตั้งแต่ตอน insert ลบชั้นล่างแล้วชั้นบนยังอยู่
- long ลดจาก 30 เหลือ 7 แล้วเหลือ 3 วัน: ที่ 10k device ส่งทุกวินาที long ~12 GiB/วัน (30 วัน ~350 GiB, 7 วัน ~85 GiB, 3 วัน ~36 GiB) ตอนนี้ช่วงเท่า raw
- แก้ค่าแล้ว: demo รัน 08 ใหม่ / ระบบจริง `ALTER TABLE ... MODIFY TTL` (ข้อมูลไม่หาย)

---

## Example 08: schema + MV

| ตาราง | engine | PARTITION BY | ORDER BY | หมายเหตุ |
|---|---|---|---|---|
| `sensor_raw` | MergeTree | รายวัน | `(sensor, ts)` | `data JSON` แยก key เป็น subcolumn ให้เอง |
| `sensor_long` | MergeTree | รายวัน | `(sensor, metric, ts)` | 1 แถวต่อ 1 ค่า รับ metric ใหม่โดยไม่ต้อง ALTER |
| `sensor_1m` | AggregatingMergeTree | รายวัน | `(sensor, metric, ts)` | สรุปรายนาทีจาก long เก็บสั้น (TTL 3 วัน) |
| `sensor_hourly` | AggregatingMergeTree | รายเดือน | `(sensor, metric, ts)` | เก็บ state: `samples`, `avg_v` เป็น binary |
| `sensor_daily` | AggregatingMergeTree | ไม่แบ่ง | `(sensor, metric, ts)` | วันตัดตาม UTC ตั้งแต่ตอนเขียน (ts = 00:00Z ของวัน) |

คอลัมน์เวลาชื่อ `ts` (`DateTime` UTC) เหมือนกันทุกตาราง: 1m = ต้นนาที, hourly = ต้นชั่วโมง, daily = 00:00Z ของวัน
ใน MV ที่ปัดเวลาเป็น `AS ts` ซ้อนชื่อกับ column ต้นทาง ต้องเขียน `argMaxState(value, sensor_long.ts)` ไม่งั้น `last_v` ใช้เวลาที่ปัดแล้วผิดแบบเงียบๆ
`DateTime` ของ ClickHouse เก็บ epoch ไม่มี timezone ติดค่า ตอนแสดงเป็น `2026-10-22 07:07:44` (UTC) ส่วน API ส่งเป็น ISO `…Z`

ตารางสรุปทุกตัว (1m, hourly, daily) มี `last_v` = `argMaxState(value, ts)` = ค่าล่าสุดของ bucket ใช้กับ aggregation `last` และ `diff`

MV แต่ละชั้น:

1. `sensor_long_mv`: แตก JSON เป็นแถว `ARRAY JOIN JSONExtractKeysAndValues(...)` key ที่ไม่ใช่ตัวเลข (`status`) ตัดทิ้ง
2. `sensor_1m_mv` / `sensor_hourly_mv`: อ่านจาก long, `toStartOfMinute` / `toStartOfHour` + `countState` / `avgState` / `min` / `max` / `argMaxState`
3. `sensor_daily_mv`: อ่าน hourly ที่เป็น state อยู่แล้ว ต้องใช้ `-MergeState`

View สำหรับ TablePlus: `sensor_1m_v` / `sensor_hourly_v` / `sensor_daily_v` ครอบ `-Merge` ไว้ เปิดแล้วอ่านออก

ตั้งค่าเพิ่ม:

- `ttl_only_drop_parts = 1`: TTL ลบ part ทั้งก้อน ไม่ตัดทีละแถว
- Codec: `ts` = `Delta, ZSTD(1)`, `value` = `ZSTD(1)` → long เล็กลง 3.7 เท่า (`ts` 662 MiB → 834 KiB)

08 ตรวจอะไร:

- กับดัก JSON: แปลงด้วย `::Nullable(Float64)` / `::Float64` เปลี่ยนค่าที่ไม่มีเป็น 0 / `.:Float64` ข้ามค่า Int64 เงียบๆ
- hourly และ daily ตรงกับคำนวณจาก raw
- daily แยกวัน UTC ถูก (ทดสอบข้อมูลคร่อมเที่ยงคืน UTC)

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
| 3 วัน - 2 ปี | `sensor_hourly` | aggregate ฝั่ง server |
| 2-3 ปี | `sensor_daily` | aggregate ตรง |

- `COARSE=60` (default): ช่วง hourly/daily สร้างค่าทุก 60 วิ นับแต่ละค่าเป็น 60 จุด
  `samples` ยังถูก, avg แทบเท่าเดิม, min/max แคบลงนิดหน่อย / 17 นาที → ~1 นาที / `COARSE=1` = รายวินาทีจริง
- insert ทีละก้อน: client timeout 30 วิ
- `sensor_1m` ไม่ต้อง backfill แยก: MV จาก long เขียนให้ตอนใส่ช่วง long + raw (ส่วนที่เกิน 3 วันถูกลบตอน merge ไม่ทันที)
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
  grain: "day",                 // hour | day (อ่าน hourly) / month | year (อ่าน daily) ตัดตาม UTC
  groupBy: "device",            // device = แยกตัว / total = รวมที่เลือกเป็นค่าเดียว
  from: "2026-10-21T00:00:00Z", // UTC (รับ 'YYYY-MM-DD HH:MM:SS' ด้วย ตีเป็น UTC)
  to: "2026-10-28T00:00:00Z",   // ไม่รวม
})
// → { meta: { grain, groupBy, source, rows, took_ms, tz: "UTC", ... }, data: [{ t, sensor?, devices?, metric, n, avg, min, max, sum, diff }] }
// t เป็น ISO UTC ทุก grain: "2026-10-21T00:00:00Z" (day = 00:00Z, month = วันที่ 1, year = 1 ม.ค.)
```

- `toSeries(data)`: กราฟเส้น 1 series ต่อ (sensor, metric)
- `toWide(data, "avg")`: ตาราง/CSV 1 แถวต่อ t คอลัมน์ = `sensor.metric`
- grain / groupBy เป็น whitelist ค่าอื่นส่งผ่าน `query_params` (กัน injection)
- `has(sensors, sensor)` ยังใช้ primary index ได้ (ตรวจด้วย EXPLAIN)
- ข้อจำกัด: `total` ใช้ avg กับทุก metric ถูกกับ temp/voltage แต่ power_kw ควรเป็นผลรวม energy_kwh ควรเป็นผลรวมของ (max − min)

---

## Example 13: body แบบ API เก่า → กราฟ

รับ body เดียวกับระบบเก่า แก้ที่ `examples/13-body.json` ไม่ต้องแตะโค้ด (`13-api-body.ts` ใช้ `src/api-utils.ts` ร่วมกับ 14)

```json
{ "time_range": { "from": "…Z", "to": "…Z" },
  "filters": { "device_ids": ["pm-1"] },
  "series": [{ "name": "n", "metric_keys": ["energy_kwh"], "aggregation": "diff", "interval": "24h", "group_by": ["device_id", "metric_key"] }] }
```

- aggregation: `mean | avg | sum | count | min | max | last | diff` / interval: `1m 15m 1h 6h 12h 24h 7d`
- เลือกตารางตาม interval: `1m`, `15m` → `sensor_1m` (ย้อนหลังไม่เกิน 3 วัน) / `1h`-`7d` → `sensor_hourly` (ไม่เกิน 2 ปี)
- bucket ตัดตาม UTC: `24h` = วัน UTC (เริ่ม 07:00 ไทย), `7d` = จันทร์-อาทิตย์ UTC
- `diff` = last ของ bucket − last ของ bucket ก่อน ใช้กับ counter (`energy_kwh`) ต้อง group_by ทั้ง `device_id` และ `metric_key` / bucket แรกเป็น `null` (ไม่มีก่อนหน้าให้ลบ)
- จำกัดจุดต่อเส้นด้วย `MAX_POINTS` (default 20000) เกินแล้ว error บอกให้ใช้ interval หยาบขึ้น
- query ทุกตัวส่งค่าผ่าน `query_params` / ชื่อตาราง, bucket, aggregation มาจาก whitelist
- ชื่อ device/metric เป็นของ mock (`pm-*`, `th-*`, `power_kw`, ...) ระบบจริงใช้ UUID กับ `active_power` ต้องแมปก่อน

response (เขียนเต็มที่ `examples/13-response.json`, ถูก gitignore):

```ts
{ took_ms, meta: [{ name, aggregation, interval, source, points_per_series, lines, rows }],
  series: [{ name, group: { device_id, metric_key }, points: [["2025-07-22T00:00:00Z", 10.5], ...] }] }
```

- 1 object = 1 เส้นกราฟ (`group` ใส่ครั้งเดียว) / `lines` = จำนวนเส้น (เฉพาะคู่ device × metric ที่มีข้อมูลจริง)
- `SUITE=1` รัน 6 case ทุก interval + 4 case ที่ต้อง error แล้วพิมพ์บรรทัด `check:` ต้องเป็น `true` ทุกค่า

## Example 14: aggregate ทั้งช่วง + compare

1 ค่าต่อ (device, metric) ตลอด `time_range` + เทียบกับอีกช่วงได้ `delta` แก้ที่ `examples/14-body.json`

- แต่ละ metric เลือก aggregation ของตัวเอง (`mean`, `max`, `diff`, ...) `diff` เหมาะกับ counter เท่านั้น
- `compare.mode`: `previous_period` (ช่วงยาวเท่ากันก่อนหน้า) / `previous_year` / `custom` (+ `custom_time_range`)
- `delta` ต่อ metric = `{ absolute, percent }` ข้าม metric ที่ค่า compare เป็น 0 (หาร percent ไม่ได้)
- อ่านจาก `sensor_hourly` ถ้าช่วงยังอยู่ใน TTL 2 ปี เกินนั้นอ่านจาก `sensor_daily` ซึ่งตัดวัน UTC ขอบช่วงที่ไม่ตรง 00:00Z จึงปัดลงเป็นต้นวัน UTC
- ยังไม่ทำ: `compare.interval`, `group_by` อื่นนอกจาก `["device_id"]`
- response: `{ took_ms, meta, results: [{ group: { device_id }, result: { current, compare, delta } }] }`

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

## ดูสถานะ (query ใน `docs/monitoring.sql`)

- disk ต่อตาราง / ต่อคอลัมน์ / ทั้งเครื่อง: `system.parts`, `system.columns`, `system.disks`
- part ใน partition และเวลาที่ TTL จะลบ: `system.parts` (`delete_ttl_info_max`)
- เวลา + `read_rows` ของ query: `system.query_log` (ต้อง `SYSTEM FLUSH LOGS` ก่อน)
- ปกติไม่ต้องดู เปิดเฉพาะตอนมีปัญหา: `Too many parts`, disk โตไม่หยุด, query ช้า

## ขั้นต่อไป

ดู README หัวข้อ "ขั้นต่อไป": ตาราง `devices` + location, รวมข้าม device ตามชนิด metric, ข้อมูลไม่สมบูรณ์, benchmark 10k device / PG
