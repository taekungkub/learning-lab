// helper ที่ 13-api-body, 14-aggregate ใช้ร่วมกัน
export type Agg = "mean" | "avg" | "sum" | "count" | "min" | "max" | "last" | "diff";
export const DAY = 86400;

// ISO → วินาที (UTC) / ไม่ถูกต้อง = error ที่อ่านรู้เรื่อง
export const toSec = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`เวลาไม่ถูกต้อง: ${iso}`);
  return t / 1000;
};

// วินาที → "YYYY-MM-DD HH:MM:SS" (UTC) สำหรับ query_params ของ ClickHouse
export const utc = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace("T", " ");
