import Database from "better-sqlite3";
const db = new Database("chat.db");

// 初始化表
db.exec(`
CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chatId INTEGER NOT NULL,
  idx INTEGER NOT NULL,
  fromRole TEXT NOT NULL,
  text TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  FOREIGN KEY(chatId) REFERENCES chats(id)
);

CREATE INDEX IF NOT EXISTS idx_messages_chatId ON messages(chatId);
`);

export function listChats() {
  return db.prepare(`
    SELECT id, title, createdAt, updatedAt
    FROM chats
    ORDER BY updatedAt DESC
  `).all();
}

export function getChat(chatId) {
  const chat = db.prepare(`SELECT id, title, createdAt, updatedAt FROM chats WHERE id=?`).get(chatId);
  if (!chat) return null;

  const messages = db.prepare(`
    SELECT idx, fromRole as "from", text
    FROM messages
    WHERE chatId=?
    ORDER BY idx ASC
  `).all(chatId);

  return { ...chat, messages };
}

export function createChat({ title, messages }) {
  const now = Date.now();
  const ins = db.prepare(`INSERT INTO chats (title, createdAt, updatedAt) VALUES (?, ?, ?)`);
  const info = ins.run(title, now, now);
  const chatId = info.lastInsertRowid;

  const insMsg = db.prepare(`
    INSERT INTO messages (chatId, idx, fromRole, text, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((msgs) => {
    msgs.forEach((m, i) => {
      insMsg.run(chatId, i, m.from, String(m.text ?? ""), now);
    });
  });
  tx(messages || []);

  return chatId;
}

export function updateChat(chatId, { title, messages }) {
  const now = Date.now();
  db.prepare(`UPDATE chats SET title=?, updatedAt=? WHERE id=?`).run(title, now, chatId);

  // 简单粗暴：先删再插（消息量不大时最省心）
  db.prepare(`DELETE FROM messages WHERE chatId=?`).run(chatId);

  const insMsg = db.prepare(`
    INSERT INTO messages (chatId, idx, fromRole, text, createdAt)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction((msgs) => {
    msgs.forEach((m, i) => {
      insMsg.run(chatId, i, m.from, String(m.text ?? ""), now);
    });
  });
  tx(messages || []);
}

export function deleteChat(chatId) {
  db.prepare(`DELETE FROM messages WHERE chatId=?`).run(chatId);
  db.prepare(`DELETE FROM chats WHERE id=?`).run(chatId);
}
