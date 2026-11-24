CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL,
  title TEXT NOT NULL,
  reminder_time TEXT,
  is_completed BOOLEAN DEFAULT 0,
  created_date TEXT NOT NULL,
  notified BOOLEAN DEFAULT 0,
  category TEXT DEFAULT 'general',
  priority TEXT DEFAULT 'normal',
  repeat_type TEXT DEFAULT 'none'
);

CREATE INDEX IF NOT EXISTS idx_tasks_chat_date
  ON tasks (chat_id, created_date);

CREATE INDEX IF NOT EXISTS idx_tasks_reminder
  ON tasks (created_date, is_completed, notified, reminder_time);
