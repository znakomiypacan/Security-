const sqlite3 = require('sqlite3');
const path = require('path');

const db = new sqlite3.Database(path.join(__dirname, 'security.db'));

db.serialize(() => {
    // Пользователи
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            password TEXT NOT NULL,
            role TEXT CHECK(role IN ('admin', 'employee', 'chief', 'guard')) NOT NULL,
            full_name TEXT NOT NULL,
            guard_post TEXT CHECK(guard_post IN ('post4', 'post1', 'pco', NULL)),
            email TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // Заявки
    db.run(`
        CREATE TABLE IF NOT EXISTS requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            type TEXT CHECK(type IN ('car', 'person', 'opening')) NOT NULL,
            description TEXT NOT NULL,
            date_from TEXT,
            date_to TEXT,
            duration_days INTEGER,
            object_type TEXT,
            object_number TEXT,
            status TEXT CHECK(status IN ('pending', 'approved', 'rejected', 'completed', 'confirmed')) DEFAULT 'pending',
            reject_reason TEXT,
            files TEXT,
            email_sent INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            completed_at DATETIME,
            confirmed_at DATETIME,
            FOREIGN KEY (sender_id) REFERENCES users (id)
        )
    `);

    // Сообщения чата
    db.run(`
        CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            sender_post TEXT,
            recipient_post TEXT,
            message TEXT NOT NULL,
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users (id)
        )
    `);

    // Уведомления об открытии объектов
    db.run(`
        CREATE TABLE IF NOT EXISTS opening_notifications (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            request_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            sender_name TEXT NOT NULL,
            object_type TEXT NOT NULL,
            object_number TEXT NOT NULL,
            description TEXT,
            status TEXT CHECK(status IN ('pending', 'confirmed', 'closed')) DEFAULT 'pending',
            confirmed_by TEXT,
            confirmed_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (request_id) REFERENCES requests (id),
            FOREIGN KEY (sender_id) REFERENCES users (id)
        )
    `);

    // Настройки
    db.run(`
        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )
    `);

    // Вставляем настройки по умолчанию
    db.get("SELECT COUNT(*) as count FROM settings", (err, row) => {
        if (row && row.count === 0) {
            const settings = [
                ['post4_name', 'Пост N4'],
                ['post1_name', 'Пост N1'],
                ['pco_name', 'ПЦО'],
                ['hr_emails', 'hr1@company.ru,hr2@company.ru,hr3@company.ru'],
                ['email_notification_days', '5'],
                ['message_retention_days', '7'],
                ['email_template', 'Уведомление о длительной заявке\n\nСотрудник: {employee_name}\nEmail сотрудника: {employee_email}\nТип: {type}\nОписание: {description}\nПериод: с {date_from} по {date_to}\nДлительность: {duration_days} дней\n\nЗаявка СОГЛАСОВАНА начальником охраны.\n\n---\nЭто автоматическое сообщение, отвечать на него не нужно.']
            ];
            const stmt = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)");
            settings.forEach(setting => stmt.run(setting));
            stmt.finalize();
            console.log('Настройки по умолчанию добавлены');
        }
    });

    // Вставляем тестовых пользователей
    db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
        if (row && row.count === 0) {
            const users = [
                ['admin', 'admin123', 'admin', 'Администратор', null, 'admin@company.ru'],
                ['ivanov', '123', 'employee', 'Иванов Иван', null, 'ivanov@company.ru'],
                ['petrov', '123', 'employee', 'Петров Пётр', null, 'petrov@company.ru'],
                ['sidorov', '123', 'employee', 'Сидоров Сидор', null, 'sidorov@company.ru'],
                ['chief1', '123', 'chief', 'Алексей Михайлович', null, 'chief@company.ru'],
                ['guard4', '123', 'guard', 'Пост N4', 'post4', null],
                ['guard1', '123', 'guard', 'Пост N1', 'post1', null],
                ['guard3', '123', 'guard', 'ПЦО', 'pco', null]
            ];

            const stmt = db.prepare("INSERT INTO users (username, password, role, full_name, guard_post, email) VALUES (?, ?, ?, ?, ?, ?)");
            users.forEach(user => stmt.run(user));
            stmt.finalize();
            console.log('Тестовые пользователи добавлены');
        }
    });
});

module.exports = db;