# แผนการเรียน Drizzle ORM (Checklist)

> โปรเจกต์นี้ใช้เป็นพื้นที่ฝึกทำตามหัวข้อด้านล่าง ติ๊กเมื่อทำเสร็จแต่ละข้อ

## 1. พื้นฐานและการติดตั้ง
- [ ] ทำความเข้าใจว่า Drizzle คืออะไร (TypeScript ORM แบบ type-safe, SQL-like syntax)
- [ ] เปรียบเทียบ Drizzle กับ ORM อื่น (Prisma, TypeORM, Kysely)
- [ ] ติดตั้ง `drizzle-orm` และ `drizzle-kit`
- [ ] เลือก driver ตามฐานข้อมูล (postgres.js, node-postgres, mysql2, better-sqlite3, libsql)
- [ ] ตั้งค่า `drizzle.config.ts`

## 2. การนิยาม Schema
- [ ] สร้างตาราง (table) ด้วย `pgTable` / `mysqlTable` / `sqliteTable`
- [ ] เรียนรู้ column types (text, integer, boolean, timestamp, json, ฯลฯ)
- [ ] ตั้งค่า primary key, default value, not null
- [ ] สร้างความสัมพันธ์ (relations) — one-to-many, many-to-many
- [ ] ใช้ foreign key constraints
- [ ] สร้าง enum และ custom types
- [ ] เข้าใจ schema สำหรับ multi-schema/multi-file projects

## 3. Migrations
- [ ] เข้าใจ workflow: schema → migration → apply
- [ ] ใช้ `drizzle-kit generate` สร้างไฟล์ migration
- [ ] ใช้ `drizzle-kit migrate` รัน migration
- [ ] ใช้ `drizzle-kit push` สำหรับ prototyping (schema push แบบไม่มี migration file)
- [ ] ใช้ `drizzle-kit studio` เปิด GUI ดูข้อมูล
- [ ] จัดการ migration conflicts และ rollback

## 4. Query พื้นฐาน (CRUD)
- [ ] `select()` พร้อม `.from()`, `.where()`
- [ ] `insert()` — single และ batch insert
- [ ] `update()` พร้อม `.set()` และ `.where()`
- [ ] `delete()` พร้อม `.where()`
- [ ] เรียนรู้ operators: `eq`, `ne`, `gt`, `lt`, `and`, `or`, `like`, `inArray`
- [ ] `.limit()`, `.offset()`, `.orderBy()`

## 5. Query ขั้นสูง
- [ ] Joins (`innerJoin`, `leftJoin`, `rightJoin`, `fullJoin`)
- [ ] Query API แบบ relational (`db.query.table.findMany`, `findFirst`)
- [ ] `with` สำหรับดึงข้อมูลแบบ nested relations
- [ ] Aggregate functions (`count`, `sum`, `avg`, `min`, `max`)
- [ ] `groupBy` และ `having`
- [ ] Subqueries
- [ ] Prepared statements (เพิ่ม performance)
- [ ] Transactions (`db.transaction`)

## 6. Type Safety & Validation
- [ ] ใช้ `InferSelectModel` / `InferInsertModel` เพื่อดึง type จาก schema
- [ ] integrate กับ Zod ผ่าน `drizzle-zod`
- [ ] Type-safe query builder patterns

## 7. การเชื่อมต่อและ Environment
- [ ] ตั้งค่า connection pooling
- [ ] ใช้กับ serverless (Neon, PlanetScale, Turso, Supabase)
- [ ] ตั้งค่า environment variables อย่างปลอดภัย
- [ ] จัดการ connection ใน edge runtime (Cloudflare Workers, Vercel Edge)

## 8. Integration กับ Framework
- [ ] ใช้ Drizzle กับ Next.js
- [ ] ใช้ Drizzle กับ Bun (โปรเจกต์นี้)
- [ ] ใช้ Drizzle กับ Hono / Express
- [ ] Seed ข้อมูลเริ่มต้น (`drizzle-seed` หรือ script เอง)

## 9. Testing & Best Practices
- [ ] เขียน test สำหรับ query logic
- [ ] ใช้ test database แยกจาก production
- [ ] จัดโครงสร้างโปรเจกต์ (schema files, repositories pattern)
- [ ] Performance tuning และ indexing

## 10. โปรเจกต์ฝึกจริง
- [ ] สร้าง CRUD API เล็กๆ (เช่น Todo app) ด้วย Drizzle + Bun
- [ ] เพิ่มระบบ authentication ที่ใช้ Drizzle เก็บ user data
- [ ] Deploy ขึ้น production พร้อม migration pipeline
