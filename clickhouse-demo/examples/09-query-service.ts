// bun run examples/09-query-service.ts   (ต้องรัน 08 ก่อน: ใช้ schema sensor_*)
// service function getStats: รายชั่วโมง/วัน/เดือน/ปี agg ต่อจาก sensor_hourly
import { ch, rows } from "../src/ch";
import { getStats, type StatsRow } from "../src/stats";

// ล้างข้อมูลจาก 08 แล้วใส่ข้อมูล ~400 วัน ทุก 5 นาที (ให้เห็นรายเดือน/ปี)
for (const t of ["sensor_raw", "sensor_long", "sensor_hourly", "sensor_daily"]) await ch.command({ query: `TRUNCATE TABLE ${t}` });

const DAYS = 400;
const STEP = 300; // 5 นาที
const start = Math.floor((Date.now() / 1000 - DAYS * 86400) / 3600) * 3600;
const total = Math.floor((DAYS * 86400) / STEP);
const perBatch = (30 * 86400) / STEP; // 30 วันต่อ insert: sensor_long แบ่ง partition รายวัน (จำกัด 100 partition ต่อ insert)

// insert เข้า sensor_long ตรงๆ: MV → hourly → daily ทำงานตามปกติ
// ข้อมูลเก่ากว่า TTL 30 วันของ sensor_long จะถูกลบทีหลัง แต่ hourly/daily ถูกเขียนไปแล้ว
for (let i = 0; i < total; i += perBatch) {
  await ch.command({
    query: `
      INSERT INTO sensor_long
      SELECT ts, m.1 AS sensor, m.2 AS metric,
             round(m.3 + (rand() % 1000) / 1000 * m.4
                   + if(m.2 = 'temp', 5 * sin(2 * pi() * toDayOfYear(ts) / 365), 0), 1) AS value  -- temp มี season
      FROM (SELECT toDateTime({start:UInt32}) + number * {step:UInt32} AS ts
            FROM numbers({offset:UInt32}, {n:UInt32}))
      ARRAY JOIN [('th-1', 'temp', 25., 5.), ('th-1', 'humidity', 50., 20.),
                  ('th-2', 'temp', 30., 5.), ('th-2', 'humidity', 40., 20.),  -- th-2 ร้อนกว่า th-1 ไว้ดู fleet
                  ('pm-1', 'voltage', 218., 4.), ('pm-1', 'current', 2., 3.)] AS m`,
    query_params: { start, step: STEP, offset: i, n: Math.min(perBatch, total - i) },
  });
}

// วันที่ตามเวลาไทย 'YYYY-MM-DD' (offset วันจากวันนี้)
const bkkDate = (offsetDays = 0) => new Date(Date.now() + 7 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10);
const ALL = { from: "2020-01-01 00:00:00", to: "2100-01-01 00:00:00" };

async function show(label: string, q: Parameters<typeof getStats>[0]) {
  const t0 = performance.now();
  const r = await getStats(q);
  console.log(`\n${label}  (${r.length} แถว, ${(performance.now() - t0).toFixed(0)} ms)`);
  console.table(r);
  return r;
}

const hour = await show("รายชั่วโมง เมื่อวาน (th-1 temp)", {
  sensor: "th-1", grain: "hour", metrics: ["temp"],
  from: `${bkkDate(-1)} 00:00:00`, to: `${bkkDate(0)} 00:00:00`,
});
await show("รายวัน 7 วันล่าสุด (th-1 ทุก metric)", {
  sensor: "th-1", grain: "day", from: `${bkkDate(-7)} 00:00:00`, to: `${bkkDate(0)} 00:00:00`,
});
await show("รายเดือน (pm-1 voltage)", { sensor: "pm-1", grain: "month", metrics: ["voltage"], ...ALL });
const year = await show("รายปี (th-1 temp)", { sensor: "th-1", grain: "year", metrics: ["temp"], ...ALL });

const yesterday = { from: `${bkkDate(-1)} 00:00:00`, to: `${bkkDate(0)} 00:00:00` };
const perDevice = await show("เมื่อวาน ทุก device แยกตัว (ไม่ใส่ sensor)", { grain: "day", ...yesterday });
const fleet = await show("เมื่อวาน รวมทั้ง fleet", { grain: "day", groupBy: "fleet", ...yesterday });

