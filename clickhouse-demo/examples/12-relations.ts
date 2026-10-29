// bun run examples/12-relations.ts
// บทใหม่ แยกจากชุด sensor: device / device_type / location กับ relation ใน ClickHouse
// ClickHouse ไม่มี foreign key, ไม่มี unique: relation = JOIN ตอน query
//
//   locations (tree: parent_id)        device_types
//        ▲ location_id                      ▲ type_id
//        └──────────── devices ─────────────┘
import { ch, rows } from "../src/ch";

// เก็บกวาด dictionary จากรุ่นก่อนของ example นี้ (ถ้ามี)
for (const d of ["device_types_dict", "locations_dict"]) await ch.command({ query: `DROP DICTIONARY IF EXISTS ${d}` });
for (const t of ["devices", "device_types", "locations"]) await ch.command({ query: `DROP TABLE IF EXISTS ${t}` });

// ข้อมูลอธิบาย (dimension) แก้ได้: ReplacingMergeTree = แก้ด้วยการ insert แถวใหม่ที่ updated_at ใหม่กว่า
await ch.command({
  query: `CREATE TABLE device_types (id UInt64, code LowCardinality(String), name String, updated_at DateTime)
          ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
});
// location เป็น tree: site → plant → building (parent_id = 0 คือ root)
await ch.command({
  query: `CREATE TABLE locations (id UInt64, parent_id UInt64, name String, updated_at DateTime)
          ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
});
await ch.command({
  query: `CREATE TABLE devices (id String, type_id UInt64, location_id UInt64, updated_at DateTime)
          ENGINE = ReplacingMergeTree(updated_at) ORDER BY id`,
});

const v1 = "2026-01-01 00:00:00";
await ch.insert({
  table: "device_types", format: "JSONEachRow",
  values: [
    { id: 1, code: "th", name: "Temp/Humidity sensor", updated_at: v1 },
    { id: 2, code: "pm", name: "Power meter", updated_at: v1 },
  ],
});
await ch.insert({
  table: "locations", format: "JSONEachRow",
  values: [
    { id: 1, parent_id: 0, name: "bkk", updated_at: v1 },
    { id: 2, parent_id: 1, name: "plant-a", updated_at: v1 },
    { id: 3, parent_id: 2, name: "building-1", updated_at: v1 },
    { id: 4, parent_id: 2, name: "building-2", updated_at: v1 },
    { id: 5, parent_id: 0, name: "cnx", updated_at: v1 },
    { id: 6, parent_id: 5, name: "plant-b", updated_at: v1 },
    { id: 7, parent_id: 6, name: "building-1", updated_at: v1 },
  ],
});
// ชื่อ device ชุดเดียวกับ sensor (th-1..5, pm-1..5) แต่เป็นตารางแยก ไม่ได้เชื่อมกัน
await ch.insert({
  table: "devices", format: "JSONEachRow",
  values: [
    ...[1, 2, 3, 4, 5].flatMap((i) => [
      { id: `th-${i}`, type_id: 1, location_id: [3, 3, 4, 4, 7][i - 1], updated_at: v1 },
      { id: `pm-${i}`, type_id: 2, location_id: [3, 3, 4, 4, 7][i - 1], updated_at: v1 },
    ]),
    { id: "x-1", type_id: 99, location_id: 99, updated_at: v1 }, // ไม่มี FK: type/location ที่ไม่มีอยู่ก็ insert ได้
  ],
});

const section = (s: string) => console.log(`\n========== ${s}`);

// ---------------------------------------------------------------------------
section("1) JOIN 3 ตาราง (FINAL = เอาเฉพาะ version ล่าสุดของแต่ละ id)");
const joinSql = (final: boolean) => `
  SELECT d.id AS device, t.code AS type, l.name AS location
  FROM devices AS d ${final ? "FINAL" : ""}
  LEFT JOIN device_types AS t ${final ? "FINAL" : ""} ON t.id = d.type_id
  LEFT JOIN locations AS l ${final ? "FINAL" : ""} ON l.id = d.location_id
  ORDER BY device`;
