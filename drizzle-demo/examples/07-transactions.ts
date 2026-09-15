// bun run examples/07-transactions.ts
// transaction: ทำหลาย query แบบ all-or-nothing ถ้า throw จะ rollback ทั้งหมด
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { users, posts } from "../src/schema";

const result = await db.transaction(async (tx) => {
  const [author] = await tx
    .insert(users)
    .values({ name: "Dave", email: "dave@example.com" })
    .returning();

  const [post] = await tx
    .insert(posts)
    .values({ title: "Post ใน transaction", authorId: author!.id })
    .returning();

  return { author, post };
});
console.log("transaction result:", result);

// ตัวอย่าง rollback: ถ้า throw error ระหว่างทาง จะไม่มีอะไรถูกบันทึกเลย
try {
  await db.transaction(async (tx) => {
    await tx.insert(users).values({ name: "Eve", email: "eve@example.com" });
    throw new Error("จำลอง error กลางทาง -> ต้อง rollback");
  });
} catch (err) {
  console.log("rolled back as expected:", (err as Error).message);
}

const eve = await db.select().from(users).where(eq(users.email, "eve@example.com"));
console.log("eve should be empty:", eve);
