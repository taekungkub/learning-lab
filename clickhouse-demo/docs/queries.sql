-- Query ข้อมูลสำหรับ copy ไปรันใน TablePlus (database: demo) / ตรวจ disk, partition, TTL, query_log อยู่ที่ monitoring.sql
-- ต้องรัน examples/08 แล้ว 11-backfill ก่อน (mock 3 ปี รายวินาที 10 device, metric ที่ src/mock.ts)
-- ช่วงเวลาอิง now() ไม่ต้องแก้วันที่
-- device: th-1..5, pm-1..5
-- metric th: temp, humidity, dew_point, battery_v, rssi
-- metric pm: voltage_l1..l3, current_l1..l3, power_kw, power_factor, frequency, energy_kwh (counter สะสม)
-- เวลาทุกอย่างเป็น UTC (column เวลาชื่อ ts ทุกตาราง) / bucket วันตัดที่ 00:00Z = 07:00 เวลาไทย
-- hour/day อ่าน sensor_hourly (TTL 2 ปี), month/year อ่าน sensor_daily (เก็บตลอด) เหมือน getStats()
--
-- 2 รูปแบบ:
--   long : 1 แถวต่อ metric ต่อเวลา (metric IN (...) เลือกกี่ตัวก็ได้ / ลบเงื่อนไข metric = ทุกตัว)
--   wide : 1 แถวต่อเวลา metric เป็นคอลัมน์ (dashboard/ตาราง ใช้แบบนี้) ใช้ avgMergeIf ทีละคอลัมน์


-- ===========================================================================
-- รายชั่วโมง / วัน / เดือน / ปี (long: หลาย metric)
-- ===========================================================================

-- 1. รายชั่วโมง เมื่อวาน (มิเตอร์ไฟ ทุก metric)
SELECT ts AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'pm-1'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 1 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY metric, t;


-- 1b. รายชั่วโมง วันนี้ ถึงชั่วโมงปัจจุบัน (เลือก metric)
SELECT ts AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE sensor = 'pm-1'
  AND metric IN ('voltage_l1', 'voltage_l2', 'voltage_l3', 'current_l1', 'current_l2', 'current_l3', 'power_kw')
  AND ts >= toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY metric, t;


-- 2. รายวัน 30 วันล่าสุด (เครื่องวัดอุณหภูมิ ทุก metric)
SELECT toStartOfDay(ts, 'UTC') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE sensor = 'th-1'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 30 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY metric, t;

-- 2.1 รายวัน 30 วันล่าสุด (เครื่องวัดอุณหภูมิ หลายตัว หลาย metric)
SELECT toStartOfDay(ts, 'UTC') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE sensor IN ('th-1', 'th-2', 'th-3') AND metric IN ('temp', 'humidity')
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 30 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY sensor, metric, t;


-- 3. รายเดือน 12 เดือนล่าสุด + เดือนนี้ (จาก daily)
SELECT toStartOfMonth(ts) AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_daily
WHERE sensor = 'pm-1'
  AND metric IN ('voltage_l1', 'current_l1', 'power_kw', 'power_factor', 'frequency')
  AND ts >= toStartOfMonth(today()) - INTERVAL 12 MONTH
GROUP BY t, sensor, metric
ORDER BY metric, t;


-- 4. รายปี ทั้งหมด (จาก daily: เห็นเกิน 2 ปีที่ hourly เก็บ)
SELECT toYear(ts) AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_daily
WHERE sensor = 'th-1'
GROUP BY t, sensor, metric
ORDER BY metric, t;


-- ===========================================================================
-- รายชั่วโมง / วัน / เดือน / ปี (wide: metric เป็นคอลัมน์)
-- ===========================================================================

-- W1. มิเตอร์ไฟ รายชั่วโมงเมื่อวาน ทุก metric
SELECT ts AS t,
       round(avgMergeIf(avg_v, metric = 'voltage_l1'), 1)   AS v_l1,
       round(avgMergeIf(avg_v, metric = 'voltage_l2'), 1)   AS v_l2,
       round(avgMergeIf(avg_v, metric = 'voltage_l3'), 1)   AS v_l3,
       round(avgMergeIf(avg_v, metric = 'current_l1'), 2)   AS a_l1,
       round(avgMergeIf(avg_v, metric = 'current_l2'), 2)   AS a_l2,
       round(avgMergeIf(avg_v, metric = 'current_l3'), 2)   AS a_l3,
       round(avgMergeIf(avg_v, metric = 'power_kw'), 2)     AS kw_avg,
       maxIf(max_v, metric = 'power_kw')                    AS kw_peak,
       round(avgMergeIf(avg_v, metric = 'power_factor'), 3) AS pf,
       round(avgMergeIf(avg_v, metric = 'frequency'), 3)    AS hz,
       round(maxIf(max_v, metric = 'energy_kwh') - minIf(min_v, metric = 'energy_kwh'), 2) AS kwh_used
