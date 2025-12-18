import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// 通义（OpenAI 兼容）
// 北京地域 base_url（官方文档）
const client = new OpenAI({
  apiKey: process.env.DASHSCOPE_API_KEY,
  baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
});

app.get("/health", (req, res) => res.json({ ok: true }));

// 前端把 messages 发来：[{from:'user'|'agent', text:'...'}]
// 我们转换成 OpenAI 兼容的 messages：[{role:'user'|'assistant', content:'...'}]
app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [] } = req.body;

    const chatMessages = [
      { role: "system", content: "你是一个专业、简洁的邮箱秘书助手。中文回答。" },
      ...messages.map((m) => ({
        role: m.from === "user" ? "user" : "assistant",
        content: String(m.text ?? ""),
      })),
    ];

    const r = await client.chat.completions.create({
      model: "qwen-plus",
      messages: chatMessages,
      temperature: 0.7,
    });

    const reply = r.choices?.[0]?.message?.content ?? "（无回复）";
    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "调用通义失败" });
  }
});

const port = Number(process.env.PORT || 3001);
app.listen(port, () => console.log(`Backend running: http://localhost:${port}`));
