// bun run examples/04-relational-query.ts
// ใช้ relational query API (db.query) ที่อ่านง่ายกว่า join เอง ต้องมี relations ใน schema.ts
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/schema";

// findMany พร้อมดึง relations แบบ nested (with)
const usersWithPosts = await db.query.users.findMany({
  with: {
    posts: {
      with: { comments: true },
    },
  },
});
console.log(JSON.stringify(usersWithPosts, null, 2));

// findFirst พร้อม where
const alice = await db.query.users.findFirst({
  where: eq(users.email, "alice@example.com"),
  with: { posts: true },
});
console.log("alice:", alice);

// เลือกเฉพาะบาง column ของ relation ด้วย columns
const authorsOnly = await db.query.posts.findMany({
  columns: { title: true },
  with: { author: { columns: { name: true } } },
});
console.log("authorsOnly:", authorsOnly);