// ---- self-check ----
const near = (a: StatsRow, b: Omit<StatsRow, "sum" | "diff">) =>
  String(a.t) === String(b.t) && a.n === b.n && a.min === b.min && a.max === b.max && Math.abs(a.avg - b.avg) <= 0.01;
const same = (got: StatsRow[], want: Omit<StatsRow, "sum" | "diff">[]) =>
  got.length === want.length && got.every((g, i) => near(g, want[i]!));

console.assert(hour.length === 24 && hour[0]?.diff === null, "รายชั่วโมงเมื่อวานต้องมี 24 แถว และ diff แถวแรกเป็น NULL");

// day จาก hourly ต้องตรงกับ sensor_daily (MV ตัดวันไทยไว้ตอนเขียน)
const dayGot = await getStats({ sensor: "th-1", grain: "day", ...ALL });
const dayWant = await rows<Omit<StatsRow, "sum" | "diff">>(`
  SELECT day AS t, metric, toUInt32(countMerge(samples)) AS n, round(avgMerge(avg_v), 2) AS avg,
         min(min_v) AS min, max(max_v) AS max
  FROM sensor_daily WHERE sensor = 'th-1' GROUP BY t, metric ORDER BY metric, t`);
const okDay = same(dayGot, dayWant);

// month จาก hourly ต้องตรงกับ month จาก sensor_daily
const monthGot = await getStats({ sensor: "th-1", grain: "month", ...ALL });
const monthWant = await rows<Omit<StatsRow, "sum" | "diff">>(`
  SELECT toStartOfMonth(day) AS t, metric, toUInt32(countMerge(samples)) AS n, round(avgMerge(avg_v), 2) AS avg,
         min(min_v) AS min, max(max_v) AS max
  FROM sensor_daily WHERE sensor = 'th-1' GROUP BY t, metric ORDER BY metric, t`);
const okMonth = same(monthGot, monthWant);

// ผลรวม n รายปีต้องเท่ากับจำนวนจุดที่ insert (temp ของ th-1)
const okYear = year.reduce((s, r) => s + r.n, 0) === total;

// fleet temp = รวม th-1 + th-2: devices = 2, n รวมกัน, avg ถ่วงน้ำหนัก, min/max ของทั้งคู่
const temps = perDevice.filter((r) => r.metric === "temp");
const fleetTemp = fleet.find((r) => r.metric === "temp");
const weighted = temps.reduce((s, r) => s + r.avg * r.n, 0) / temps.reduce((s, r) => s + r.n, 0);
const okFleet =
  temps.length === 2 &&
  fleetTemp?.devices === 2 &&
  fleetTemp.n === temps[0]!.n + temps[1]!.n &&
  fleetTemp.min === Math.min(...temps.map((r) => r.min)) &&
  fleetTemp.max === Math.max(...temps.map((r) => r.max)) &&
  Math.abs(fleetTemp.avg - weighted) <= 0.01;
// device mode ต้องมีครบทุก sensor × metric (3 device: th-1/th-2 มี 2 metric, pm-1 มี 2)
const okDevice = perDevice.length === 6 && new Set(perDevice.map((r) => r.sensor)).size === 3;

console.assert(okDay && okMonth && okYear && okFleet && okDevice, "ผลไม่ตรง");
console.log(`\nday ตรงกับ sensor_daily: ${okDay} | month ตรงกับ sensor_daily: ${okMonth} | n รายปีรวม = ${total}: ${okYear}`);
console.log(`device ครบ 3 ตัว: ${okDevice} | fleet temp = รวม th-1 + th-2 (avg ถ่วงน้ำหนัก ${weighted.toFixed(2)}): ${okFleet}`);

// grain นอก whitelist ต้องถูกปฏิเสธ
const bad = await getStats({ sensor: "th-1", grain: "minute" as never, ...ALL }).catch((e: Error) => e.message);
console.log("grain ผิด:", bad);
const badBy = await getStats({ grain: "day", groupBy: "sensor; DROP TABLE x" as never, ...ALL }).catch((e: Error) => e.message);
console.log("groupBy ผิด:", badBy);
await ch.close();
