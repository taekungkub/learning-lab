import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

// libsql เหมือน drizzle-demo: async transaction ใช้ได้จริง
const client = createClient({ url: "file:kafka-outbox.sqlite" });
// WAL + busy_timeout: relay, consumer, examples เปิดไฟล์เดียวกันพร้อมกันได้
await client.execute("PRAGMA journal_mode = WAL;");
await client.execute("PRAGMA busy_timeout = 5000;");

export const db = drizzle(client, { schema });
