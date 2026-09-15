# drizzle-demo

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.10. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

## Drizzle ORM examples

- `docs/learning-plan.md` — checklist ของหัวข้อที่ต้องเรียน
- `src/schema.ts` — schema (users, posts, comments) พร้อม relations
- `src/db.ts` — db client (libsql, ไฟล์ `drizzle-demo.sqlite`)
- `drizzle.config.ts` — config สำหรับ drizzle-kit
- `examples/01-08` — ตัวอย่าง insert, select, update/delete, relational query, joins, aggregate, transactions, prepared statements (รันเรียงตามเลขได้เลย)

```bash
bun run db:generate   # สร้าง migration จาก schema.ts
bun run db:migrate    # apply migration
bun run db:studio     # เปิด GUI ดูข้อมูล
bun run reset         # ลบ db แล้ว migrate ใหม่

bun run examples/01-insert.ts
bun run examples/02-select.ts
# ... ไปเรื่อยๆ ถึง 08
```