FROM sensor_hourly
WHERE sensor = 'pm-1'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 1 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t
ORDER BY t;


-- W2. เครื่องวัดอุณหภูมิ รายวัน 30 วันล่าสุด ทุก metric
SELECT toStartOfDay(ts, 'UTC') AS t,
       round(avgMergeIf(avg_v, metric = 'temp'), 2)       AS temp_avg,
       minIf(min_v, metric = 'temp')                      AS temp_min,
       maxIf(max_v, metric = 'temp')                      AS temp_max,
       round(avgMergeIf(avg_v, metric = 'humidity'), 1)   AS hum_avg,
       round(avgMergeIf(avg_v, metric = 'dew_point'), 1)  AS dew_avg,
       minIf(min_v, metric = 'battery_v')                 AS battery_min,
       round(avgMergeIf(avg_v, metric = 'rssi'), 1)       AS rssi_avg
FROM sensor_hourly
WHERE sensor = 'th-1'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 30 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t
ORDER BY t;


-- W3. มิเตอร์ไฟ รายเดือน (จาก daily) ยอดใช้ไฟ + ค่าเฉลี่ยหลัก
SELECT toStartOfMonth(ts) AS t,
       round(maxIf(max_v, metric = 'energy_kwh') - minIf(min_v, metric = 'energy_kwh'), 1) AS kwh_used,
       round(avgMergeIf(avg_v, metric = 'power_kw'), 2)     AS kw_avg,
       maxIf(max_v, metric = 'power_kw')                    AS kw_peak,
       round(avgMergeIf(avg_v, metric = 'power_factor'), 3) AS pf,
       minIf(min_v, metric = 'voltage_l1')                  AS v_l1_min,
       maxIf(max_v, metric = 'voltage_l1')                  AS v_l1_max
FROM sensor_daily
WHERE sensor = 'pm-1'
GROUP BY t
ORDER BY t;


-- W4. เครื่องวัดอุณหภูมิ รายปี (จาก daily)
SELECT toYear(ts) AS t,
       round(avgMergeIf(avg_v, metric = 'temp'), 2)     AS temp_avg,
       minIf(min_v, metric = 'temp')                    AS temp_min,
       maxIf(max_v, metric = 'temp')                    AS temp_max,
       round(avgMergeIf(avg_v, metric = 'humidity'), 1) AS hum_avg,
       countMergeIf(samples, metric = 'temp')           AS samples
FROM sensor_daily
WHERE sensor = 'th-1'
GROUP BY t
ORDER BY t;


-- 5. รายวัน รวมทุก device (total, 7 วันล่าสุด)
-- avg ถ่วงน้ำหนักตาม samples, devices = จำนวน device ที่ส่งข้อมูล
SELECT toStartOfDay(ts, 'UTC') AS t, metric, uniqExact(sensor) AS devices,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE ts >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, metric
ORDER BY metric, t;


-- 6. รายวันจาก raw (ผลแบบเดียวกับข้อ 2 ไว้เทียบความเร็ว)
-- ได้แค่ช่วง TTL ของ sensor_long (src/config.ts) วันเก่าสุดอาจไม่ครบ ข้อ 2 อ่าน hourly ยังครบ
SELECT toStartOfDay(ts, 'UTC') AS t, sensor, metric,
       count() AS n, round(avg(value), 2) AS avg, min(value) AS min, max(value) AS max
FROM sensor_long
WHERE sensor = 'th-1' AND metric = 'temp'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY t;


-- ===========================================================================
-- Query Raw (sensor_long: ค่าดิบทีละจุด เก็บตาม TTL.long ใน src/config.ts)
-- latest = เวลาของข้อมูลล่าสุด ใช้แทน now() เพราะ demo ไม่มีข้อมูลเข้าต่อเนื่อง
-- ระบบจริงเปลี่ยน latest เป็น now()
-- ===========================================================================

-- 7. ค่าดิบ 1 ชั่วโมงล่าสุดของ meter เดียว (ใส่ LIMIT เสมอ raw ใหญ่มาก)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT ts AS t, sensor, metric, value
FROM sensor_long
WHERE sensor = 'th-1' AND metric = 'temp'
  AND ts >= latest - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 1000;


-- 8. ค่าล่าสุดของทุก meter (หน้า overview / ดูว่าตัวไหนเงียบไป)
SELECT sensor, metric,
       argMax(value, ts)                       AS last_value,
       max(ts)     AS last_seen,
       dateDiff('minute', max(ts), now())      AS minutes_ago
FROM sensor_long
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY sensor, metric
ORDER BY sensor, metric;


