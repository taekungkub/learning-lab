// bun run examples/11-backfill.ts   (ต้องรัน 08 ก่อน: ใช้ schema sensor_*)
// DEVICES=100 bun run examples/11-backfill.ts  (default 10 device ใช้เวลาเพิ่มตามจำนวน)
// mock ข้อมูลย้อนหลัง YEARS ปี (default 3) รายวินาที device/metric จาก src/mock.ts (ชุดเดียวกับ 10-simulator)
// sensor_1m ไม่ต้อง backfill แยก: MV จาก long สร้างให้ตอนเขียนช่วง long + raw (เกิน TTL.m1 ถูกลบตอน merge)
// แต่ละตารางมีข้อมูลเต็มช่วง TTL ของตัวเอง (src/config.ts) เหมือนระบบที่รันมาแล้ว 5 ปี:
//   sensor_raw     ช่วง TTL.raw ล่าสุด          payload JSON  MV ต่อเป็น long → hourly → daily
//   sensor_long    TTL.raw .. TTL.long          ค่าดิบ         MV ต่อเป็น hourly → daily
//   sensor_hourly  TTL.long .. TTL.hourly       aggregate ฝั่ง server  MV ต่อเป็น daily
//   sensor_daily   TTL.hourly .. YEARS          aggregate ตรงเป็นรายวัน
// ไม่สร้างข้อมูลที่ TTL จะลบทิ้งอยู่ดี เช่นไม่เขียน hourly เก่ากว่า TTL.hourly
//
// hourly/daily สร้างค่าทุก COARSE วิ แล้วนับแต่ละค่าเป็น COARSE จุด (state ของค่าซ้ำ):
// n ยังเท่ารายวินาที, avg แทบเท่าเดิม, min/max แคบลงนิดหน่อย (noise สุดขั้วถูกสุ่มเจอน้อยลง)
// วัดช่วง 10 วัน: รายวินาที 7.8s → ทุก 60 วิ 0.27s  ตั้ง COARSE=1 ถ้าต้องการรายวินาทีจริง
// insert ทีละก้อน: client timeout 30 วิ
import { ch, rows } from "../src/ch";
import { TTL } from "../src/config";
import { longSql, makeDevices, rawSql } from "../src/mock";

// เกิน TTL.hourly (2 ปี) มีแค่ใน sensor_daily: 3 ปีพอให้เห็นรายปีเกินช่วง hourly
const YEARS = Number(process.env.YEARS ?? 3);
const COARSE = Number(process.env.COARSE ?? 60);
const devices = makeDevices(Number(process.env.DEVICES ?? 10));
const LONG = longSql(devices);

// ขอบของแต่ละช่วง (ต้นชั่วโมงปัจจุบัน: 10-simulator ต่อจากนี้ได้เลย)
const DAY = 86400;
const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
const yearsAgo = (y: number) => {
  const d = new Date(now * 1000);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return d.getTime() / 1000;
};
const tRaw = now - TTL.raw.days * DAY;
const tLong = now - TTL.long.days * DAY;
const tHourly = yearsAgo(TTL.hourly.years);
const tStart = yearsAgo(YEARS);

// แต่ละค่า = state ของ COARSE ค่าซ้ำ แล้ว merge ต่อ bucket
const agg = (bucket: string) =>
  `countMergeState(arrayReduce('countState', arrayWithConstant(${COARSE}, value))) AS samples,
   avgMergeState(arrayReduce('avgState', arrayWithConstant(${COARSE}, value))) AS avg_v,
   min(value) AS min_v, max(value) AS max_v, argMaxState(value, ts) AS last_v
   FROM (${longSql(devices, COARSE)}) GROUP BY ${bucket}, sensor, metric`;
// step = วินาทีต่อจุด: n ที่ส่งเข้า numbers() = ช่วงเวลา ÷ step
const TIERS = [
  { table: "sensor_daily", from: tStart, to: tHourly, chunk: 60 * DAY, step: COARSE,
    sql: `INSERT INTO sensor_daily SELECT toDate(ts, 'Asia/Bangkok') AS day, sensor, metric, ${agg("day")}` },
  { table: "sensor_hourly", from: tHourly, to: tLong, chunk: 60 * DAY, step: COARSE,
    sql: `INSERT INTO sensor_hourly SELECT toStartOfHour(ts) AS hour, sensor, metric, ${agg("hour")}` },
  { table: "sensor_long", from: tLong, to: tRaw, chunk: DAY / 4, step: 1, sql: `INSERT INTO sensor_long ${LONG}` },
  { table: "sensor_raw", from: tRaw, to: now, chunk: DAY / 4, step: 1, sql: `INSERT INTO sensor_raw ${rawSql(devices)}` },
];

for (const t of ["sensor_raw", "sensor_long", "sensor_1m", "sensor_hourly", "sensor_daily"])
  await ch.command({ query: `TRUNCATE TABLE ${t}` });

const fmt = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
for (const tier of TIERS) {
  const t0 = performance.now();
  let chunks = 0;
  for (let from = tier.from; from < tier.to; from += tier.chunk) {
    const n = Math.ceil(Math.min(tier.chunk, tier.to - from) / tier.step);
    await ch.command({ query: tier.sql, query_params: { from, n } });
    chunks++;
  }
  const sec = (performance.now() - t0) / 1000;
  console.log(`${tier.table.padEnd(13)} ${fmt(tier.from)} .. ${fmt(tier.to)}  ${chunks} insert  ${sec.toFixed(1)}s`);
}

console.log("\nข้อมูลในแต่ละตาราง:");
console.table(
  await rows(`
    SELECT 'sensor_raw' AS table, count() AS rows, toDate(min(ts)) AS from, toDate(max(ts)) AS to FROM sensor_raw
    UNION ALL SELECT 'sensor_long', count(), toDate(min(ts)), toDate(max(ts)) FROM sensor_long
    UNION ALL SELECT 'sensor_1m', count(), toDate(min(minute)), toDate(max(minute)) FROM sensor_1m
    UNION ALL SELECT 'sensor_hourly', count(), toDate(min(hour)), toDate(max(hour)) FROM sensor_hourly
    UNION ALL SELECT 'sensor_daily', count(), min(day), max(day) FROM sensor_daily`),
);
console.table(
  await rows(`
    SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, count() AS parts
    FROM system.parts WHERE database = 'demo' AND active AND table LIKE 'sensor_%'
    GROUP BY table ORDER BY table`),
);
console.log("metric ต่อ device:");
console.table(await rows("SELECT sensor, groupArray(DISTINCT metric) AS metrics FROM sensor_long WHERE sensor IN ('th-1', 'pm-1') GROUP BY sensor"));

// self-check: ทุกวันใน daily ของ th-1 temp ต้องครบ 86,400 จุด (4 ช่วงต่อกันไม่ซ้ำ ไม่ขาด)
// ยกเว้นวันแรก/วันสุดท้ายที่เริ่ม/จบกลางวัน
const [c] = await rows<{ days: number; bad: number }>(`
  SELECT count() AS days, countIf(n != 86400) AS bad FROM (
    SELECT day, countMerge(samples) AS n FROM sensor_daily
    WHERE sensor = 'th-1' AND metric = 'temp'
    GROUP BY day
    HAVING day > (SELECT min(day) FROM sensor_daily) AND day < (SELECT max(day) FROM sensor_daily))`);
console.assert(c?.bad === 0, "มีวันที่จำนวนจุดไม่ครบ 86,400");
console.log(`daily th-1 temp: ${c?.days} วัน, วันที่ไม่ครบ 86,400 จุด: ${c?.bad}`);
await ch.close();
