// bun run examples/03-update-delete.ts
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { posts, users } from "../src/schema";

// update
const [updated] = await db
  .update(users)
  .set({ role: "admin" })
  .where(eq(users.email, "bob@example.com"))
  .returning();
console.log("updated user:", updated);

// update หลาย column พร้อมกัน
await db
  .update(posts)
  .set({ published: true, content: "แก้ไขเนื้อหาแล้ว" })
  .where(eq(posts.title, "Hello Drizzle"));

// delete
const deleted = await db
  .delete(users)
  .where(eq(users.email, "carol@example.com"))
  .returning();
console.log("deleted user:", deleted);
