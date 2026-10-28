// bun run examples/11-backfill.ts   (ต้องรัน 08 ก่อน: ใช้ schema sensor_*)
// mock ข้อมูลย้อนหลัง 5 ปี รายวินาที ของ 10 device (device เดียวกับ 10-simulator)
// แต่ละตารางมีข้อมูลเต็มช่วง TTL ของตัวเอง (src/config.ts) เหมือนระบบที่รันมาแล้ว 5 ปี:
//   sensor_raw     ช่วง TTL.raw ล่าสุด          payload JSON  MV ต่อเป็น long → hourly → daily
//   sensor_long    TTL.raw .. TTL.long          ค่าดิบ         MV ต่อเป็น hourly → daily
//   sensor_hourly  TTL.long .. TTL.hourly       aggregate รายวินาทีฝั่ง server  MV ต่อเป็น daily
//   sensor_daily   TTL.hourly .. 5 ปี            aggregate รายวินาทีตรงเป็นรายวัน
// ไม่สร้างข้อมูลที่ TTL จะลบทิ้งอยู่ดี เช่นไม่เขียน hourly เก่ากว่า TTL.hourly
// insert ทีละ 30 วัน: client timeout 30 วิ, ยิ่งก้อนใหญ่ยิ่งเสี่ยง
import { ch, rows } from "../src/ch";
import { TTL } from "../src/config";

const YEARS = 5;

// [base, ฤดู (ตามวันในปี), รอบวัน (ตามชั่วโมงไทย), noise]
const METRICS = {
  th: { temp: [27, 4, 3, 1], humidity: [60, -10, -8, 3] },
  pm: { voltage: [220, 0, -2, 1.5], current: [3, 0.5, 2, 0.5] },
} as const;
const devices = Array.from({ length: 10 }, (_, i) =>
  i % 2 === 0 ? { id: `th-${i / 2 + 1}`, kind: "th" as const } : { id: `pm-${(i + 1) / 2}`, kind: "pm" as const },
);

// seed แยกต่อ metric: rand() ที่ argument เหมือนกันใน query เดียวถูกคำนวณครั้งเดียว ค่าจะซ้ำกัน
const valueSql = (p: readonly number[], offset: number, seed: number) =>
  `round(${p[0]! + offset} + ${p[1]} * sin(2 * pi() * toDayOfYear(ts) / 365)
         + ${p[2]} * sin(2 * pi() * (toHour(ts, 'Asia/Bangkok') - 9) / 24)
         + ${p[3]} * (2 * rand(${seed}) / 4294967295 - 1), 1)`;

// long format ทั้ง 20 series (10 device × 2 metric)
const series = devices.flatMap((d, di) =>
  Object.entries(METRICS[d.kind]).map(([metric, p]) => ({ sensor: d.id, metric, p, offset: di * 0.3 })),
);
const longSql = `
  SELECT ts, s.1 AS sensor, s.2 AS metric,
         multiIf(${series.map((x, i) => `s.3 = ${i}, ${valueSql(x.p, x.offset, 1)}`).join(", ")}, 0) AS value
  FROM (SELECT toDateTime({from:UInt32}) + number AS ts FROM numbers({n:UInt64}))
  ARRAY JOIN [${series.map((x, i) => `('${x.sensor}', '${x.metric}', ${i})`).join(", ")}] AS s`;

// payload JSON ต่อ device (th มี status เหมือนของจริง)
const payloadSql = devices
  .map((d, di) => {
    const [a, b] = Object.entries(METRICS[d.kind]);
    const extra = d.kind === "th" ? `, ',"status":"ok"'` : "";
    return `s.2 = ${di}, concat('{"${a![0]}":', toString(${valueSql(a![1], di * 0.3, 1)}),
                               ',"${b![0]}":', toString(${valueSql(b![1], di * 0.3, 2)})${extra}, '}')`;
  })
  .join(", ");
const rawSql = `
  SELECT ts, s.1 AS sensor, multiIf(${payloadSql}, '{}')::JSON AS data
  FROM (SELECT toDateTime({from:UInt32}) + number AS ts FROM numbers({n:UInt64}))
  ARRAY JOIN [${devices.map((d, i) => `('${d.id}', ${i})`).join(", ")}] AS s`;

// ขอบของแต่ละช่วง (ต้นชั่วโมงปัจจุบัน: 10-simulator ต่อจากนี้ได้เลย)
const DAY = 86400;
const now = Math.floor(Date.now() / 1000 / 3600) * 3600;
const yearsAgo = (y: number) => {
  const d = new Date(now * 1000);
  d.setUTCFullYear(d.getUTCFullYear() - y);
  return d.getTime() / 1000;
};
const t7 = now - TTL.raw.days * DAY;
const t30 = now - TTL.long.days * DAY;
const t2y = yearsAgo(TTL.hourly.years);
const t5y = yearsAgo(YEARS);

const TIERS = [
  {
    table: "sensor_daily", from: t5y, to: t2y, chunk: 30 * DAY,
    sql: `INSERT INTO sensor_daily
          SELECT toDate(ts, 'Asia/Bangkok') AS day, sensor, metric,
                 countState() AS samples, avgState(value) AS avg_v, min(value) AS min_v, max(value) AS max_v
          FROM (${longSql}) GROUP BY day, sensor, metric`,
  },
  {
    table: "sensor_hourly", from: t2y, to: t30, chunk: 30 * DAY,
    sql: `INSERT INTO sensor_hourly
          SELECT toStartOfHour(ts) AS hour, sensor, metric,
                 countState() AS samples, avgState(value) AS avg_v, min(value) AS min_v, max(value) AS max_v
          FROM (${longSql}) GROUP BY hour, sensor, metric`,
  },
  { table: "sensor_long", from: t30, to: t7, chunk: DAY, sql: `INSERT INTO sensor_long ${longSql}` },
  { table: "sensor_raw", from: t7, to: now, chunk: DAY, sql: `INSERT INTO sensor_raw ${rawSql}` },
];

for (const t of ["sensor_raw", "sensor_long", "sensor_hourly", "sensor_daily"]) await ch.command({ query: `TRUNCATE TABLE ${t}` });

const fmt = (s: number) => new Date(s * 1000).toISOString().slice(0, 10);
for (const tier of TIERS) {
  const t0 = performance.now();
  let chunks = 0;
  for (let from = tier.from; from < tier.to; from += tier.chunk) {
    await ch.command({ query: tier.sql, query_params: { from, n: Math.min(tier.chunk, tier.to - from) } });
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
    UNION ALL SELECT 'sensor_hourly', count(), toDate(min(hour)), toDate(max(hour)) FROM sensor_hourly
    UNION ALL SELECT 'sensor_daily', count(), min(day), max(day) FROM sensor_daily`),
);
console.table(
  await rows(`
    SELECT table, formatReadableSize(sum(bytes_on_disk)) AS size, count() AS parts
    FROM system.parts WHERE database = 'demo' AND active AND table LIKE 'sensor_%'
    GROUP BY table ORDER BY table`),
);

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
