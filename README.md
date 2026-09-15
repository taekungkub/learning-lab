# learning-lab

พื้นที่ฝึกและทดลองเรื่องต่างๆ ที่กำลังเรียนรู้ แยกเป็นโฟลเดอร์ตาม topic — ไม่ผูกกับเทคโนโลยีเดียว

## Topics

- [`drizzle-demo/`](./drizzle-demo) — ฝึก Drizzle ORM (schema, migrations, relations,
  query API) บน Bun + SQLite (libsql) ดู `drizzle-demo/README.md` และ
  `drizzle-demo/docs/` สำหรับรายละเอียด

## แนวทางการเพิ่ม topic ใหม่

แต่ละ topic เป็นโฟลเดอร์แยกอิสระ มีโครงสร้างในตัวเองประมาณนี้:

```
<topic-name>/
  docs/          # บันทึกความเข้าใจ, checklist, Q&A
  examples/      # โค้ดตัวอย่างรันได้จริง เรียงเลข 01, 02, ...
  README.md      # สรุปสั้นๆ ว่า topic นี้คืออะไร รันยังไง
```

พอเพิ่ม topic ใหม่แล้ว อย่าลืมมาเพิ่ม link ไว้ในลิสต์ด้านบนของไฟล์นี้ด้วย
