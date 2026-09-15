// bun run examples/06-aggregate.ts
import { count, eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { posts, users } from "../src/schema";

// count ทั้งหมด
const [row] = await db.select({ total: count() }).from(users);
const total = row!.total;
console.log("total users:", total);

// groupBy + count: จำนวนโพสต์ต่อ author
const postsPerAuthor = await db
  .select({
    authorId: posts.authorId,
    postCount: count(posts.id),
  })
  .from(posts)
  .groupBy(posts.authorId);
console.log("postsPerAuthor:", postsPerAuthor);

// groupBy + having: เอาเฉพาะ author ที่มีโพสต์มากกว่า 1
const activeAuthors = await db
  .select({
    authorId: posts.authorId,
    postCount: count(posts.id),
  })
  .from(posts)
  .groupBy(posts.authorId)
  .having(({ postCount }) => sql`${postCount} > 1`);
console.log("activeAuthors:", activeAuthors);

// join กับ users เพื่อโชว์ชื่อจริงแทน id
const postsPerAuthorNamed = await db
  .select({
    name: users.name,
    postCount: count(posts.id),
  })
  .from(users)
  .leftJoin(posts, eq(posts.authorId, users.id))
  .groupBy(users.id);
console.log("postsPerAuthorNamed:", postsPerAuthorNamed);
