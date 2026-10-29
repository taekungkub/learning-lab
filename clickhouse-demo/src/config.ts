// TTL ของตาราง sensor_* (examples 08, 11 ใช้ร่วมกัน)
// แก้ที่นี่แล้วรัน 08 ใหม่ (สร้างตารางใหม่) หรือ ALTER TABLE ... MODIFY TTL กับตารางที่มีอยู่
// ต้องเรียงสั้นไปยาวตามชั้น: rollup ถูกเขียนตอน insert แล้ว ลบชั้นล่างไม่กระทบชั้นบน
// daily ไม่มี TTL (เก็บตลอด)
// ขนาดที่ 10k device ส่งทุก 1 วิ (ประมาณจาก mock 10 device): long ~12 GiB/วัน, raw ~4.4 GiB/วัน
// long 30 วัน ~350 GiB → 7 วัน ~85 GiB / raw 7 วัน ~31 GiB → 3 วัน ~13 GiB
export const TTL = {
  raw: { days: 3 }, // payload JSON เดิม ไว้ debug (ซ้ำกับ long)
  long: { days: 7 }, // ค่าดิบรายวินาที ดูช่วงสั้น (เกินนี้ใช้ hourly)
  hourly: { years: 2 }, // กราฟรายชั่วโมง
} as const;

// TTL เป็น SQL interval
export const ttlSql = (t: { days: number } | { years: number }) =>
  "days" in t ? `INTERVAL ${t.days} DAY` : `INTERVAL ${t.years} YEAR`;
