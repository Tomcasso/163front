import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const IMAP_HOST = "imap.163.com";
const IMAP_PORT = 993;
const SMTP_HOST = "smtp.163.com";
const SMTP_PORT = 465;

export const tools = {
  "mail.listTodayInbox": {
    description: "列出今日的收件箱邮件摘要",
    parameters: { limit: { type: "number", default: 10 } },

    async execute({ limit = 10 }) {
      // ✅ 每次执行时再读取 env（避免 dotenv 导入顺序问题）
      const EMAIL_USER = process.env.EMAIL_USER;
      const EMAIL_PASS = process.env.EMAIL_PASS;

      if (!EMAIL_USER || !EMAIL_PASS) {
        throw new Error("邮箱环境变量缺失：请检查 EMAIL_USER / EMAIL_PASS 是否在 backend/.env 中");
      }

      const client = new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: true,
        auth: {
          user: EMAIL_USER,
          pass: EMAIL_PASS,
        },
        authTimeout: 10000,
      });

      await client.connect();
      await client.mailboxOpen("INBOX");

      const since = new Date();
      since.setHours(0, 0, 0, 0);

      const uids = await client.search({ since });
      const latest = uids.slice(-limit);

      const mails = [];
      for await (const msg of client.fetch(latest, { envelope: true, source: true })) {
        const parsed = await simpleParser(msg.source);
        mails.push({
          from: parsed.from?.text || "(未知发件人)",
          subject: parsed.subject || "(无主题)",
          date: parsed.date || msg.envelope?.date,
          snippet: (parsed.text || "").slice(0, 100),
        });
      }

      await client.logout();
      return mails.reverse();
    },
  },

  "mail.send": {
    description: "发送邮件（需提供收件人、主题、正文）",
    parameters: {
      to: { type: "string" },
      subject: { type: "string" },
      text: { type: "string" },
    },

    async execute({ to, subject, text }) {
      // ✅ 发送时也同样读取 env
      const EMAIL_USER = process.env.EMAIL_USER;
      const EMAIL_PASS = process.env.EMAIL_PASS;

      if (!EMAIL_USER || !EMAIL_PASS) {
        throw new Error("邮箱环境变量缺失：请检查 EMAIL_USER / EMAIL_PASS 是否在 backend/.env 中");
      }

      const transporter = nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: true,
        auth: { user: EMAIL_USER, pass: EMAIL_PASS },
      });

      const info = await transporter.sendMail({
        from: EMAIL_USER,
        to,
        subject,
        text,
      });

      return { ok: true, messageId: info.messageId };
    },
  },
};

