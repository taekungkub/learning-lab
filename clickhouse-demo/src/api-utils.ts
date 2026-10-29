// helper ที่ 13-api-body, 14-aggregate ใช้ร่วมกัน
import { TTL } from "./config";

export type Agg = "mean" | "avg" | "sum" | "count" | "min" | "max" | "last" | "diff";
export const DAY = 86400;
export const HOURLY_MAX_AGE = TTL.hourly.years * 365 * DAY; // ย้อนหลังสุดที่ sensor_hourly เก็บ (วินาที)

// ISO → วินาที (UTC)
export const toSec = (iso: string) => {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) throw new Error(`เวลาไม่ถูกต้อง: ${iso}`);
  return t / 1000;
};

// วินาที → "YYYY-MM-DD HH:MM:SS" (UTC) สำหรับ query_params
export const utc = (s: number) => new Date(s * 1000).toISOString().slice(0, 19).replace("T", " ");

// DateTime จาก ClickHouse ("YYYY-MM-DD HH:MM:SS", UTC) → ISO "…Z"
export const isoZ = (t: string) => `${t.replace(" ", "T")}Z`;
