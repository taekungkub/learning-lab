// bun run examples/06-update-delete.ts   (ต้องรัน 01 ก่อน)
// UPDATE/DELETE มีได้ แต่เป็นงานหนัก ใช้นานๆ ครั้ง ไม่ใช่ OLTP
import { ch, rows } from "../src/ch";

const show = async (label: string) => {
  console.log(label);
  console.table(await rows("SELECT * FROM events ORDER BY ts"));
};
await show("ก่อน:");

// lightweight DELETE: mark แถวด้วย mask ทันที แล้วลบจริงตอน merge
await ch.command({ query: "DELETE FROM events WHERE event = 'view'" });
await show("หลัง DELETE:");

// mutation แบบเดิม: ALTER TABLE ... UPDATE เขียน part ใหม่ทั้งคอลัมน์ (async)
// mutations_sync = 1: รอให้เสร็จก่อน return (ใช้ใน demo)
await ch.command({
  query: "ALTER TABLE events UPDATE amount = amount * 2 WHERE user_id = 1",
  clickhouse_settings: { mutations_sync: "1" },
});
await show("หลัง ALTER UPDATE (user 1 x2):");

console.table(await rows("SELECT command, is_done FROM system.mutations WHERE database = 'demo' AND table = 'events'"));
await ch.close();
