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

## เทคนิคตั้งชื่อ junction table

เลือกชื่อตามว่าความสัมพันธ์นั้น "มีความหมายทางธุรกิจเป็นของตัวเอง" หรือไม่

### แบบที่ 1: ชื่อรวม 2 ตาราง (generic)

ใช้เมื่อความสัมพันธ์เป็นแค่ "การเชื่อมข้อมูล" ล้วนๆ ไม่มีความหมายพิเศษของตัวเอง

```
post_tags     (posts + tags)
user_roles    (users + roles)
team_members  (teams + members)
```

หลักตั้งชื่อ: `<table1>_<table2>` เรียงตามตัวที่ "เป็นเจ้าของ" มากกว่า (เช่น
`post_tags` ไม่ใช่ `tag_posts` เพราะ post เป็นตัวหลักที่ถูกแปะ tag)

### แบบที่ 2: ชื่อเฉพาะ (semantic/domain name)

ใช้เมื่อความสัมพันธ์นั้นเป็น **concept ที่มีความหมายจริงในธุรกิจ** ไม่ใช่แค่ join
table เฉยๆ — เช่น `enrollments` (students + courses) คำว่า "การลงทะเบียน" เป็น
แนวคิดจริง ไม่ใช่แค่เชื่อมข้อมูล

```
enrollments    (students + courses) — "การลงทะเบียน"
order_items    (orders + products)  — "รายการสินค้าในออเดอร์"
subscriptions  (users + plans)      — "การสมัครสมาชิก"
bookings       (users + rooms)      — "การจอง"
```

**สัญญาณว่าควรใช้ชื่อเฉพาะ**: ถ้า junction table มี column เสริมนอกจาก FK 2 ตัว (เช่น
`enrolledAt`, `grade`, `quantity`, `price`) แปลว่ามันมีข้อมูลของตัวเองจริง ไม่ใช่แค่
"การเชื่อม" แล้ว — เป็น entity จริงในระบบ ควรตั้งชื่อที่สื่อความหมาย

### กฎสรุป

> junction table เปล่าๆ (มีแค่ FK 2 ตัว) → ตั้งชื่อรวม 2 ตาราง
> junction table ที่มีข้อมูลของตัวเอง → ตั้งชื่อเฉพาะแบบ entity จริง

`postTags` ในโปรเจกต์นี้ตอนนี้มีแค่ `postId` + `tagId` → เหมาะกับชื่อ generic ตามที่
ใช้อยู่แล้ว แต่ถ้าเพิ่ม `addedAt`/`addedBy` ตามหัวข้อก่อนหน้า ก็เริ่มมีเหตุผลให้พิจารณา
เปลี่ยนเป็นชื่อที่สื่อความหมายมากขึ้น — เป็น judgment call ไม่มีกฎตายตัว 100%

### ตัวอย่างชื่อเฉพาะ (semantic) แยกตาม domain

**Education**
- `enrollments` (students ↔ courses) — การลงทะเบียนเรียน
- `attendances` (students ↔ classes) — การเข้าเรียน (มักมี `checkedInAt`, `status`)
- `submissions` (students ↔ assignments) — การส่งงาน

**E-commerce**
- `order_items` (orders ↔ products) — รายการสินค้าในออเดอร์ (มี `quantity`, `price`)
- `cart_items` (carts ↔ products) — สินค้าในตะกร้า
- `reviews` (users ↔ products) — รีวิว (มี `rating`, `comment`)
- `wishlist_items` (users ↔ products) — สินค้าที่บันทึกไว้

**SaaS / Subscription**
- `subscriptions` (users ↔ plans) — การสมัครสมาชิก (มี `startedAt`, `expiresAt`, `status`)
- `invitations` (users ↔ organizations) — คำเชิญเข้าองค์กร (มี `invitedAt`, `acceptedAt`)
- `memberships` (users ↔ organizations) — สถานะสมาชิกภาพ (มี `role`, `joinedAt`)

**Social / Content**
- `follows` (users ↔ users, self-referencing) — การติดตาม (มี `followedAt`)
- `likes` (users ↔ posts) — การกดไลก์ (มี `likedAt`)
- `bookmarks` (users ↔ posts) — การบันทึก

**Booking / Reservation**
- `bookings` (users ↔ rooms/tables/slots) — การจอง (มี `startTime`, `endTime`, `status`)
- `reservations` (users ↔ events) — การจองคิว/ที่นั่ง

**HR / Workforce**
- `assignments` (employees ↔ projects) — การมอบหมายงาน (มี `role`, `allocatedHours`)
- `applications` (candidates ↔ jobs) — ใบสมัครงาน (มี `appliedAt`, `status`)

**สังเกตแพทเทิร์นร่วม**: ทุกตัวอย่างข้างบนมี column เสริมที่เป็น **"เหตุการณ์" หรือ
"สถานะ"** ของความสัมพันธ์นั้นเอง (`appliedAt`, `status`, `rating`, `quantity`) — นี่คือ
สัญญาณหลักที่บอกว่าควรตั้งชื่อแบบมีความหมาย เพราะ junction table เหล่านี้ไม่ได้ทำหน้าที่
แค่ "เชื่อม 2 ตาราง" แต่เป็น **entity ที่ตัวมันเองมี lifecycle** (สมัคร → รอผล →
ผ่าน/ไม่ผ่าน, จอง → ยืนยัน → ยกเลิก) ต่างจาก `post_tags` ที่แค่ "มี" หรือ "ไม่มี"
ความสัมพันธ์เฉยๆ ไม่มี state ให้ไล่
