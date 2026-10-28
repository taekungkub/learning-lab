import { createClient } from "@clickhouse/client";

// คุยผ่าน HTTP interface (:8123) ไม่ใช่ native protocol (:9000)
export const ch = createClient({
  url: process.env.CLICKHOUSE_URL ?? "http://localhost:8123",
  username: "default",
  password: process.env.CLICKHOUSE_PASSWORD ?? "demo",
  database: "demo",
});

// ยิง SELECT แล้วคืน rows เป็น object (format JSONEachRow)
export async function rows<T = Record<string, unknown>>(query: string, query_params?: Record<string, unknown>) {
  const rs = await ch.query({ query, query_params, format: "JSONEachRow" });
  return rs.json<T>();
}
