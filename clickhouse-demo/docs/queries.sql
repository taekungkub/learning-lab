-- Query สำหรับ copy ไปรันใน TablePlus (database: demo)
-- ต้องรัน examples/09-query-service.ts ก่อน (ใส่ข้อมูล ~400 วัน)
-- ช่วงเวลาอิง now() ไม่ต้องแก้วันที่ / เปลี่ยน sensor เป็น 'th-2', 'pm-1' (metric: voltage, current) ได้
-- ลบ AND metric = 'temp' = ทุก metric


-- 1. รายชั่วโมง (เมื่อวาน)
SELECT toTimeZone(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'th-1' AND metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 1 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, sensor, metric
ORDER BY t;


-- 1b. รายชั่วโมง (วันนี้ ถึงชั่วโมงปัจจุบัน)
SELECT toTimeZone(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'th-1' AND metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, sensor, metric
ORDER BY t;


-- 2. รายวัน (30 วันล่าสุด)
SELECT toDate(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'th-1' AND metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 30 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, sensor, metric
ORDER BY t;


-- 3. รายเดือน (12 เดือนล่าสุด + เดือนนี้)
SELECT toStartOfMonth(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'th-1' AND metric = 'temp'
  AND hour >= toStartOfMonth(now('Asia/Bangkok')) - INTERVAL 12 MONTH
GROUP BY t, sensor, metric
ORDER BY t;


-- 4. รายปี (ทั้งหมด)
SELECT toYear(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max,
       round(avgMerge(avg_v) * countMerge(samples), 2) AS sum
FROM sensor_hourly
WHERE sensor = 'th-1' AND metric = 'temp'
GROUP BY t, sensor, metric
ORDER BY t;


-- 5. รายวัน รวมทั้ง fleet (7 วันล่าสุด)
-- avg ถ่วงน้ำหนักตาม samples, devices = จำนวน device ที่ส่งข้อมูล
SELECT toDate(hour, 'Asia/Bangkok') AS t, metric, uniqExact(sensor) AS devices,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 7 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, metric
ORDER BY metric, t;


-- 6. รายวันจาก raw (ผลแบบเดียวกับข้อ 2 ไว้เทียบความเร็ว)
-- วันเก่าสุดอาจไม่ครบ: TTL 30 วันของ sensor_long ลบไปแล้วบางส่วน (ข้อ 2 อ่าน hourly ยังครบ)
SELECT toDate(ts, 'Asia/Bangkok') AS t, sensor, metric,
       count() AS n, round(avg(value), 2) AS avg, min(value) AS min, max(value) AS max
FROM sensor_long
WHERE sensor = 'th-1' AND metric = 'temp'
  AND ts >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 30 DAY
  AND ts <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, sensor, metric
ORDER BY t;


-- ===========================================================================
-- Query Raw (sensor_long: ค่าดิบทีละจุด เก็บแค่ 30 วัน)
-- latest = เวลาของข้อมูลล่าสุด ใช้แทน now() เพราะ demo ไม่มีข้อมูลเข้าต่อเนื่อง
-- ระบบจริงเปลี่ยน latest เป็น now()
-- ===========================================================================

-- 7. ค่าดิบ 1 ชั่วโมงล่าสุดของ meter เดียว (ใส่ LIMIT เสมอ raw ใหญ่มาก)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT toTimeZone(ts, 'Asia/Bangkok') AS t, sensor, metric, value
FROM sensor_long
WHERE sensor = 'th-1' AND metric = 'temp'
  AND ts >= latest - INTERVAL 1 HOUR
ORDER BY ts DESC
LIMIT 1000;


-- 8. ค่าล่าสุดของทุก meter (หน้า overview / ดูว่าตัวไหนเงียบไป)
SELECT sensor, metric,
       argMax(value, ts)                       AS last_value,
       toTimeZone(max(ts), 'Asia/Bangkok')     AS last_seen,
       dateDiff('minute', max(ts), now())      AS minutes_ago
FROM sensor_long
WHERE ts >= now() - INTERVAL 1 DAY
GROUP BY sensor, metric
ORDER BY sensor, metric;


-- 9. payload JSON เดิมที่ device ส่งมา (sensor_raw เก็บ 7 วัน)
-- หลังรัน example 09 ตารางนี้ว่าง (09 insert เข้า sensor_long ตรง) ต้องรัน 08 ถึงจะมีข้อมูล
SELECT toTimeZone(ts, 'Asia/Bangkok') AS t, sensor, toJSONString(data) AS payload
FROM sensor_raw
WHERE sensor = 'th-1'
ORDER BY ts DESC
LIMIT 100;


-- ===========================================================================
-- Query หลาย Meter
-- ===========================================================================

-- 10. ค่าดิบหลาย meter วางเทียบเป็นคอลัมน์ (กราฟหลายเส้น)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT toTimeZone(ts, 'Asia/Bangkok') AS t,
       anyIf(value, sensor = 'th-1') AS th_1,
       anyIf(value, sensor = 'th-2') AS th_2
FROM sensor_long
WHERE sensor IN ('th-1', 'th-2') AND metric = 'temp'
  AND ts >= latest - INTERVAL 1 HOUR
GROUP BY ts
ORDER BY ts;


-- 11. รายวันหลาย meter (1 แถวต่อ meter ต่อวัน)
SELECT toDate(hour, 'Asia/Bangkok') AS t, sensor, metric,
       countMerge(samples) AS n, round(avgMerge(avg_v), 2) AS avg, min(min_v) AS min, max(max_v) AS max
FROM sensor_hourly
WHERE sensor IN ('th-1', 'th-2') AND metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 7 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t, sensor, metric
ORDER BY t, sensor;


-- 12. รายวันหลาย meter แบบ pivot + ส่วนต่าง (avgMergeIf = avgMerge เฉพาะแถวที่ตรงเงื่อนไข)
SELECT toDate(hour, 'Asia/Bangkok') AS t,
       round(avgMergeIf(avg_v, sensor = 'th-1'), 2) AS th_1,
       round(avgMergeIf(avg_v, sensor = 'th-2'), 2) AS th_2,
       round(th_2 - th_1, 2)                        AS diff
FROM sensor_hourly
WHERE sensor IN ('th-1', 'th-2') AND metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 7 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY t
ORDER BY t;


-- 13. Top 10 meter ที่ avg สูงสุดเมื่อวาน
SELECT sensor, round(avgMerge(avg_v), 2) AS avg, max(max_v) AS peak
FROM sensor_hourly
WHERE metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 1 DAY
  AND hour <  toStartOfDay(now('Asia/Bangkok'))
GROUP BY sensor
ORDER BY avg DESC
LIMIT 10;


-- ===========================================================================
-- Aggregation เพิ่มเติม
-- ===========================================================================

-- 14. bucket ราย 15 นาทีจาก raw + p95 / stddev (agg ที่ไม่ได้เก็บใน hourly ต้องคำนวณจาก raw)
WITH (SELECT max(ts) FROM sensor_long) AS latest
SELECT toStartOfInterval(ts, INTERVAL 15 MINUTE, 'Asia/Bangkok') AS t,
       count() AS n, round(avg(value), 2) AS avg, min(value) AS min, max(value) AS max,
       round(quantile(0.95)(value), 2) AS p95,
       round(stddevPop(value), 2)      AS stddev
FROM sensor_long
WHERE sensor = 'th-1' AND metric = 'temp'
  AND ts >= latest - INTERVAL 6 HOUR
GROUP BY t
ORDER BY t;


-- 15. diff จากวันก่อน + moving average 7 วัน (window function)
SELECT t, avg,
       if(row_number() OVER w = 1, NULL, round(avg - lagInFrame(avg) OVER w, 2)) AS diff_prev,
       round(avg(avg) OVER (ORDER BY t ROWS BETWEEN 6 PRECEDING AND CURRENT ROW), 2) AS ma7
FROM (
  SELECT toDate(hour, 'Asia/Bangkok') AS t, round(avgMerge(avg_v), 2) AS avg
  FROM sensor_hourly
  WHERE sensor = 'th-1' AND metric = 'temp'
    AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 30 DAY
    AND hour <  toStartOfDay(now('Asia/Bangkok'))
  GROUP BY t
)
WINDOW w AS (ORDER BY t ROWS BETWEEN 1 PRECEDING AND CURRENT ROW)
ORDER BY t;


-- 16. ความครบของข้อมูลรายวัน (data completeness)
-- 288 = จุดต่อวันเมื่อส่งทุก 5 นาที (เปลี่ยนตามความถี่จริง) / วันนี้ยังไม่จบ จะไม่ครบเสมอ
SELECT toDate(hour, 'Asia/Bangkok') AS t, sensor,
       countMerge(samples)       AS n,
       round(n / 288 * 100, 1)   AS completeness_pct
FROM sensor_hourly
WHERE metric = 'temp'
  AND hour >= toStartOfDay(now('Asia/Bangkok')) - INTERVAL 7 DAY
GROUP BY t, sensor
HAVING n < 288
ORDER BY t, sensor;


-- ---------------------------------------------------------------------------
-- ดูเวลา/จำนวนแถวที่อ่านของ query ที่เพิ่งรัน (เวลาฝั่ง server ไม่รวม network)
-- FLUSH ก่อน: ClickHouse เขียน query_log ทุก ~7 วิ ไม่ flush จะไม่เห็นตัวล่าสุด
-- read_rows = แถวที่อ่านจาก disk (ทีละ granule 8,192 แถว) มากกว่าแถวที่ตรง WHERE
SYSTEM FLUSH LOGS;

SELECT event_time,
       query_duration_ms              AS ms,
       read_rows,
       formatReadableSize(read_bytes) AS read,
       result_rows,
       substring(replaceRegexpAll(query, '\\s+', ' '), 1, 80) AS query
FROM system.query_log
WHERE type = 'QueryFinish'
  AND query_kind = 'Select'
  AND query LIKE '%sensor_%'
  AND query NOT LIKE '%query_log%'
ORDER BY event_time DESC
LIMIT 10;


-- ---------------------------------------------------------------------------
-- ทดสอบ TTL (รันทีละคำสั่ง)
-- TTL ของตารางจริงยาวเป็นวัน: สร้างตารางทดสอบ TTL 1 นาที, partition รายนาที ให้เห็นผลเร็ว
-- (insert แถวเก่าเข้า sensor_raw ตรงๆ ไม่เห็นผล: ทั้ง partition หมดอายุแล้วถูกลบแทบทันที
--  แต่ MV ส่งต่อไป long/hourly/daily ไปแล้ว ต้องตามลบเอง)

CREATE TABLE ttl_test AS sensor_raw
ENGINE = MergeTree PARTITION BY toStartOfMinute(ts) ORDER BY (sensor, ts)
TTL ts + INTERVAL 1 MINUTE
SETTINGS ttl_only_drop_parts = 1;

INSERT INTO ttl_test SELECT now() - number, 'd1', '{}' FROM numbers(30);

-- ได้ 30 แถว
SELECT count() FROM ttl_test;

-- partition ไหนหมดอายุเมื่อไหร่ (delete_ttl_info_max = แถวสุดท้ายใน partition หมดอายุ)
SELECT partition, rows, delete_ttl_info_max, delete_ttl_info_max < now() AS expired
FROM system.parts WHERE database = 'demo' AND table = 'ttl_test' AND active;

-- รอ ~2 นาทีแล้วรันอีกที ได้ 0 (ทดสอบแล้ว: 95 วิหลัง insert หายเองโดยไม่ต้องสั่ง)
-- ถ้ายังไม่หาย สั่งให้ลบตอนนี้เลย:
ALTER TABLE ttl_test MATERIALIZE TTL SETTINGS mutations_sync = 1;
SELECT count() FROM ttl_test;

DROP TABLE ttl_test;

-- ดูว่า partition ของตารางจริงจะถูกลบเมื่อไหร่
SELECT table, partition, delete_ttl_info_max AS drop_after
FROM system.parts
WHERE database = 'demo' AND active AND table IN ('sensor_raw', 'sensor_long', 'sensor_hourly')
ORDER BY table, partition
LIMIT 1 BY table;


-- ---------------------------------------------------------------------------
-- partition / part ของแต่ละตาราง
SELECT table, partition, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE database = 'demo' AND active AND table LIKE 'sensor_%'
GROUP BY table, partition
ORDER BY table, partition;
