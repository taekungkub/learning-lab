# Relations ใน ClickHouse (example 12)

บทแยกจากชุด sensor: `devices`, `device_types`, `locations` ไม่เชื่อมกับตาราง `sensor_*`

```bash
bun run examples/12-relations.ts   # DROP/CREATE ตารางของตัวเอง รันซ้ำได้
```

Query สำหรับ TablePlus: `docs/relations.sql`

```
locations (tree: parent_id)        device_types
     ▲ location_id                      ▲ type_id
     └──────────── devices ─────────────┘
```

## ต่างจาก Postgres

| | Postgres | ClickHouse |
|---|---|---|
| Foreign key | มี บังคับตอน insert | **ไม่มี** insert id ที่ไม่มีอยู่ได้ (x-1 ใน ex 12) |
| Unique / primary key | unique จริง | PRIMARY KEY ไม่ unique, id ซ้ำได้ |
| แก้ข้อมูล | `UPDATE` | insert version ใหม่ + `ReplacingMergeTree` |
| Relation | JOIN | JOIN (เหมือนกัน) |
| LEFT JOIN ไม่เจอ | `NULL` | ค่า default ของ type (`''`, `0`) ถ้าไม่ตั้ง `join_use_nulls = 1` |

## 1. ตาราง dimension: ReplacingMergeTree

```sql
CREATE TABLE devices (id String, type_id UInt64, location_id UInt64, updated_at DateTime)
ENGINE = ReplacingMergeTree(updated_at) ORDER BY id
```

- แก้ข้อมูล (ย้าย location, เปลี่ยนชื่อ) = insert แถวใหม่ที่ `updated_at` ใหม่กว่า
- แถวเก่าถูกลบตอน merge (ไม่รู้ว่าเมื่อไหร่) ระหว่างนั้นเห็นทั้ง 2 version
- อ่านต้องเอา version ล่าสุดเอง:
  - `FROM devices FINAL` ง่าย ตาราง dimension เล็ก ใช้ได้สบาย
  - `argMax(location_id, updated_at) ... GROUP BY id` ไม่ต้อง FINAL
    (alias ห้ามซ้ำชื่อคอลัมน์ เช่น `max(updated_at) AS updated_at` แล้ว argMax จะเห็น alias → error)

**ลืม FINAL ใน JOIN = แถวซ้ำ**: ex 12 ย้าย pm-1 แล้ว JOIN ไม่ใส่ FINAL ได้ pm-1 ออกมา 2 แถว (ทั้ง location เก่าและใหม่)
ต้องใส่ FINAL ทุกตารางที่ JOIN

## 2. ไม่มี foreign key

- insert device ที่ `type_id = 99` (ไม่มีอยู่) ได้ ClickHouse ไม่ตรวจ
- LEFT JOIN ไม่เจอ ได้ `''` ไม่ใช่ NULL (`join_use_nulls = 0` default) ตั้ง `SETTINGS join_use_nulls = 1` ถ้าอยากได้ NULL
- ตรวจเอง: `WHERE type_id NOT IN (SELECT id FROM device_types)`
- ระบบจริง: ให้แอป (หรือ Postgres ที่เป็นเจ้าของข้อมูล) บังคับ relation ก่อนส่งเข้า ClickHouse

## 3. Drill-down + pagination

UI เลือกทีละชั้น (site → plant → building → device) แต่ละขั้นเป็น query ง่ายด้วย `parent_id`

```sql
-- ชั้นแรก
SELECT id, name FROM locations FINAL WHERE parent_id = 0 ORDER BY name;

-- กดเข้าไป (ส่ง id ที่เลือก)
SELECT id, name FROM locations FINAL WHERE parent_id = {p:UInt64} ORDER BY name;

-- device ใน location ที่เลือก แบ่งหน้า
SELECT d.id, t.code AS type
FROM devices AS d FINAL
LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
WHERE d.location_id = {loc:UInt64}
ORDER BY d.id
LIMIT {size:UInt32} OFFSET {offset:UInt32};

-- จำนวนทั้งหมด (ทำปุ่มหน้า)
SELECT count() FROM devices FINAL WHERE location_id = {loc:UInt64};
```

ผล ex 12: bkk → plant-a → building-1 มี 3 device หน้าละ 2: หน้า 1 = pm-2, th-1 / หน้า 2 = th-2

แต่ละขั้นอ่านแค่ไม่กี่แถว ที่ 10k device ก็ไม่ต้องห่วง

## 4. Tree ลึกคงที่: JOIN locations ซ้ำ

ต้องการทุก device ใต้ node ไหนก็ได้ (รวมทั้ง plant-a ไม่ว่ากี่อาคาร) หรือ path เต็ม
tree ลึกคงที่ 3 ชั้น (site / plant / building) → JOIN `locations` 3 ครั้ง

```sql
SELECT d.id AS device,
       site.id AS site_id, plant.id AS plant_id, building.id AS building_id,
       concat(site.name, ' / ', plant.name, ' / ', building.name) AS path
FROM devices AS d FINAL
JOIN locations AS building FINAL ON building.id = d.location_id
JOIN locations AS plant    FINAL ON plant.id    = building.parent_id
JOIN locations AS site     FINAL ON site.id     = plant.parent_id
```

แล้วกรอง `WHERE plant_id = 2` = ทุก device ใต้ plant-a (ex 12 ได้ 8 ตัว)

- INNER JOIN: device ที่ location ไม่มีอยู่จริง (x-1) ถูกตัดทิ้ง ใช้ LEFT JOIN ถ้าต้องการเห็น
- ถ้าวันหลัง tree ลึกไม่คงที่ ค่อยดูทางเลือกอื่น (เก็บ path เป็น string หรือ ClickHouse dictionary แบบ hierarchical)

## ยังไม่ได้ทำ (บทต่อไป)

- เชื่อมกับชุด sensor: `getStats()` เลือกตาม location / type และ groupBy location
  - กรองต้องใช้ `sensor IN (SELECT id FROM devices ...)` (ใช้ index ได้)
  - รวมข้าม device ตามชนิด metric (power_kw = sum ไม่ใช่ avg)
