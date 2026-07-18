import "server-only";

// Minimal, safe CSV serializer for server-side report exports (Stage 5 §11/§16).
// - RFC-4180 quoting (wraps fields containing comma/quote/newline, doubles quotes).
// - Formula-injection hardening: a field beginning with = + - @ (or tab/CR) is
//   prefixed with a single quote so spreadsheet apps don't execute it.
// - UTF-8 BOM so Excel opens Hebrew correctly.
// No dependency, no streaming — reports are bounded result sets.

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  let s = String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // neutralize formula injection
  if (/[",\n\r]/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>, columns: string[]): string {
  const head = headers.map(cell).join(",");
  const body = rows.map((r) => columns.map((c) => cell(r[c])).join(",")).join("\n");
  return "﻿" + head + "\n" + body + "\n";
}
