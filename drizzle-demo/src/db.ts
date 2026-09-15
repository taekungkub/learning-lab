import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// libsql (ไม่ใช่ bun:sqlite) เพราะรองรับ async transaction จริง (bun:sqlite transaction เป็น sync
// เท่านั้น ถ้า callback เป็น async, commit จะเกิดก่อน throw จริง ทำให้ rollback ไม่ทำงาน)
const client = createClient({ url: "file:drizzle-demo.sqlite" });
await client.execute("PRAGMA foreign_keys = ON;");

export const db = drizzle(client, { schema });
