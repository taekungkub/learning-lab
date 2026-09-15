// bun run examples/09-many-to-many.ts
// many-to-many: posts <-> tags ผ่าน join table postTags (composite primary key)
import { and, eq } from "drizzle-orm";
import { db } from "../src/db";
import { postTags, posts, tags } from "../src/schema";

// วิธีที่ 1: relational query API - อ่านง่าย เหมาะกับดึงข้อมูล nested
const postsWithTags = await db.query.posts.findMany({
  with: {
    postTags: {
      with: { tag: true },
    },
  },
});
/* [{ id, title, ..., postTags: [{ postId, tagId, tag: { id, name } }, ...] }, ...] */
console.log(JSON.stringify(postsWithTags, null, 2));

// หา tags ทั้งหมดของ post ตัวเดียว
const onePost = await db.query.posts.findFirst({
  where: eq(posts.title, "เริ่มต้นกับ Drizzle ORM"),
  with: { postTags: { with: { tag: true } } },
});
/* onePost: { id, title, ..., postTags: [{ tag: { id, name } }, ...] } | undefined */
console.log(
  "tags ของ post นี้:",
  onePost?.postTags.map((pt) => pt.tag.name),
);

// วิธีที่ 2: join แบบ manual - เอาไว้ select เฉพาะ column ที่ต้องการ
const joined = await db
  .select({
    postTitle: posts.title,
    tagName: tags.name,
  })
  .from(posts)
  .innerJoin(postTags, eq(postTags.postId, posts.id))
  .innerJoin(tags, eq(tags.id, postTags.tagId));
/* [{ postTitle, tagName }, ...] หนึ่ง post ซ้ำหลายแถวได้ถ้ามีหลาย tag */
console.log("posts + tags (join):", joined);

// ทิศทางกลับ: หา posts ทั้งหมดที่มี tag ชื่อ "typescript"
const postsByTag = await db
  .select({ postTitle: posts.title })
  .from(tags)
  .innerJoin(postTags, eq(postTags.tagId, tags.id))
  .innerJoin(posts, eq(posts.id, postTags.postId))
  .where(eq(tags.name, "typescript"));
/* [{ postTitle }, ...] */
console.log('posts ที่มี tag "typescript":', postsByTag);

// เพิ่ม tag ให้ post ที่มีอยู่แล้ว (insert แถวใหม่ใน join table)
const [sqliteTag] = await db
  .insert(tags)
  .values({ name: "bun" })
  .onConflictDoNothing()
  .returning();
if (sqliteTag) {
  await db.insert(postTags).values({ postId: 1, tagId: sqliteTag.id });
  console.log(`เพิ่ม tag "${sqliteTag.name}" ให้ post id 1 แล้ว`);
}

// เอา tag ออกจาก post (ลบแค่แถวใน join table ไม่ลบ tag หรือ post)
await db
  .delete(postTags)
  .where(and(eq(postTags.postId, 1), eq(postTags.tagId, sqliteTag?.id ?? 0)));
console.log("ลบความสัมพันธ์ post-tag แล้ว (ตัว post กับ tag ยังอยู่)");
