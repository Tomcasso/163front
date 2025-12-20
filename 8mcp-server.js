import dotenv from "dotenv";
dotenv.config();

import express from "express";
import { tools } from "./mail-tools.js";

const app = express();
app.use(express.json());

app.post("/tool/:name", async (req, res) => {
  const tool = tools[req.params.name];
  if (!tool) {
    return res.status(404).json({ error: "Tool not found" });
  }

  try {
    const result = await tool.execute(req.body || {});
    res.json(result);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.listen(3333, () => {
  console.log("✅ MCP Tool Server running at http://localhost:3333");
});
