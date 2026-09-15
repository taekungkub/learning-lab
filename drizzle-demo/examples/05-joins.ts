// bun run examples/05-joins.ts
// การทำ join แบบดั้งเดิม (SQL-style) ต่างจาก relational query API ในตัวอย่าง 04
import { eq } from "drizzle-orm";
import { db } from "../src/db";
import { posts, users, comments } from "../src/schema";

// innerJoin: เอาเฉพาะ post ที่มี author
const postsWithAuthor = await db
  .select({
    postTitle: posts.title,
    authorName: users.name,
  })
  .from(posts)
  .innerJoin(users, eq(posts.authorId, users.id));
/* [{ postTitle, authorName }, ...] */
console.log("postsWithAuthor:", postsWithAuthor);

// leftJoin: เอา post ทั้งหมด แม้ไม่มี comment ก็ตาม
const postsWithComments = await db
  .select({
    postTitle: posts.title,
    commentBody: comments.body,
  })
  .from(posts)
  .leftJoin(comments, eq(comments.postId, posts.id));
/* [{ postTitle, commentBody }, ...] commentBody เป็น null ได้ถ้า post ไม่มี comment */
console.log("postsWithComments:", postsWithComments);
