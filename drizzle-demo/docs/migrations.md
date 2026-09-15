# Drizzle Migrations (drizzle-kit)

## Workflow หลัก: generate → migrate

```
แก้ src/schema.ts
        │
        ▼
bun run db:generate   ← เทียบ schema.ts กับ migration history เดิม
        │                สร้างไฟล์ .sql ใหม่ใน drizzle/ (ยังไม่แตะ database)
        ▼
bun run db:migrate    ← รันไฟล์ .sql ที่ยังไม่เคย apply เข้า database จริง
```

**สำคัญ**: `db:migrate` ไม่ได้อ่าน `schema.ts` ตรงๆ มันอ่านแค่ไฟล์ `.sql` ใน `drizzle/`
เท่านั้น ถ้าข้าม `db:generate` จะไม่มีไฟล์ใหม่ให้รัน — database จะไม่เปลี่ยนอะไรเลย
แม้ schema.ts จะแก้ไปแล้วก็ตาม

## generate vs migrate vs push

| คำสั่ง | ทำอะไร | มี migration file ไหม | ใช้ตอนไหน |
|---|---|---|---|
| `drizzle-kit generate` | สร้างไฟล์ `.sql` จาก diff schema | สร้างไฟล์ แต่ยังไม่ apply | ทุกครั้งที่แก้ schema แล้วต้องการเก็บ history |
| `drizzle-kit migrate` | รันไฟล์ `.sql` ที่ค้างอยู่เข้า database | ใช้ไฟล์ที่มีอยู่แล้ว | apply migration เข้า database (local หรือ production ก็ได้) |
| `drizzle-kit push` | diff schema กับ database ตรงๆ แล้ว apply ทันที | **ไม่มี** ไฟล์เกิดขึ้นเลย | prototyping เร็วๆ ตอนยังไม่แน่ใจ schema |

`push` ไม่ได้ผูกกับ local อย่างเดียว — ใช้ได้ทุกที่ที่ต่อ database ถึง แต่เพราะมันไม่เก็บ
history และ apply ทันทีโดยไม่ให้ review ก่อน จึงไม่เหมาะกับ production/ทีม

## ตัวอย่างจริงในโปรเจกต์นี้

1. เพิ่ม column `bio` ใน `users` (`src/schema.ts`)
2. รัน `bun run db:generate` → ได้ไฟล์ใหม่ เช่น `drizzle/0001_xxxx.sql` ที่มี
   `ALTER TABLE users ADD COLUMN bio text;`
3. รัน `bun run db:migrate` → column `bio` ถูกเพิ่มเข้า `drizzle-demo.sqlite` จริง
4. เปิด `bun run db:studio` เพื่อตรวจสอบผลลัพธ์

## คำสั่งอื่นที่เกี่ยวข้อง

- `bun run db:studio` — เปิด GUI ดูข้อมูลและ schema ปัจจุบันใน database
- `bun run reset` — ลบไฟล์ database แล้ว `migrate` ใหม่ทั้งหมดตั้งแต่ต้น (ใช้ตอนอยาก
  เริ่มนับหนึ่งใหม่ตอนฝึก)
- `bun run db:sync` — ทำ `generate` แล้วต่อด้วย `migrate` ในคำสั่งเดียว (shortcut เวลา
  ขี้เกียจพิมพ์สองรอบ แต่ผลเหมือนกันทุกอย่าง ยังได้ migration file เหมือนเดิม)

## ข้อควรระวัง

- ห้ามแก้ไฟล์ `.sql` ที่ generate ไปแล้วและ apply ไปแล้ว (commit ไปแล้ว/รันบน database
  อื่นไปแล้ว) — ถ้าต้องแก้ ให้ generate migration ใหม่ทับแทน
- ถ้า schema.ts เปลี่ยนหลายครั้งก่อน generate จะได้ 1 ไฟล์ที่รวมทุกการเปลี่ยนแปลงไว้
  ไม่ใช่แยกไฟล์ตามแต่ละครั้งที่แก้
- migration conflicts เกิดเมื่อมีคนสร้าง migration คนละไฟล์จาก schema จุดเดียวกัน
  (เช่นทำงานคนละ branch) ต้อง merge schema แล้ว generate ใหม่ ไม่ใช่ merge ไฟล์ `.sql` เอง

## Q&A

**Q: ต้อง generate ก่อนเสมอไหม ถึงจะ migrate ได้?**
A: ใช่ `migrate` อ่านแค่ไฟล์ `.sql` ใน `drizzle/` เท่านั้น ไม่ได้อ่าน `schema.ts` ตรงๆ
ถ้าไม่ generate ก่อน จะไม่มีไฟล์ใหม่ให้รัน database จะไม่เปลี่ยนอะไรเลย

**Q: แล้ว push ทำไมขึ้นเลยได้โดยไม่ต้อง generate?**
A: เพราะ `push` ทำงานคนละแบบ — มันอ่าน `schema.ts` ตรงๆ แล้ว diff กับ database ที่ต่อ
อยู่ ณ ตอนนั้น แล้ว apply ทันที ไม่ผ่านไฟล์ `.sql` เลย จึงเร็วแต่ไม่มี history เก็บไว้

**Q: db:push ใช้ได้เฉพาะ local เท่านั้นหรอ?**
A: ไม่จำเป็น ใช้ได้กับ database ที่ไหนก็ได้ที่ต่อถึง แต่ไม่แนะนำกับ production/ทีม
เพราะ apply ทันทีไม่มีขั้นตอน review และไม่มี record ว่าเปลี่ยนอะไรไปบ้าง

**Q: ถ้าลืม generate แล้วรัน migrate เลย จะ error ไหม?**
A: ไม่ error แค่ไม่มีอะไรเกิดขึ้น เพราะไม่มีไฟล์ migration ใหม่ให้ apply — เป็นสาเหตุ
ที่พบบ่อยตอนงงว่า "ทำไมแก้ schema แล้ว column ไม่ขึ้นใน database"

**Q: migration file เก่าที่ apply ไปแล้ว แก้ไขย้อนหลังได้ไหม?**
A: ไม่ควร ถ้ามันถูก apply ไปแล้ว (โดยเฉพาะบน database อื่นหรือถูก commit ไปแล้ว)
ให้แก้ schema แล้ว `generate` ไฟล์ใหม่ทับแทนเสมอ

**Q: ถ้าแก้ schema.ts หลายจุดก่อน generate จะได้กี่ไฟล์?**
A: ได้ไฟล์เดียว ที่รวมทุกการเปลี่ยนแปลงตั้งแต่ครั้งล่าสุดที่ generate ไว้ ไม่ได้แยกไฟล์
ตามแต่ละจุดที่แก้

**Q: ลืมว่า migration ไหน apply ไปแล้วบ้าง เช็คยังไง?**
A: drizzle-kit เก็บ state ไว้ในตาราง `__drizzle_migrations` ในตัว database เอง (หรือใน
`drizzle/meta/_journal.json` ฝั่งไฟล์) ไม่ต้องเช็คเอง แค่รัน `db:migrate` มันจะรู้เองว่า
ไฟล์ไหนยังไม่ได้ apply
