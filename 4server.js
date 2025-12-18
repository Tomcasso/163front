import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

// ✅ 引入 MCP 邮箱工具（MCP Server）
import { tools as mailTools } from "./mcp/mail-server.js";

dotenv.config();

// ✅ 在这里加（立刻验证）
console.log("EMAIL_USER =", process.env.EMAIL_USER);
console.log("EMAIL_PASS =", process.env.EMAIL_PASS);

const app = express();
app.use(cors());
app.use(express.json());

/* =========================
   通义（OpenAI 兼容）
========================= */
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

/* =========================
   Health Check
========================= */
app.get("/health", (req, res) => {
  res.json({ ok: true });
});

/* =====================================================
   MCP Client（关键）：统一调用 MCP 工具
===================================================== */
async function callMcpTool(toolName, params = {}) {
  const tool = mailTools[toolName];
  if (!tool) {
    throw new Error(`MCP 工具不存在：${toolName}`);
  }
  return await tool.execute(params);
}

/* =====================================================
   普通对话接口（不走 MCP，保留你原来的）
===================================================== */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    const chatMessages = [
      {
        role: "system",
        content: "你是一个专业、简洁的邮箱秘书助手。中文回答。"
      },
      ...messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: String(m.text ?? "")
      }))
    ];

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: chatMessages,
      temperature: 0.7
    });

    const reply = r.choices?.[0]?.message?.content ?? "（无回复）";
    res.json({ reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "调用通义失败" });
  }
});

/* =====================================================
   标题生成接口（你已经验证 OK 的）
===================================================== */
app.post("/api/title", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.json({ title: "新会话" });
    }

    const transcript = messages
      .map((m) => {
        const role = m.from === "user" ? "用户" : "助手";
        const text = String(m.text ?? "").trim();
        return text ? `${role}：${text}` : "";
      })
      .filter(Boolean)
      .join("\n");

    const prompt = `
你是“对话标题生成器”。请阅读下面的对话记录，生成一个中文短标题。

要求：
- 6~10 个字
- 不使用问候语（你好、您好等）
- 不要引号、不要句号、不要换行
- 只输出标题本身

对话记录：
${transcript}
`.trim();

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: [
        { role: "system", content: "严格遵守格式要求。" },
        { role: "user", content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 32
    });

    let title = (r.choices?.[0]?.message?.content || "")
      .replace(/[\r\n]/g, " ")
      .replace(/^标题[:：]\s*/g, "")
      .trim();

    if (!title || title.length < 2) {
      title = "新会话";
    }

    if (title.length > 12) {
      title = title.slice(0, 12) + "…";
    }

    res.json({ title });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "生成标题失败" });
  }
});

/* =====================================================
   ✅ MCP Agent 核心接口（邮箱智能体）
===================================================== */
app.post("/api/agent", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    const systemPrompt = `
你是一个“邮箱 MCP 智能体”。

你可以使用以下 MCP 工具：
1. mail.listTodayInbox(limit)
   - 查看今天收到的邮件
2. mail.send(to, subject, text)
   - 发送邮件（必须参数齐全）

规则：
- 如果需要用工具，请返回 JSON：
{
  "action": "工具名",
  "params": { ... },
  "reply": "给用户的说明"
}
- 如果不需要工具：
{
  "action": "none",
  "reply": "直接回复用户"
}
只输出 JSON，不要多余文字。
`.trim();

    const chatMessages = [
      { role: "system", content: systemPrompt },
      ...messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: m.text
      }))
    ];

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: chatMessages,
      temperature: 0.3
    });

    const raw = r.choices[0].message.content;

    let decision;
    try {
      decision = JSON.parse(raw);
    } catch {
      // 模型没走 MCP，直接当普通回复
      return res.json({ reply: raw });
    }

    if (decision.action && decision.action !== "none") {
      const data = await callMcpTool(
        decision.action,
        decision.params || {}
      );

      return res.json({
        reply: decision.reply,
        tool: decision.action,
        data
      });
    }

    res.json({ reply: decision.reply });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   启动服务
========================= */
const port = Number(process.env.PORT || 3001);
app.listen(port, () => {
  console.log(`Backend running: http://localhost:${port}`);
});
