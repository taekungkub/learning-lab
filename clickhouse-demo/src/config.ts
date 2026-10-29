// TTL ของตาราง sensor_* (examples 08, 11 ใช้ร่วมกัน)
// แก้ที่นี่แล้วรัน 08 ใหม่ (สร้างตารางใหม่) หรือ ALTER TABLE ... MODIFY TTL กับตารางที่มีอยู่
// ต้องเรียงสั้นไปยาวตามชั้น: rollup ถูกเขียนตอน insert แล้ว ลบชั้นล่างไม่กระทบชั้นบน
// daily ไม่มี TTL (เก็บตลอด)
//
// ขนาด disk ที่ 10k device ส่งทุก 1 วิ (ประมาณจาก mock 10 device คูณขึ้น):
//
//   ตาราง   ต่อวัน        เก็บ       รวม
//   long    ~12 GiB     3 วัน     ~36 GiB       (เดิม 7 วัน ~85 GiB, 30 วัน ~350 GiB)
//   raw     ~4.4 GiB    3 วัน     ~13 GiB       (เดิม 7 วัน ~31 GiB)
//   1m      ~2 GiB      3 วัน     ~6 GiB        (ค้างสูงสุด ~8 GiB: นับ partition วันนี้ที่ยังเขียนอยู่ด้วย)
//   hourly  ~35 MiB     2 ปี      ~25 GiB       (730 วัน)
//   daily   ~1 MiB      ตลอด     ~350 MiB/ปี    (โตช้า ไม่ต้อง TTL)
//
// คำนวณจาก 10k device × ~7.5 metric = 75k series:
//   1m      × 1,440 แถว/วัน × ~18 B
//   hourly  × 24 แถว/วัน    × ~20 B
export const TTL = {
  raw: { days: 3 }, // payload JSON เดิม ไว้ debug (ซ้ำกับ long)
  long: { days: 3 }, // ค่าดิบรายวินาที ดูช่วงสั้น (เกินนี้ใช้ hourly) ตอนนี้เท่า raw
  m1: { days: 3 }, // สรุปราย 1 นาที (interval 1m-30m) แยกกิ่งจาก long ไม่ได้ป้อน hourly สั้นกว่า long ได้
  hourly: { years: 2 }, // กราฟรายชั่วโมง
} as const;

// TTL เป็น SQL interval
export const ttlSql = (t: { days: number } | { years: number }) =>
  "days" in t ? `INTERVAL ${t.days} DAY` : `INTERVAL ${t.years} YEAR`;
