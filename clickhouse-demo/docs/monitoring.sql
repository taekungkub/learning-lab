-- ตรวจสถานะระบบ: query log, TTL, disk, partition, part (database: demo)
-- query ข้อมูลอยู่ที่ queries.sql / ไฟล์นี้ไม่แตะข้อมูล ยกเว้นหัวข้อทดสอบ TTL (สร้าง/ลบตาราง ttl_test เอง)
-- ปกติไม่ต้องดู เปิดเฉพาะตอนมีปัญหา: Too many parts, disk โตไม่หยุด, query ช้า

-- สารบัญ
--   1. query_log   : เวลา / จำนวนแถวที่อ่านของ query ที่เพิ่งรัน (ใช้วัดความเร็ว)
--   2. TTL         : ทดสอบ TTL + ดูว่า partition ของตารางจริงจะถูกลบเมื่อไหร่
--   3. disk        : ต่อตาราง / ต่อคอลัมน์ / ทั้งเครื่อง
--   4. part        : part ใน partition เดียว (แก้ table / partition ก่อนรัน)
--   5. partition   : partition + จำนวน part ของทุกตาราง sensor_*


-- ---------------------------------------------------------------------------
-- 1. query_log: ดูเวลา/จำนวนแถวที่อ่านของ query ที่เพิ่งรัน (เวลาฝั่ง server ไม่รวม network)
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
-- 2. TTL: ทดสอบ (รันทีละคำสั่ง)
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
WHERE database = 'demo' AND active AND table IN ('sensor_raw', 'sensor_long', 'sensor_1m', 'sensor_hourly')
ORDER BY table, partition
LIMIT 1 BY table;


-- ---------------------------------------------------------------------------
-- 3. disk: ใช้ต่อตาราง (on_disk = ขนาดจริง, uncompressed = ถ้าไม่บีบอัด, ratio = บีบได้กี่เท่า)
SELECT table,
       sum(rows)                                        AS rows,
       formatReadableSize(sum(bytes_on_disk))           AS on_disk,
       formatReadableSize(sum(data_uncompressed_bytes)) AS uncompressed,
       round(sum(data_uncompressed_bytes) / sum(data_compressed_bytes), 1) AS ratio
FROM system.parts
WHERE database = 'demo' AND active
GROUP BY table
ORDER BY sum(bytes_on_disk) DESC;

-- disk ที่ใช้ต่อคอลัมน์ (หาว่าคอลัมน์ไหนกินที่ / ควรเปลี่ยน codec)
SELECT table, name, type, compression_codec,
       formatReadableSize(data_compressed_bytes)   AS on_disk,
       formatReadableSize(data_uncompressed_bytes) AS uncompressed
FROM system.columns
WHERE database = 'demo' AND table = 'sensor_long'
ORDER BY data_compressed_bytes DESC;

-- disk ทั้งเครื่อง (ใน Docker = disk ของ volume)
SELECT name, path,
       formatReadableSize(free_space)  AS free,
       formatReadableSize(total_space) AS total,
       round(100 * (1 - free_space / total_space), 1) AS used_pct
FROM system.disks;


-- ---------------------------------------------------------------------------
-- 4. part: ใน partition (แก้ table / partition ตามที่อยากดู)
-- name = partition_บล็อกแรก_บล็อกสุดท้าย_level (level > 0 = มาจาก merge)
-- min_time/max_time = ช่วงเวลาใน part (MinMax ใช้ข้าม part ตอน query)
-- drop_after = TTL ลบ part นี้ทั้งก้อนได้หลังเวลานี้ (แถวใหม่สุดใน part หมดอายุ)
SELECT partition, name, rows, formatReadableSize(bytes_on_disk) AS size,
       min_time, max_time, delete_ttl_info_max AS drop_after, level
FROM system.parts
WHERE database = 'demo' AND table = 'sensor_long' AND active
  AND partition = '20261028'
ORDER BY name;


-- ---------------------------------------------------------------------------
-- 5. partition: partition / part ของแต่ละตาราง (part เยอะผิดปกติต่อ partition = merge ไม่ทัน)
SELECT table, partition, count() AS parts, sum(rows) AS rows,
       formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE database = 'demo' AND active AND table LIKE 'sensor_%'
GROUP BY table, partition
ORDER BY table, partition;
