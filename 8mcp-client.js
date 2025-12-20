import fetch from "node-fetch";

const MCP_BASE = "http://localhost:3333";

export async function callTool(name, args = {}) {
  const resp = await fetch(`${MCP_BASE}/tool/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(args),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`MCP error ${resp.status}: ${text}`);
  }

  return await resp.json();
}
