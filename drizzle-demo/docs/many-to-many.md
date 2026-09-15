# Many-to-Many (Junction Table)

## ปัญหาที่ต้องแก้

อยากให้ `post` หนึ่งมีได้หลาย `tag` และ `tag` หนึ่งก็ใช้กับหลาย `post` ได้ — จะเก็บยังไง?

**วิธีที่ทำไม่ได้ / ไม่ควรทำ:**
- เก็บ `tagId` เป็น column เดียวใน `posts` → post มีได้แค่ 1 tag เท่านั้น
- เก็บ tags เป็น string คั่น comma (`"drizzle,typescript"`) → join ไม่ได้, นับไม่ได้,
  หา "post ที่มี tag X" แบบ type-safe/index ไม่ได้

## ทางแก้: Junction Table

สร้างตารางกลางที่เก็บแค่คู่ `(postId, tagId)` แต่ละแถวแทนความสัมพันธ์ 1 คู่:

```
posts          post_tags              tags
─────          ──────────             ────
id=1 ──┬──> postId=1, tagId=1 <──┬── id=1 "drizzle"
       └──> postId=1, tagId=2 <──┤
id=2 ──────> postId=2, tagId=2 <──┘── id=2 "typescript"
```

หลักการคือแตกความสัมพันธ์ "หลายต่อหลาย" ออกเป็น **2 ความสัมพันธ์ one-to-many** ผ่าน
ตารางกลาง (`posts → postTags` และ `tags → postTags`)

ดูตัวอย่างจริงในโปรเจกต์นี้ได้ที่ `src/schema.ts` (ตาราง `tags`, `postTags`) และ
`examples/09-many-to-many.ts` (query, insert, delete ผ่าน junction table)

## composite primary key

`postTags` ใช้ primary key แบบ composite `(postId, tagId)` แทนที่จะมี `id` ของตัวเอง:

```ts
(table) => [primaryKey({ columns: [table.postId, table.tagId] })]
```

กันไม่ให้ผูก tag เดียวกันซ้ำกับ post เดียวกัน 2 รอบโดยไม่ตั้งใจ

## ชื่อเรียก pattern นี้

เป็น pattern มาตรฐานสากล ใช้เหมือนกันทุกระบบ relational database (Postgres, MySQL,
SQLite) ไม่ใช่เฉพาะ Drizzle — มีชื่อเรียกหลายแบบแล้วแต่ที่:
- junction table
- join table
- associative table
- bridge table / pivot table (Laravel เรียกแบบนี้)

## ตัวอย่างที่เจอได้ทั่วไป

| ความสัมพันธ์ | junction table |
|---|---|
| users ↔ roles | `user_roles` (permission system) |
| students ↔ courses | `enrollments` |
| products ↔ orders | `order_items` |
| posts ↔ tags | `post_tags` (โปรเจกต์นี้) |
| users ↔ teams | `team_members` |

## ขั้นกว่า: junction table ที่มี column เสริม

บางครั้ง junction table ไม่ได้มีแค่ 2 foreign key เฉยๆ แต่เก็บข้อมูลเฉพาะของ
ความสัมพันธ์คู่นั้นด้วย เช่น:

- `enrollments` อาจมี `enrolledAt`, `grade`
- `order_items` อาจมี `quantity`, `price`
- `post_tags` อาจมี `addedAt`, `addedBy`

ถ้าอยากฝึกต่อ ลองเพิ่ม column เช่น `addedAt` เข้าไปใน `postTags` แล้ว generate/migrate
ดูได้เลย
