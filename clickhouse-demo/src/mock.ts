// device + metric จำลอง (10-simulator, 11-backfill ใช้ร่วมกัน)
// ค่า = base + shift + season·sin(วันในปี) + daily·sin(ชั่วโมงไทย, สูงสุดบ่าย 3) + noise·[-1, 1]
// shift = เลื่อนต่อ device ไม่เกิน ±noise (frequency ไม่หลุดจาก 50 Hz แต่ temp แต่ละตัวต่างกัน)
// counter = ค่าสะสม (เช่น kWh) เพิ่ม counter·rate หน่วยต่อชั่วโมง: ยอดใช้ต่อช่วง = max - min
type Metric = { base?: number; season?: number; daily?: number; noise?: number; counter?: number };

export const KINDS = {
  // เครื่องวัดอุณหภูมิ/ความชื้น
  th: {
    temp: { base: 27, season: 4, daily: 3, noise: 1 },
    humidity: { base: 60, season: -10, daily: -8, noise: 3 },
    dew_point: { base: 19, season: 3, daily: 1, noise: 0.5 },
    battery_v: { base: 3.6, noise: 0.05 },
    rssi: { base: -70, noise: 5 },
  },
  // มิเตอร์ไฟ 3 เฟส
  pm: {
    voltage_l1: { base: 230, daily: -2, noise: 1.5 },
    voltage_l2: { base: 231, daily: -2, noise: 1.5 },
    voltage_l3: { base: 229, daily: -2, noise: 1.5 },
    current_l1: { base: 15, season: 2, daily: 6, noise: 1 },
    current_l2: { base: 14, season: 2, daily: 6, noise: 1 },
    current_l3: { base: 16, season: 2, daily: 6, noise: 1 },
    power_kw: { base: 10, season: 1.5, daily: 4, noise: 0.5 },
    power_factor: { base: 0.92, daily: 0.03, noise: 0.02 },
    frequency: { base: 50, noise: 0.05 },
    energy_kwh: { counter: 10 },
  },
} satisfies Record<string, Record<string, Metric>>;
export type Kind = keyof typeof KINDS;

// สลับ th / pm: th-1, pm-1, th-2, pm-2, ...
// shift ∈ {-1, -0.5, 0, 0.5, 1}, rate 1.00-1.45 (device ใช้ไฟไม่เท่ากัน)
export const makeDevices = (n: number) =>
  Array.from({ length: n }, (_, i) => {
    const kind: Kind = i % 2 === 0 ? "th" : "pm";
    return { id: `${kind}-${Math.floor(i / 2) + 1}`, kind, shift: ((i % 5) - 2) * 0.5, rate: 1 + (i % 10) * 0.05 };
  });
export type Device = ReturnType<typeof makeDevices>[number];

const COUNTER_EPOCH = 1_600_000_000; // counter เริ่มนับจาก 2020-09-13

// สูตรฝั่ง JS (simulator) ต้องตรงกับ valueSql (backfill) ข้อมูลจะต่อกันไม่สะดุด
export function metricValue(m: Metric, d: Device, ts: number) {
  if (m.counter) return Math.round(((m.counter * d.rate * (ts - COUNTER_EPOCH)) / 3600) * 100) / 100;
  const t = new Date(ts * 1000);
  const dayOfYear = Math.floor((ts * 1000 - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400e3) + 1;
  const bkkHour = (t.getUTCHours() + 7) % 24;
  const v =
    (m.base ?? 0) + d.shift * (m.noise ?? 0) +
    (m.season ?? 0) * Math.sin((2 * Math.PI * dayOfYear) / 365) +
    (m.daily ?? 0) * Math.sin((2 * Math.PI * (bkkHour - 9)) / 24) +
    (m.noise ?? 0) * (Math.random() * 2 - 1);
  return Math.round(v * 100) / 100;
}

// payload ที่ device ส่ง (th มี status เป็น string: ไม่ใช่ตัวเลข MV จะตัดทิ้ง)
export const payload = (d: Device, ts: number) => ({
  ts,
  sensor: d.id,
  data: {
    ...Object.fromEntries(Object.entries(KINDS[d.kind]).map(([k, m]) => [k, metricValue(m, d, ts)])),
    ...(d.kind === "th" ? { status: "ok" } : {}),
  },
});

// ---- SQL (backfill สร้างข้อมูลฝั่ง server ไม่ผ่าน client) ----
// tuple ต่อ metric: (metric, base + shift, season, daily, noise, counter·rate)
const metricTuples = (d: Device) =>
  Object.entries(KINDS[d.kind] as Record<string, Metric>).map(
    ([k, m]) =>
      `('${k}', ${(m.base ?? 0) + d.shift * (m.noise ?? 0)}, ${m.season ?? 0}, ${m.daily ?? 0}, ${m.noise ?? 0}, ${(m.counter ?? 0) * d.rate})`,
  );

// สูตรเดียวกับ metricValue, noise ใช้ hash (sensor, metric, ts) แทน rand(): ได้ค่าต่างกันทุกจุด
const valueSql = (sensor: string, m: string) => `
  if(${m}.6 > 0,
     round(${m}.6 * (toUnixTimestamp(ts) - ${COUNTER_EPOCH}) / 3600, 2),
     round(${m}.2 + ${m}.3 * sin(2 * pi() * toDayOfYear(ts) / 365)
                  + ${m}.4 * sin(2 * pi() * (toHour(ts, 'Asia/Bangkok') - 9) / 24)
                  + ${m}.5 * (sipHash64(${sensor}, ${m}.1, ts) % 1000000 / 500000 - 1), 2))`;

const tsSql = `(SELECT toDateTime({from:UInt32}) + number AS ts FROM numbers({n:UInt64}))`;

// long format: (ts, sensor, metric, value) ทุก device × metric ต่อวินาที
export const longSql = (devices: Device[]) => `
  SELECT ts, s.1 AS sensor, s.2.1 AS metric, ${valueSql("s.1", "s.2")} AS value
  FROM ${tsSql}
  ARRAY JOIN [${devices.flatMap((d) => metricTuples(d).map((t) => `('${d.id}', ${t})`)).join(", ")}] AS s`;

// raw: (ts, sensor, data JSON) 1 แถวต่อ device ต่อวินาที
export const rawSql = (devices: Device[]) => `
  SELECT ts, d.1 AS sensor,
         concat('{', arrayStringConcat(arrayMap(m -> concat('"', m.1, '":', toString(${valueSql("d.1", "m")})), d.2), ','),
                if(d.3 = 'th', ',"status":"ok"', ''), '}')::JSON AS data
  FROM ${tsSql}
  ARRAY JOIN [${devices.map((d) => `('${d.id}', [${metricTuples(d).join(", ")}], '${d.kind}')`).join(", ")}] AS d`;
