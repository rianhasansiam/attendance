/** Spreadsheet applications interpret leading formula characters even in quoted CSV fields. */
export function safeCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /^[\s\u0000-\u001f]*[=+\-@]/.test(text) ? `'${text}` : text;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const escape = (value: unknown) =>
    `"${safeCell(value).replaceAll('"', '""')}"`;
  return (
    "\uFEFF" +
    [headers, ...rows].map((row) => row.map(escape).join(",")).join("\r\n")
  );
}
