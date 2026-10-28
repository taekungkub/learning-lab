# clickhouse-demo

ฝึก ClickHouse (columnar OLAP database) บน Bun + `@clickhouse/client` (HTTP interface)
ดูแนวคิดหลักใน `docs/concepts.md`

## Setup

```bash
docker compose up -d      # clickhouse-server:26.3, user default / password demo, database demo
docker compose ps
docker compose down -v    # ลบ container + volume (ข้อมูลหาย)

bun install
```

- Web SQL UI: http://localhost:8123/play (user `default`, password `demo`)
- CLI ใน container: `docker compose exec clickhouse clickhouse-client --password demo -d demo`

## Examples

```bash
bun run examples/01-hello.ts                 # CREATE MergeTree, insert, select, query_params
bun run examples/02-bulk-aggregate.ts        # สร้าง 10M แถวด้วย numbers(), aggregate, ขนาด compress ต่อคอลัมน์
bun run examples/03-primary-key.ts           # (หลัง 02) EXPLAIN indexes: sparse index ข้าม granule ได้แค่ไหน, parts
bun run examples/04-replacing-merge-tree.ts  # upsert แบบ ClickHouse: ReplacingMergeTree, FINAL, argMax
bun run examples/05-materialized-view.ts     # MV + AggregatingMergeTree (sumState/uniqState → -Merge)
bun run examples/06-update-delete.ts         # (หลัง 01) lightweight DELETE, ALTER UPDATE mutation
bun run examples/07-hourly-rollup.ts         # insert ทุก 1 วิ + MV hourly, ดู state ย่อยถูก merge, view สำหรับ GUI
bun run examples/08-multi-metric.ts          # sensor key ต่างกัน: raw JSON → MV แตกเป็น long format → hourly → daily (เวลาไทย)
bun run examples/09-query-service.ts         # (หลัง 08) getStats() ใน src/stats.ts: hour/day/month/year จาก hourly
```

ทุก example DROP/CREATE ตารางเอง รันซ้ำได้
