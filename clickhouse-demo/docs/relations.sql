-- Query สำหรับ copy ไปรันใน TablePlus (database: demo) ของ example 12 (relations)
-- ต้องรัน examples/12-relations.ts ก่อน (สร้าง devices, device_types, locations + ข้อมูลตัวอย่าง)
-- แยกจากชุด sensor ไม่แตะตาราง sensor_*
--
--   locations (tree: parent_id)        device_types
--        ▲ location_id                      ▲ type_id
--        └──────────── devices ─────────────┘
--
-- ข้อมูลหลังรัน 12:
--   device: th-1..5, pm-1..5, x-1 (type/location ไม่มีอยู่จริง)
--   location (parent_id = id ของชั้นบน, 0 = root):
--     1 bkk
--     ├── 2 plant-a
--     │   ├── 3 building-1   th-1, th-2, pm-2
--     │   └── 4 building-2   th-3, th-4, pm-3, pm-4, pm-1 (ย้ายมาจาก 3)
--     5 cnx
--     └── 6 plant-b
--         └── 7 building-1   th-5, pm-5
--   pm-1 มี 2 version (location 3 เก่า, 4 ใหม่)


-- ===========================================================================
-- 1. JOIN
-- ทุกตารางเป็น ReplacingMergeTree: ใส่ FINAL ทุกตาราง ไม่งั้นได้ทุก version (แถวซ้ำ)
-- ===========================================================================

-- 1.1 device + type + location
SELECT d.id AS device, t.code AS type, t.name AS type_name, l.name AS location
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
LEFT JOIN locations AS l FINAL ON l.id = d.location_id
ORDER BY device;


-- 1.2 ลืม FINAL: pm-1 ออกมา 2 แถว (location เก่า + ใหม่)
SELECT d.id AS device, d.updated_at, l.name AS location
FROM devices AS d
LEFT JOIN locations AS l ON l.id = d.location_id
WHERE d.id = 'pm-1'
ORDER BY d.updated_at;


-- 1.3 device + path เต็ม (tree ลึกคงที่ 3 ชั้น: JOIN locations ซ้ำ 3 ครั้ง)
SELECT d.id AS device,
       site.name AS site, plant.name AS plant, building.name AS building,
       concat(site.name, ' / ', plant.name, ' / ', building.name) AS path
FROM devices AS d FINAL
JOIN locations AS building FINAL ON building.id = d.location_id
JOIN locations AS plant    FINAL ON plant.id    = building.parent_id
JOIN locations AS site     FINAL ON site.id     = plant.parent_id
ORDER BY path, device;


-- 1.4 ทุก device ใต้ plant-a (2) ไม่ว่าอาคารไหน (เปลี่ยนเป็น site: JOIN อีกชั้นแล้ว WHERE site.id = 1)
SELECT d.id AS device, building.name AS building
FROM devices AS d FINAL
JOIN locations AS building FINAL ON building.id = d.location_id
JOIN locations AS plant    FINAL ON plant.id    = building.parent_id
WHERE plant.id = 2
ORDER BY device;


-- 1.5 นับ device ต่อ location ต่อ type
SELECT l.name AS location, t.code AS type, count() AS devices
FROM devices AS d FINAL
JOIN device_types AS t FINAL ON t.id = d.type_id
JOIN locations AS l FINAL ON l.id = d.location_id
GROUP BY location, type
ORDER BY location, type;


-- 1.6 ดู tree ทั้งหมด
SELECT id, parent_id, name FROM locations FINAL ORDER BY id;


-- ===========================================================================
-- 2. ไม่มี foreign key
-- ===========================================================================

-- 2.1 LEFT JOIN ไม่เจอ: ได้ '' ไม่ใช่ NULL (default join_use_nulls = 0)
SELECT d.id, d.type_id, t.code AS type
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
WHERE d.id = 'x-1';


-- 2.2 อยากได้ NULL แบบ SQL ปกติ
SELECT d.id, d.type_id, t.code AS type
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
WHERE d.id = 'x-1'
SETTINGS join_use_nulls = 1;


-- 2.3 ตรวจเองแทน FK: device ที่ type / location ไม่มีอยู่จริง
SELECT id, type_id, location_id
FROM devices FINAL
WHERE type_id NOT IN (SELECT id FROM device_types)
   OR location_id NOT IN (SELECT id FROM locations);


-- ===========================================================================
-- 3. แก้ข้อมูล = insert version ใหม่ (ReplacingMergeTree)
-- ===========================================================================

-- 3.1 ดูทุก version ของ device (ไม่ใส่ FINAL)
SELECT * FROM devices WHERE id = 'pm-1' ORDER BY updated_at;


-- 3.2 version ล่าสุดด้วย argMax (ไม่ต้อง FINAL)
-- alias ห้ามซ้ำชื่อคอลัมน์ที่ใช้ใน aggregate อื่น (AS updated_at แล้ว argMax จะเห็น alias แทนคอลัมน์ → error)
SELECT id,
       argMax(location_id, updated_at) AS latest_location_id,
       max(updated_at)                 AS latest_at
FROM devices
GROUP BY id
ORDER BY id;


-- 3.3 ย้าย device = insert แถวใหม่ที่ updated_at ใหม่กว่า (เปลี่ยนข้อมูล! รัน 12 ใหม่เพื่อรีเซ็ต)
-- INSERT INTO devices VALUES ('th-1', 1, 7, now());


-- 3.4 บังคับ merge ให้แถวเก่าหายจริง (ใช้ใน demo, ระบบจริงปล่อย background merge)
-- OPTIMIZE TABLE devices FINAL;


-- ===========================================================================
-- 4. Drill-down + pagination (UI เลือกทีละชั้น ใช้ parent_id ตรงๆ)
-- ===========================================================================

-- 4.1 ชั้นแรก (root)
SELECT id, name FROM locations FINAL WHERE parent_id = 0 ORDER BY name;


-- 4.2 กดเข้าไป: เปลี่ยน 1 เป็น id ที่เลือก (1 bkk → 2 plant-a → 3, 4 building)
SELECT id, name FROM locations FINAL WHERE parent_id = 1 ORDER BY name;


-- 4.3 ชั้นถัดไป + จำนวน device (ไว้แสดง "building-1 (3 devices)")
SELECT l.id, l.name, countIf(d.id != '') AS devices
FROM locations AS l FINAL
LEFT JOIN devices AS d FINAL ON d.location_id = l.id
WHERE l.parent_id = 2
GROUP BY l.id, l.name
ORDER BY l.name;


-- 4.4 device ใน location ที่เลือก หน้าละ 2 (หน้าถัดไป OFFSET 2, 4, ...)
SELECT d.id, t.code AS type
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
WHERE d.location_id = 3
ORDER BY d.id
LIMIT 2 OFFSET 0;


-- 4.5 จำนวนทั้งหมด (ทำปุ่มหน้า)
SELECT count() AS total FROM devices FINAL WHERE location_id = 3;


-- 4.6 ค้นหาชื่อ device + filter type แบ่งหน้า
SELECT d.id, t.code AS type, l.name AS location
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
LEFT JOIN locations AS l FINAL ON l.id = d.location_id
WHERE d.id ILIKE '%pm%' AND t.code = 'pm'
ORDER BY d.id
LIMIT 20 OFFSET 0;
