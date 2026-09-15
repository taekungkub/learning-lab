// bun run examples/02-select.ts
import { and, eq, like, desc } from "drizzle-orm";
import { db } from "../src/db";
import { users, posts } from "../src/schema";

// select ทั้งหมด
const allUsers = await db.select().from(users);
/* [{ id, name, email, role, createdAt }, ...] */
console.log("all users:", allUsers);

// select บาง column
const namesOnly = await db.select({ name: users.name, email: users.email }).from(users);
/* [{ name, email }, ...] */
console.log("names only:", namesOnly);

// where เดี่ยว
const admins = await db.select().from(users).where(eq(users.role, "admin"));
/* [{ id, name, email, role: "admin", createdAt }, ...] */
console.log("admins:", admins);

// where แบบผสม (and) + like
const filtered = await db
  .select()
  .from(users)
  .where(and(eq(users.role, "member"), like(users.email, "%example.com")));
/* [{ id, name, email, role: "member", createdAt }, ...] */
console.log("filtered:", filtered);

// orderBy, limit, offset
const latestPosts = await db
  .select()
  .from(posts)
  .orderBy(desc(posts.createdAt))
  .limit(5)
  .offset(0);
/* [{ id, title, content, published, authorId, createdAt }, ...] เรียงใหม่สุดก่อน */
console.log("latest posts:", latestPosts);