const joined = await rows<{ device: string; type: string; location: string }>(joinSql(true));
console.table(joined);

// ---------------------------------------------------------------------------
section("2) ไม่มี foreign key: x-1 ชี้ type/location ที่ไม่มีอยู่");
const orphan = joined.find((r) => r.device === "x-1");
console.log("LEFT JOIN ไม่เจอ (default join_use_nulls = 0):", JSON.stringify(orphan), "← ได้ '' ไม่ใช่ NULL");
const [orphanNull] = await rows<{ type: string | null }>(
  `SELECT t.code AS type FROM devices AS d LEFT JOIN device_types AS t ON t.id = d.type_id
   WHERE d.id = 'x-1' SETTINGS join_use_nulls = 1`,
);
console.log("join_use_nulls = 1:", JSON.stringify(orphanNull), "← ได้ NULL แบบ SQL ปกติ");
const orphans = await rows("SELECT id, type_id FROM devices FINAL WHERE type_id NOT IN (SELECT id FROM device_types)");
console.log("หา device ที่ type ไม่มีอยู่จริง (ตรวจเองแทน FK):");
console.table(orphans);

// ---------------------------------------------------------------------------
section("3) แก้ข้อมูล = insert version ใหม่: ย้าย pm-1 จาก building-1 (3) ไป building-2 (4)");
await ch.insert({ table: "devices", format: "JSONEachRow", values: [{ id: "pm-1", type_id: 2, location_id: 4, updated_at: "2026-06-01 00:00:00" }] });

const pm1Rows = await rows("SELECT * FROM devices WHERE id = 'pm-1' ORDER BY updated_at");
console.log("ไม่ใส่ FINAL (ยังไม่ merge): เห็นทั้ง 2 version");
console.table(pm1Rows);
const noFinal = (await rows<{ device: string }>(joinSql(false))).filter((r) => r.device === "pm-1");
const withFinal = (await rows<{ device: string; location: string }>(joinSql(true))).filter((r) => r.device === "pm-1");
console.log(`JOIN ไม่ใส่ FINAL: pm-1 ออกมา ${noFinal.length} แถว (ซ้ำ) | ใส่ FINAL: ${withFinal.length} แถว location = ${withFinal[0]?.location}`);
console.table(await rows("SELECT id, argMax(location_id, updated_at) AS latest_location_id FROM devices WHERE id = 'pm-1' GROUP BY id"));
console.log("↑ argMax: อีกวิธีเอา version ล่าสุด (ไม่ต้อง FINAL)");

// ---------------------------------------------------------------------------
section("4) Drill-down + pagination: UI เลือกทีละชั้น ใช้ parent_id ตรงๆ");
const roots = await rows<{ id: number; name: string }>("SELECT id, name FROM locations FINAL WHERE parent_id = 0 ORDER BY name");
console.log("ชั้น 1 (root):", roots.map((r) => `${r.id}:${r.name}`).join(", "));
const plants = await rows<{ id: number; name: string }>(
  "SELECT id, name FROM locations FINAL WHERE parent_id = {p:UInt64} ORDER BY name", { p: roots[0]!.id },
);
console.log(`ชั้น 2 (กด ${roots[0]!.name}):`, plants.map((r) => `${r.id}:${r.name}`).join(", "));
const buildings = await rows<{ id: number; name: string }>(
  "SELECT id, name FROM locations FINAL WHERE parent_id = {p:UInt64} ORDER BY name", { p: plants[0]!.id },
);
console.log(`ชั้น 3 (กด ${plants[0]!.name}):`, buildings.map((r) => `${r.id}:${r.name}`).join(", "));

