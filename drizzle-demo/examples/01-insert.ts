// รัน migration ก่อน: bun run db:generate && bun run db:migrate
// จากนั้นรัน: bun run examples/01-insert.ts
import { db } from "../src/db";
import { users, posts } from "../src/schema";

// insert เดี่ยว พร้อม .returning() เพื่อดึงค่าที่เพิ่งสร้าง
const [alice] = await db
  .insert(users)
  .values({ name: "Alice", email: "alice@example.com", role: "admin" })
  .returning();
console.log("inserted user:", alice);

// batch insert
const inserted = await db
  .insert(users)
  .values([
    { name: "Bob", email: "bob@example.com" },
    { name: "Carol", email: "carol@example.com" },
  ])
  .returning();
console.log("inserted users:", inserted);

// insert ที่อ้างอิง foreign key
const [post] = await db
  .insert(posts)
  .values({
    title: "Hello Drizzle",
    content: "โพสต์แรกของ Alice",
    authorId: alice!.id,
    published: true,
  })
  .returning();
console.log("inserted post:", post);
