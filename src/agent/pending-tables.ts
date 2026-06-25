/**
 * Replacement-aware writer for `pendingTables`.
 *
 * When the same table name is overwritten (widget re-fetch, follow-up
 * MCP `sqlite_table` result, repeated `create_table_from_text`), the
 * compute sandbox still holds the prior row set under that name. The
 * delta-ship filter in `src/agent/loop.ts` would skip re-shipping
 * because the name is already in `tablesShipped` — so the sandbox would
 * keep stale rows.
 *
 * Removing the name from `tablesShipped` before the `.set` call forces
 * the next `execute_code` call to re-ship the refreshed rows. Call this
 * at every site that mutates `pendingTables` after the initial seed.
 */
export function setPendingTable(
  name: string,
  rows: Record<string, unknown>[],
  pendingTables: Map<string, Record<string, unknown>[]>,
  tablesShipped: Set<string>,
): void {
  if (pendingTables.has(name)) tablesShipped.delete(name);
  pendingTables.set(name, rows);
}
