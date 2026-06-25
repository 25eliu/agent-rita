interface HintTable {
  tableName: string;
  rowCount: number;
  columns: { name: string }[];
}

function columnSummary(table: HintTable): string {
  return table.columns.map((column) => `"${column.name}"`).join(", ");
}

export function availableTablesHint(loaded: HintTable[]): string {
  return loaded.length > 0
    ? ` Available tables: ${loaded
      .map(
        (table) =>
          `"${table.tableName}" (${table.rowCount} rows; columns: ${columnSummary(table)})`,
      )
      .join("; ")}.`
    : " No tables shipped — did the widget data load?";
}
