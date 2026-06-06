export interface ToolText {
  // index signature so this is assignable to the SDK's CallToolResult
  [x: string]: unknown;
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

/** Wrap a JSON-serializable value as an MCP text result. */
export function json(value: unknown): ToolText {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message: string): ToolText {
  return { content: [{ type: "text", text: JSON.stringify({ error: message }) }], isError: true };
}

/** Minimal structured logging: tool name + ids only, never content. */
export function logToolCall(tool: string, ids: Record<string, unknown> = {}): void {
  const parts = Object.entries(ids)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.length : v}`);
  console.log(`[tool] ${tool} ${parts.join(" ")}`.trim());
}
