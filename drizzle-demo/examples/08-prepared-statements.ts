// bun run examples/08-prepared-statements.ts
// prepared statement: compile query ครั้งเดียว แล้วรันซ้ำได้เร็วขึ้น (ใช้ placeholder)
import { eq, sql } from "drizzle-orm";
import { db } from "../src/db";
import { users } from "../src/schema";

const findUserByEmail = db
  .select()
  .from(users)
  .where(eq(users.email, sql.placeholder("email")))
  .prepare();

const alice = await findUserByEmail.execute({ email: "alice@example.com" });
console.log("prepared query result:", alice);

const bob = await findUserByEmail.execute({ email: "bob@example.com" });
console.log("prepared query result:", bob);