-- 9. payload JSON เดิมที่ device ส่งมา (sensor_raw เก็บ 3 วัน)
SELECT ts AS t, sensor, toJSONString(data) AS payload
FROM sensor_raw
WHERE sensor = 'th-1'
ORDER BY ts DESC
LIMIT 100;


-- ===========================================================================
-- Query หลาย Meter
-- ===========================================================================

-- 10. ค่าดิบหลาย meter วางเทียบเป็นคอลัมน์ (กราฟหลายเส้น)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT ts AS t,
       anyIf(value, sensor = 'pm-1') AS pm_1,
       anyIf(value, sensor = 'pm-2') AS pm_2,
       anyIf(value, sensor = 'pm-3') AS pm_3,
       anyIf(value, sensor = 'pm-4') AS pm_4,
       anyIf(value, sensor = 'pm-5') AS pm_5
FROM sensor_long
WHERE sensor LIKE 'pm-%' AND metric = 'power_kw'
  AND ts >= latest - INTERVAL 10 MINUTE
GROUP BY ts
ORDER BY ts;


-- 11. รายวันหลาย meter หลาย metric (1 แถวต่อ meter ต่อ metric ต่อวัน)
SELECT toStartOfDay(ts, 'UTC') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE sensor LIKE 'th-%' AND metric IN ('temp', 'humidity', 'battery_v')
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor, metric
ORDER BY sensor, metric, t;


-- 12. สรุปเมื่อวานของมิเตอร์ไฟทุกตัว (1 แถวต่อ meter หลาย metric เป็นคอลัมน์)
SELECT sensor,
       round(maxIf(max_v, metric = 'energy_kwh') - minIf(min_v, metric = 'energy_kwh'), 1) AS kwh_used,
       round(avgMergeIf(avg_v, metric = 'power_kw'), 2)     AS kw_avg,
       maxIf(max_v, metric = 'power_kw')                    AS kw_peak,
       round(avgMergeIf(avg_v, metric = 'power_factor'), 3) AS pf,
       minIf(min_v, metric = 'voltage_l1')                  AS v_l1_min,
       maxIf(max_v, metric = 'voltage_l1')                  AS v_l1_max,
       round(avgMergeIf(avg_v, metric = 'current_l1') + avgMergeIf(avg_v, metric = 'current_l2')
             + avgMergeIf(avg_v, metric = 'current_l3'), 1) AS a_total
FROM sensor_hourly
WHERE sensor LIKE 'pm-%'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 1 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY sensor
ORDER BY sensor;


-- 13. Top 10 meter ที่ใช้ไฟมากสุดเมื่อวาน
SELECT sensor, round(max(max_v) - min(min_v), 1) AS kwh_used
FROM sensor_hourly
WHERE metric = 'energy_kwh'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 1 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY sensor
ORDER BY kwh_used DESC
LIMIT 10;


-- ===========================================================================
-- Aggregation เพิ่มเติม
-- ===========================================================================

-- 14. bucket ราย 15 นาทีจาก raw + p95 / stddev หลาย metric (agg ที่ไม่ได้เก็บใน hourly ต้องคำนวณจาก raw)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT toStartOfInterval(ts, INTERVAL 15 MINUTE, 'UTC') AS t, metric,
       count() AS n, round(avg(value), 2) AS avg, min(value) AS min, max(value) AS max,
       round(quantile(0.95)(value), 2) AS p95,
       round(stddevPop(value), 2)      AS stddev
FROM sensor_long
WHERE sensor = 'pm-1' AND metric IN ('power_kw', 'current_l1', 'voltage_l1')
  AND ts >= latest - INTERVAL 6 HOUR
GROUP BY t, metric
ORDER BY metric, t;


