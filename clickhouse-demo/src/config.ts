// TTL ของตาราง sensor_* (examples 08, 11 ใช้ร่วมกัน)
// แก้ที่นี่แล้วรัน 08 ใหม่ (สร้างตารางใหม่) หรือ ALTER TABLE ... MODIFY TTL กับตารางที่มีอยู่
// ต้องเรียงสั้นไปยาวตามชั้น: rollup ถูกเขียนตอน insert แล้ว ลบชั้นล่างไม่กระทบชั้นบน
// daily ไม่มี TTL (เก็บตลอด)
export const TTL = {
  raw: { days: 7 }, // payload JSON เดิม ไว้ debug (ซ้ำกับ long)
  long: { days: 30 }, // ค่าดิบรายวินาที ดูช่วงสั้น
  hourly: { years: 2 }, // กราฟรายชั่วโมง
} as const;

// TTL เป็น SQL interval
export const ttlSql = (t: { days: number } | { years: number }) =>
  "days" in t ? `INTERVAL ${t.days} DAY` : `INTERVAL ${t.years} YEAR`;
