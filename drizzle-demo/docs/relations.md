# วิธีไล่ใส่ relations() ให้ถูก

`relations()` ไม่ได้สร้างความสัมพันธ์เอง มันแค่ "อธิบาย" FK ที่มีอยู่จริงใน schema
เท่านั้น — ถ้าไม่มี FK จริงรองรับ จะ join ไม่ได้ ห้ามเขียนตามที่คิดในหัวเฉยๆ

## เทคนิค: ไล่จาก `.references()` ก่อนเสมอ

**อย่าเริ่มจาก "อยากมี relation อะไร"** ให้เริ่มจาก **เปิดดูทุก column ที่มี
`.references()` ใน schema ก่อน** นี่คือจุดเริ่มต้นที่ถูกต้อง

ตัวอย่างจาก `src/schema.ts` (ไล่ดู `.references()` ทั้งหมด):
```
posts.authorId     → references users.id
comments.postId    → references posts.id
comments.authorId  → references users.id
postTags.postId    → references posts.id
postTags.tagId     → references tags.id
```

แต่ละบรรทัด FK ข้างบน = 1 คู่ relation (ต้องเขียน 2 ทิศทาง):

| FK column | ฝั่ง `one()` (ลูกชี้หาพ่อ) | ฝั่ง `many()` (พ่อมีลูกหลายตัว) |
|---|---|---|
| `posts.authorId` | `postsRelations.author = one(users)` | `usersRelations.posts = many(posts)` |
| `comments.postId` | `commentsRelations.post = one(posts)` | `postsRelations.comments = many(comments)` |
| `comments.authorId` | `commentsRelations.author = one(users)` | `usersRelations.comments = many(comments)` |
| `postTags.postId` | `postTagsRelations.post = one(posts)` | `postsRelations.postTags = many(postTags)` |
| `postTags.tagId` | `postTagsRelations.tag = one(tags)` | `tagsRelations.postTags = many(postTags)` |

## กฎจำง่ายๆ

> **ตารางไหนมี column ที่เป็น `.references()` → ตารางนั้นเขียน `one()`**
> **ตารางที่ถูก `.references()` ชี้ไปหา → เขียน `many()`**
> (เว้นแต่มั่นใจว่าเป็น 1:1 จริงๆ ถึงใช้ `one()` ทั้งคู่)

## many-to-many ไม่มีข้อยกเว้น

junction table (เช่น `postTags`) มี FK 2 เส้น (ไปหา `posts` และไปหา `tags`) — ใช้กฎ
เดียวกันข้างบนกับ FK แต่ละเส้นแยกกัน จะได้ relation 4 อันตามตารางข้างบน

**ห้ามเขียน relation ข้าม junction table ไปตรงๆ** เช่น `postsRelations.tags =
many(tags)` — ไม่มี FK ตรงระหว่าง `posts` กับ `tags` เลย (มีแค่ `postTags` ที่อ้างถึง
ทั้งคู่แยกกัน) โค้ดแบบนี้ compile ผ่านเพราะ syntax ถูก แต่ query จริงจะหา join
condition ไม่เจอ ต้อง nest ผ่าน `postTags` เท่านั้น:
```ts
db.query.posts.findMany({
  with: { postTags: { with: { tag: true } } },
});
```

## เทคนิคตรวจสอบตัวเอง

ก่อนเขียน relation คู่ไหน ถามตัวเองว่า **"ตารางฝั่งนี้มี column ที่ `.references()`
ไปหาอีกฝั่งจริงไหม"** ถ้าตอบไม่ได้ชัดเจนหรือไม่มี column แบบนั้นอยู่จริง = ห้ามเขียน
relation นั้น

ตัวอย่างผิดที่เจอบ่อย:
```ts
export const postsRelations = relations(posts, ({ one, many }) => ({
  author: one(users, { fields: [posts.authorId], references: [users.id] }), // ✅ มี FK จริง
  users: many(users),  // ❌ ไม่มี FK ระหว่าง posts กับ users ในทิศทางนี้เลย
  tags: many(tags),    // ❌ ต้องผ่าน postTags เท่านั้น ไม่มี FK ตรง
}));
```