-- 15. diff จากวันก่อน + moving average 7 วัน (window function)
SELECT t, avg,
       if(row_number() OVER w = 1, NULL, round(avg - lagInFrame(avg) OVER w, 2)) AS diff_prev,
       round(avg(avg) OVER (ORDER BY t ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS ma7
FROM (
  SELECT toStartOfDay(ts, 'UTC') AS t, round(avgMerge(avg_v), 2) AS avg
  FROM sensor_hourly
  WHERE sensor = 'th-1' AND metric = 'temp'
    AND ts >= toStartOfDay(now('UTC')) - INTERVAL 30 DAY
    AND ts <  toStartOfDay(now('UTC'))
  GROUP BY t
)
WINDOW w AS (ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
ORDER BY t;


-- 16. ความครบของข้อมูลรายวัน (data completeness)
-- 86400 = จุดต่อวันเมื่อส่งทุก 1 วิ (เปลี่ยนตามความถี่จริง) / วันนี้ยังไม่จบ จะไม่ครบเสมอ
SELECT toStartOfDay(ts, 'UTC') AS t, sensor,
       countMerge(samples)         AS n,
       round(n / 86400 * 100, 1)   AS completeness_pct
FROM sensor_hourly
WHERE metric = 'temp'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY
GROUP BY t, sensor
HAVING n < 86400
ORDER BY t, sensor;


-- 17. ยอดใช้ไฟรายวันจาก counter (energy_kwh สะสม: ยอดใช้ = max - min ในช่วงนั้น)
SELECT toStartOfDay(ts, 'UTC') AS t, sensor,
       round(max(max_v) - min(min_v), 2) AS kwh_used
FROM sensor_hourly
WHERE metric = 'energy_kwh'
  AND ts >= toStartOfDay(now('UTC')) - INTERVAL 7 DAY
  AND ts <  toStartOfDay(now('UTC'))
GROUP BY t, sensor
ORDER BY sensor, t;


-- 18. หลาย metric ของ device เดียว pivot เป็นคอลัมน์ (รายชั่วโมงวันนี้)
SELECT ts AS t,
       round(avgMergeIf(avg_v, metric = 'voltage_l1'), 1)   AS v_l1,
       round(avgMergeIf(avg_v, metric = 'voltage_l2'), 1)   AS v_l2,
       round(avgMergeIf(avg_v, metric = 'voltage_l3'), 1)   AS v_l3,
       round(avgMergeIf(avg_v, metric = 'current_l1'), 1)   AS a_l1,
       round(avgMergeIf(avg_v, metric = 'power_kw'), 2)     AS kw,
       round(avgMergeIf(avg_v, metric = 'power_factor'), 2) AS pf
FROM sensor_hourly
WHERE sensor = 'pm-1'
  AND ts >= toStartOfDay(now('UTC'))
GROUP BY t
ORDER BY t;


-- ===========================================================================
-- ระดับ 1 นาที / 5 นาที (sensor_1m เก็บ TTL.m1 ใน src/config.ts) ไว้ทดสอบความเร็ว
-- latest = เวลาข้อมูลล่าสุด ใช้แทน now() เพราะ demo ไม่มีข้อมูลเข้าต่อเนื่อง (ระบบจริงเปลี่ยนเป็น now())
-- 5 นาทีรวมจาก sensor_1m (state รวมกันได้: avgMerge / countMerge / min / max)
-- ===========================================================================

-- 19. 1 นาที หลาย device หลาย metric (มิเตอร์ไฟ 5 ตัว × 4 metric × 3 ชม. = 3,600 แถว)
WITH (SELECT max(ts) FROM sensor_1m) AS latest
SELECT ts AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_1m
WHERE sensor IN ('pm-1', 'pm-2', 'pm-3', 'pm-4', 'pm-5')
  AND metric IN ('power_kw', 'voltage_l1', 'current_l1', 'energy_kwh')
  AND ts > latest - INTERVAL 3 HOUR
GROUP BY t, sensor, metric
ORDER BY sensor, metric, t;


-- 20. 5 นาที หลาย device หลาย metric (5 ตัว × 4 metric × 24 ชม. = 5,760 แถว)
WITH (SELECT max(ts) FROM sensor_1m) AS latest
SELECT toStartOfFiveMinutes(ts) AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       argMaxMerge(last_v) AS last
FROM sensor_1m
WHERE sensor IN ('pm-1', 'pm-2', 'pm-3', 'pm-4', 'pm-5')
  AND metric IN ('power_kw', 'voltage_l1', 'current_l1', 'energy_kwh')
  AND ts > latest - INTERVAL 24 HOUR
GROUP BY t, sensor, metric
ORDER BY sensor, metric, t;


-- 21. 5 นาที ทุก device ทุก metric 24 ชม. (หนักสุด: ~75 series × 288 = ~21,600 แถว)
WITH (SELECT max(ts) FROM sensor_1m) AS latest
SELECT toStartOfFiveMinutes(ts) AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_1m
WHERE ts > latest - INTERVAL 24 HOUR
GROUP BY t, sensor, metric
ORDER BY sensor, metric, t;


-- 22. 1 นาที wide: มิเตอร์ไฟ 1 ตัว metric เป็นคอลัมน์ 3 ชม. (กราฟหลายเส้นแกนเดียว)
WITH (SELECT max(ts) FROM sensor_1m) AS latest
SELECT ts AS t,
       round(avgMergeIf(avg_v, metric = 'voltage_l1'), 1) AS v_l1,
       round(avgMergeIf(avg_v, metric = 'current_l1'), 2) AS a_l1,
       round(avgMergeIf(avg_v, metric = 'power_kw'), 2)   AS kw,
       maxIf(max_v, metric = 'power_kw')                  AS kw_peak,
       round(avgMergeIf(avg_v, metric = 'power_factor'), 3) AS pf
FROM sensor_1m
WHERE sensor = 'pm-1' AND ts > latest - INTERVAL 3 HOUR
GROUP BY t
ORDER BY t;
