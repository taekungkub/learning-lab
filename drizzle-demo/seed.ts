// bun run seed.ts
// seed ข้อมูลตัวอย่าง แยกจาก migration โดยตั้งใจ (migration = structure, seed = data)
import { db } from "./src/db";
import { comments, postTags, posts, tags, users } from "./src/schema";

const seedUsers = await db
  .insert(users)
  .values([
    { name: "Alice", email: "alice@example.com", role: "admin" },
    { name: "Bob", email: "bob@example.com" },
    { name: "Carol", email: "carol@example.com" },
  ])
  .returning();
console.log(`seeded ${seedUsers.length} users`);

const [alice, bob] = seedUsers;

const seedTags = await db
  .insert(tags)
  .values([{ name: "drizzle" }, { name: "typescript" }, { name: "sqlite" }])
  .returning();
console.log(`seeded ${seedTags.length} tags`);

const [drizzleTag, tsTag] = seedTags;

const seedPosts = await db
  .insert(posts)
  .values([
    {
      title: "เริ่มต้นกับ Drizzle ORM",
      content: "บทความแนะนำการใช้งาน Drizzle เบื้องต้น",
      published: true,
      authorId: alice!.id,
    },
    {
      title: "Type-safe query ด้วย TypeScript",
      content: "ตัวอย่างการเขียน query ที่ type-safe",
      published: false,
      authorId: bob!.id,
    },
  ])
  .returning();
console.log(`seeded ${seedPosts.length} posts`);

const [firstPost, secondPost] = seedPosts;

await db.insert(postTags).values([
  { postId: firstPost!.id, tagId: drizzleTag!.id },
  { postId: firstPost!.id, tagId: tsTag!.id },
  { postId: secondPost!.id, tagId: tsTag!.id },
]);
console.log("seeded post_tags");

await db.insert(comments).values([
  { body: "บทความดีมากครับ", postId: firstPost!.id, authorId: bob!.id },
]);
console.log("seeded comments");

console.log("seed done.");