// device ใน location ที่เลือก แบ่งหน้า (LIMIT / OFFSET) + count ไว้ทำปุ่มหน้า
const PAGE = 2;
const devicePage = (loc: number, page: number) =>
  rows<{ id: string; type: string }>(
    `SELECT d.id, t.code AS type
     FROM devices AS d FINAL
     LEFT JOIN device_types AS t FINAL ON t.id = d.type_id
     WHERE d.location_id = {loc:UInt64}
     ORDER BY d.id
     LIMIT {size:UInt32} OFFSET {offset:UInt32}`,
    { loc, size: PAGE, offset: page * PAGE },
  );
const b1 = buildings[0]!.id;
const [{ total }] = await rows<{ total: number }>("SELECT count() AS total FROM devices FINAL WHERE location_id = {loc:UInt64}", { loc: b1 });
const p1 = await devicePage(b1, 0);
const p2 = await devicePage(b1, 1);
console.log(`device ใน ${buildings[0]!.name} (${total} ตัว, หน้าละ ${PAGE}): หน้า 1 = ${p1.map((r) => r.id)} | หน้า 2 = ${p2.map((r) => r.id)}`);

// ---------------------------------------------------------------------------
section("5) Tree ลึกคงที่ 3 ชั้น: JOIN locations ซ้ำ ได้ path และหาทุก device ใต้ node ไหนก็ได้");
const treeSql = `
  SELECT d.id AS device,
         site.id AS site_id, plant.id AS plant_id, building.id AS building_id,
         concat(site.name, ' / ', plant.name, ' / ', building.name) AS path
  FROM devices AS d FINAL
  JOIN locations AS building FINAL ON building.id = d.location_id
  JOIN locations AS plant    FINAL ON plant.id    = building.parent_id
  JOIN locations AS site     FINAL ON site.id     = plant.parent_id`;
const tree = await rows<{ device: string; site_id: number; plant_id: number; building_id: number; path: string }>(
  `${treeSql} ORDER BY path, device`,
);
console.table(tree);

// ทุก device ใต้ plant-a (2) ไม่ว่าอาคารไหน
const underPlantA = await rows<{ device: string }>(`SELECT device FROM (${treeSql}) WHERE plant_id = 2 ORDER BY device`);
console.log("device ใต้ plant-a:", underPlantA.map((r) => r.device).join(", "));
const perSite = await rows<{ site: string; devices: number }>(
  `SELECT splitByString(' / ', path)[1] AS site, count() AS devices FROM (${treeSql}) GROUP BY site ORDER BY site`,
);
console.log("จำนวน device ต่อ site:", perSite.map((r) => `${r.site}=${r.devices}`).join(", "));

// ---------------------------------------------------------------------------
// self-check
const ok1 = joined.length === 11 && joined.find((r) => r.device === "th-5")?.location === "building-1";
const ok2 = orphan?.type === "" && orphanNull?.type === null && orphans.length === 1;
const ok3 = pm1Rows.length === 2 && noFinal.length === 2 && withFinal.length === 1 && withFinal[0]?.location === "building-2";
// pm-1 ย้ายไป building-2 แล้ว: building-1 เหลือ pm-2, th-1, th-2
const ok4 =
  roots.map((r) => r.name).join() === "bkk,cnx" && plants.map((r) => r.name).join() === "plant-a" &&
  buildings.length === 2 && total === 3 &&
  JSON.stringify(p1.map((r) => r.id)) === '["pm-2","th-1"]' && JSON.stringify(p2.map((r) => r.id)) === '["th-2"]';
// x-1 ไม่มี location: INNER JOIN ตัดทิ้ง เหลือ 10
const ok5 =
  tree.length === 10 && tree.find((r) => r.device === "th-1")?.path === "bkk / plant-a / building-1" &&
  underPlantA.length === 8 &&
  perSite.find((r) => r.site === "bkk")?.devices === 8 && perSite.find((r) => r.site === "cnx")?.devices === 2;
console.assert(ok1 && ok2 && ok3 && ok4 && ok5, "ผลไม่ตรง");
console.log(`\ncheck: 1=${ok1} 2=${ok2} 3=${ok3} 4=${ok4} 5=${ok5}`);
await ch.close();
