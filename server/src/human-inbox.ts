import { db } from "./db.js";

/** Metadata only: the body of an ordinary blocked task is never fetched by this scan. */
export function isAuthenticatedHumanInboxRow(row: { type: string; meta_json: unknown }): boolean {
  if (row.type !== "task" && row.type !== "broadcast") return false;
  let meta: any;
  try { meta = typeof row.meta_json === "string" ? JSON.parse(row.meta_json) : null; }
  catch { return false; }
  return !!meta && typeof meta === "object" && !Array.isArray(meta)
    && meta.auth_origin === "user" && meta.source === "dashboard-chat"
    && typeof meta.client_request_id === "string" && /^dreq_[a-f0-9]{32}$/.test(meta.client_request_id);
}

/** Caller supplies the already-authorized recipient/network WHERE clause. Both DB dialects
 * support this scalar keyset; no JSON SQL extension, OFFSET, or arbitrary depth cutoff. */
export function selectHumanInboxIds(whereSql: string, params: any[], limit: number) {
  const ids: string[] = [];
  let cursor: { priority_rank: number; created_at: string; id: string } | undefined;
  let examined = 0;
  const rank = "CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END";
  while (ids.length < limit) {
    const pageParams = [...params];
    let sql = `SELECT id, type, meta_json, created_at, ${rank} AS priority_rank ${whereSql}`;
    if (cursor) {
      const n = pageParams.length + 1;
      sql += ` AND (${rank}, created_at, id) > (?${n}, ?${n + 1}, ?${n + 2})`;
      pageParams.push(cursor.priority_rank, cursor.created_at, cursor.id);
    }
    sql += ` ORDER BY ${rank}, created_at, id LIMIT 256`;
    const page = db.all<any>(sql, ...pageParams);
    if (!page.length) break;
    for (const row of page) {
      examined++;
      if (isAuthenticatedHumanInboxRow(row)) ids.push(row.id);
      if (ids.length === limit) break;
    }
    cursor = page[page.length - 1];
    if (page.length < 256) break;
  }
  return { ids, examined };
}
