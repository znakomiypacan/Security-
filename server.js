const express = require('express');
const cors = require('cors');
const db = require('./database');
const nodemailer = require('nodemailer');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Создаём папку для загрузок
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}
app.use('/uploads', express.static(uploadDir));

// Настройка multer для загрузки файлов
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
        const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|xls|xlsx|txt/;
        const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
        const mimetype = allowedTypes.test(file.mimetype);
        if (mimetype && extname) {
            return cb(null, true);
        } else {
            cb(new Error('Только изображения, PDF и документы!'));
        }
    }
});

// ========== НАСТРОЙКА ДЛЯ GMAIL ==========
const GMAIL_EMAIL = 'ТВОЯ_ПОЧТА@gmail.com';
const GMAIL_APP_PASSWORD = 'СЮДА_16_ЗНАЧНЫЙ_ПАРОЛЬ';
// ==========================================

let transporter = null;
let transporterReady = false;

async function setupTransporter() {
    console.log('Настройка Gmail SMTP...');
    try {
        transporter = nodemailer.createTransport({
            host: 'smtp.gmail.com',
            port: 587,
            secure: false,
            auth: { user: GMAIL_EMAIL, pass: GMAIL_APP_PASSWORD }
        });
        await transporter.verify();
        transporterReady = true;
        console.log('Email настроен на Gmail');
        console.log('Аккаунт:', GMAIL_EMAIL);
    } catch (error) {
        console.error('Ошибка настройки Gmail:', error.message);
        transporterReady = false;
    }
}
setupTransporter();

async function sendEmailWithAttachments(to, subject, text, attachments = []) {
    if (!to || to === 'null') return null;
    if (!transporterReady) {
        console.log('=== ПИСЬМО (лог) ===\nКому:', to, '\nТема:', subject, '\nТекст:', text);
        if (attachments.length) console.log('Вложения:', attachments.map(a => a.filename));
        return { messageId: 'local-log' };
    }
    try {
        const mailOptions = {
            from: `"Система служебных записок" <${GMAIL_EMAIL}>`,
            to: to,
            subject: subject,
            text: text,
            attachments: attachments
        };
        const info = await transporter.sendMail(mailOptions);
        console.log('Email отправлен!');
        return info;
    } catch (error) {
        console.error('Ошибка отправки email:', error.message);
        console.log('=== ПИСЬМО (ошибка) ===\nКому:', to, '\nТема:', subject, '\nТекст:', text);
        return null;
    }
}

async function getSetting(key) {
    return new Promise((resolve) => {
        db.get(`SELECT value FROM settings WHERE key = ?`, [key], (err, row) => {
            resolve(row ? row.value : null);
        });
    });
}

function parseTemplate(template, data) {
    let result = template;
    for (const [key, value] of Object.entries(data)) {
        result = result.replace(new RegExp(`{${key}}`, 'g'), value || '');
    }
    return result;
}

async function deleteOldMessages() {
    const retentionDays = parseInt(await getSetting('message_retention_days')) || 7;
    db.run(`DELETE FROM messages WHERE created_at < datetime('now', '-' || ? || ' days')`, [retentionDays]);
    console.log('Старые сообщения удалены (старше', retentionDays, 'дней)');
}
setInterval(deleteOldMessages, 24 * 60 * 60 * 1000);
deleteOldMessages();

// ========== API для чата ==========

app.get('/api/messages/:post', (req, res) => {
    const { post } = req.params;
    const userId = req.query.user_id;
    
    let query = `
        SELECT m.*, u.full_name as sender_full_name 
        FROM messages m
        JOIN users u ON m.sender_id = u.id
        WHERE (m.recipient_post = ? OR m.recipient_post = 'all')
    `;
    let params = [post];
    
    if (userId) {
        query += ` OR m.sender_id = ?`;
        params.push(userId);
    }
    
    query += ` ORDER BY m.created_at ASC`;
    
    db.all(query, params, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows);
        }
    });
});

app.post('/api/messages', (req, res) => {
    const { sender_id, sender_name, sender_post, recipient_post, message } = req.body;
    
    db.run(`
        INSERT INTO messages (sender_id, sender_name, sender_post, recipient_post, message, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, [sender_id, sender_name, sender_post, recipient_post, message], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json({ success: true, id: this.lastID });
        }
    });
});

app.post('/api/messages/read/:post', (req, res) => {
    const { post } = req.params;
    db.run(`UPDATE messages SET is_read = 1 WHERE recipient_post = ? OR recipient_post = 'all'`, [post], function(err) {
        res.json({ success: !err });
    });
});

app.get('/api/messages/unread/:post', (req, res) => {
    const { post } = req.params;
    db.get(`SELECT COUNT(*) as count FROM messages WHERE (recipient_post = ? OR recipient_post = 'all') AND is_read = 0`, [post], (err, row) => {
        res.json({ count: row ? row.count : 0 });
    });
});

// ========== API для сотрудника ==========

app.post('/api/employee/request', upload.array('files', 5), async (req, res) => {
    console.log('Получена заявка с файлами:', req.body);
    
    const { sender_id, type, description, date_from, date_to } = req.body;
    const start = new Date(date_from);
    const end = new Date(date_to);
    const durationDays = Math.ceil((end - start) / (1000 * 60 * 60 * 24)) + 1;
    
    const files = req.files ? req.files.map(f => f.filename) : [];
    const filesJson = JSON.stringify(files);
    
    db.run(
        `INSERT INTO requests (sender_id, type, description, date_from, date_to, duration_days, status, files) 
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`,
        [sender_id, type, description, date_from, date_to, durationDays, filesJson],
        function(err) {
            if (err) {
                console.error('Ошибка БД:', err);
                return res.status(500).json({ error: err.message });
            }
            res.json({ success: true, id: this.lastID, duration_days: durationDays });
        }
    );
});

app.get('/api/employee/my-requests/:user_id', (req, res) => {
    db.all(`SELECT * FROM requests WHERE sender_id = ? AND type != 'opening' ORDER BY created_at DESC`, [req.params.user_id], (err, rows) => {
        res.json(rows || []);
    });
});

// ========== API для уведомлений об открытии объектов ==========

app.post('/api/employee/opening', (req, res) => {
    const { sender_id, sender_name, object_type, object_number, description } = req.body;
    
    console.log('Получено уведомление об открытии:', { sender_id, sender_name, object_type, object_number, description });
    
    db.run(`
        INSERT INTO requests (sender_id, type, description, object_type, object_number, status, created_at)
        VALUES (?, 'opening', ?, ?, ?, 'pending', datetime('now'))
    `, [sender_id, description || '', object_type, object_number], function(err) {
        if (err) {
            console.error('Ошибка вставки в requests:', err);
            return res.status(500).json({ error: err.message });
        }
        
        const requestId = this.lastID;
        
        db.run(`
            INSERT INTO opening_notifications (request_id, sender_id, sender_name, object_type, object_number, description, status, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
        `, [requestId, sender_id, sender_name, object_type, object_number, description || ''], function(err) {
            if (err) {
                console.error('Ошибка вставки в opening_notifications:', err);
                return res.status(500).json({ error: err.message });
            }
            console.log('Уведомление об открытии создано, ID:', requestId);
            res.json({ success: true, id: requestId });
        });
    });
});

app.get('/api/employee/my-openings/:user_id', (req, res) => {
    const { user_id } = req.params;
    db.all(`
        SELECT o.*, r.status as request_status
        FROM opening_notifications o
        JOIN requests r ON o.request_id = r.id
        WHERE o.sender_id = ?
        ORDER BY o.created_at DESC
    `, [user_id], (err, rows) => {
        if (err) {
            console.error('Ошибка загрузки уведомлений:', err);
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows || []);
        }
    });
});

// ========== API для начальника охраны ==========

app.get('/api/chief/pending', (req, res) => {
    db.all(`SELECT r.*, u.full_name as sender_name, u.email FROM requests r JOIN users u ON r.sender_id = u.id WHERE r.status = 'pending' AND r.type != 'opening' ORDER BY r.created_at DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/chief/approve/:id', async (req, res) => {
    const { id } = req.params;
    
    const requestInfo = await new Promise((resolve) => {
        db.get(`SELECT r.*, u.full_name as sender_name, u.email as sender_email FROM requests r JOIN users u ON r.sender_id = u.id WHERE r.id = ?`, [id], (err, row) => {
            resolve(row);
        });
    });
    
    db.run(`UPDATE requests SET status = 'approved' WHERE id = ?`, [id], async function(err) {
        if (err) return res.status(500).json({ success: false });
        
        const notificationDays = parseInt(await getSetting('email_notification_days')) || 5;
        if (requestInfo && requestInfo.duration_days > notificationDays) {
            const hrEmailsStr = await getSetting('hr_emails');
            const hrEmails = hrEmailsStr ? hrEmailsStr.split(',').map(e => e.trim()) : [];
            const emailTemplate = await getSetting('email_template');
            
            const templateData = {
                employee_name: requestInfo.sender_name,
                employee_email: requestInfo.sender_email || 'Не указан',
                type: requestInfo.type === 'car' ? 'Машина' : 'Человек',
                description: requestInfo.description,
                date_from: requestInfo.date_from,
                date_to: requestInfo.date_to,
                duration_days: requestInfo.duration_days
            };
            
            const emailText = parseTemplate(emailTemplate, templateData);
            
            let attachments = [];
            if (requestInfo.files) {
                const files = JSON.parse(requestInfo.files);
                for (const file of files) {
                    const filePath = path.join(uploadDir, file);
                    if (fs.existsSync(filePath)) {
                        attachments.push({
                            filename: file,
                            path: filePath
                        });
                    }
                }
            }
            
            for (const hrEmail of hrEmails) {
                if (hrEmail && hrEmail !== 'null' && hrEmail !== '') {
                    await sendEmailWithAttachments(hrEmail, 'СОГЛАСОВАНА длительная служебная заявка', emailText, attachments);
                }
            }
            db.run(`UPDATE requests SET email_sent = 1 WHERE id = ?`, [id]);
        }
        res.json({ success: true });
    });
});

app.post('/api/chief/reject/:id', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    
    const requestInfo = await new Promise((resolve) => {
        db.get(`SELECT r.*, u.email as sender_email FROM requests r JOIN users u ON r.sender_id = u.id WHERE r.id = ?`, [id], (err, row) => {
            resolve(row);
        });
    });
    
    db.run(`UPDATE requests SET status = 'rejected', reject_reason = ? WHERE id = ?`, [reason, id], async function(err) {
        if (requestInfo && requestInfo.sender_email) {
            await sendEmailWithAttachments(requestInfo.sender_email, 'Заявка отклонена', `Ваша заявка отклонена\n\nПричина: ${reason}`);
        }
        res.json({ success: !err });
    });
});

// ========== API для ПЦО (согласование заявок) ==========

app.get('/api/pco/pending', (req, res) => {
    db.all(`
        SELECT r.*, u.full_name as sender_name, u.email 
        FROM requests r
        JOIN users u ON r.sender_id = u.id
        WHERE r.status = 'pending' AND r.type != 'opening'
        ORDER BY r.created_at DESC
    `, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows || []);
        }
    });
});

app.post('/api/pco/approve/:id', async (req, res) => {
    const { id } = req.params;
    
    const requestInfo = await new Promise((resolve) => {
        db.get(`
            SELECT r.*, u.full_name as sender_name, u.email as sender_email 
            FROM requests r
            JOIN users u ON r.sender_id = u.id
            WHERE r.id = ?
        `, [id], (err, row) => {
            resolve(row);
        });
    });
    
    db.run(`UPDATE requests SET status = 'approved' WHERE id = ?`, [id], async function(err) {
        if (err) return res.status(500).json({ success: false });
        
        const notificationDays = parseInt(await getSetting('email_notification_days')) || 5;
        if (requestInfo && requestInfo.duration_days > notificationDays) {
            const hrEmailsStr = await getSetting('hr_emails');
            const hrEmails = hrEmailsStr ? hrEmailsStr.split(',').map(e => e.trim()) : [];
            const emailTemplate = await getSetting('email_template');
            
            const templateData = {
                employee_name: requestInfo.sender_name,
                employee_email: requestInfo.sender_email || 'Не указан',
                type: requestInfo.type === 'car' ? 'Машина' : 'Человек',
                description: requestInfo.description,
                date_from: requestInfo.date_from,
                date_to: requestInfo.date_to,
                duration_days: requestInfo.duration_days
            };
            
            const emailText = parseTemplate(emailTemplate, templateData);
            
            let attachments = [];
            if (requestInfo.files) {
                const files = JSON.parse(requestInfo.files);
                for (const file of files) {
                    const filePath = path.join(uploadDir, file);
                    if (fs.existsSync(filePath)) {
                        attachments.push({
                            filename: file,
                            path: filePath
                        });
                    }
                }
            }
            
            for (const hrEmail of hrEmails) {
                if (hrEmail && hrEmail !== 'null' && hrEmail !== '') {
                    await sendEmailWithAttachments(hrEmail, 'СОГЛАСОВАНА длительная служебная заявка (ПЦО)', emailText, attachments);
                }
            }
            db.run(`UPDATE requests SET email_sent = 1 WHERE id = ?`, [id]);
        }
        res.json({ success: true });
    });
});

app.post('/api/pco/reject/:id', async (req, res) => {
    const { id } = req.params;
    const { reason } = req.body;
    
    const requestInfo = await new Promise((resolve) => {
        db.get(`
            SELECT r.*, u.email as sender_email 
            FROM requests r
            JOIN users u ON r.sender_id = u.id
            WHERE r.id = ?
        `, [id], (err, row) => {
            resolve(row);
        });
    });
    
    db.run(`UPDATE requests SET status = 'rejected', reject_reason = ? WHERE id = ?`, [reason, id], async function(err) {
        if (requestInfo && requestInfo.sender_email) {
            await sendEmailWithAttachments(requestInfo.sender_email, 'Заявка отклонена (ПЦО)', `Ваша заявка отклонена ПЦО\n\nПричина: ${reason}`);
        }
        res.json({ success: !err });
    });
});

// ========== API для уведомлений об открытии (ПЦО) ==========

app.get('/api/pco/openings', (req, res) => {
    db.all(`
        SELECT o.*, r.id as request_id
        FROM opening_notifications o
        JOIN requests r ON o.request_id = r.id
        WHERE o.status = 'pending'
        ORDER BY o.created_at DESC
    `, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows || []);
        }
    });
});

app.get('/api/pco/openings/history', (req, res) => {
    db.all(`
        SELECT o.*, r.id as request_id
        FROM opening_notifications o
        JOIN requests r ON o.request_id = r.id
        WHERE o.status IN ('confirmed', 'closed')
        ORDER BY o.created_at DESC
        LIMIT 100
    `, (err, rows) => {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            res.json(rows || []);
        }
    });
});

app.post('/api/pco/opening/confirm/:id', (req, res) => {
    const { id } = req.params;
    const { confirmed_by } = req.body;
    
    db.run(`
        UPDATE opening_notifications 
        SET status = 'confirmed', confirmed_by = ?, confirmed_at = datetime('now')
        WHERE id = ?
    `, [confirmed_by, id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            db.run(`
                UPDATE requests 
                SET status = 'confirmed', confirmed_at = datetime('now')
                WHERE id = (SELECT request_id FROM opening_notifications WHERE id = ?)
            `, [id]);
            res.json({ success: true });
        }
    });
});

app.post('/api/pco/opening/close/:id', (req, res) => {
    const { id } = req.params;
    
    db.run(`
        UPDATE opening_notifications 
        SET status = 'closed'
        WHERE id = ?
    `, [id], function(err) {
        if (err) {
            res.status(500).json({ error: err.message });
        } else {
            db.run(`
                UPDATE requests 
                SET status = 'completed'
                WHERE id = (SELECT request_id FROM opening_notifications WHERE id = ?)
            `, [id]);
            res.json({ success: true });
        }
    });
});

// ========== API для охранников ==========

app.get('/api/settings/post-names', (req, res) => {
    db.all(`SELECT key, value FROM settings WHERE key IN ('post4_name', 'post1_name', 'pco_name')`, (err, rows) => {
        const result = {};
        rows.forEach(row => result[row.key] = row.value);
        res.json(result);
    });
});

app.get('/api/guards/active/:guard_id', (req, res) => {
    let typeFilter = '';
    if (req.params.guard_id === 'post4') typeFilter = "AND type = 'car'";
    else if (req.params.guard_id === 'post1') typeFilter = "AND type = 'person'";
    db.all(`SELECT r.*, u.full_name as sender_name FROM requests r JOIN users u ON r.sender_id = u.id WHERE r.status = 'approved' ${typeFilter} ORDER BY r.created_at DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/guards/archive/:guard_id', (req, res) => {
    let typeFilter = '';
    if (req.params.guard_id === 'post4') typeFilter = "AND type = 'car'";
    else if (req.params.guard_id === 'post1') typeFilter = "AND type = 'person'";
    const search = req.query.search || '';
    const searchFilter = search ? `AND (description LIKE '%${search}%' OR u.full_name LIKE '%${search}%')` : '';
    db.all(`SELECT r.*, u.full_name as sender_name FROM requests r JOIN users u ON r.sender_id = u.id WHERE r.status IN ('completed', 'rejected') ${typeFilter} ${searchFilter} ORDER BY r.created_at DESC`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/guards/complete/:id', (req, res) => {
    db.run(`UPDATE requests SET status = 'completed', completed_at = CURRENT_TIMESTAMP WHERE id = ?`, [req.params.id], function(err) {
        res.json({ success: !err });
    });
});

// ========== API для администратора ==========

app.get('/api/admin/users', (req, res) => {
    db.all(`SELECT id, username, full_name, role, guard_post, email, created_at FROM users ORDER BY id`, (err, rows) => {
        res.json(rows || []);
    });
});

app.post('/api/admin/users', (req, res) => {
    const { username, password, full_name, role, guard_post, email } = req.body;
    db.run(`INSERT INTO users (username, password, full_name, role, guard_post, email) VALUES (?, ?, ?, ?, ?, ?)`, [username, password, full_name, role, guard_post || null, email || null], function(err) {
        res.json({ success: !err, id: this.lastID });
    });
});

app.put('/api/admin/users/:id', (req, res) => {
    const { id } = req.params;
    const { username, full_name, role, guard_post, email, password } = req.body;
    let query = `UPDATE users SET username = ?, full_name = ?, role = ?, guard_post = ?, email = ?`;
    let params = [username, full_name, role, guard_post || null, email || null];
    if (password && password.trim()) {
        query += `, password = ?`;
        params.push(password);
    }
    query += ` WHERE id = ?`;
    params.push(id);
    db.run(query, params, function(err) {
        res.json({ success: !err });
    });
});

app.delete('/api/admin/users/:id', (req, res) => {
    db.run(`DELETE FROM users WHERE id = ? AND role != 'admin'`, [req.params.id], function(err) {
        res.json({ success: !err });
    });
});

app.get('/api/admin/stats', (req, res) => {
    db.all(`SELECT 
        (SELECT COUNT(*) FROM users WHERE role = 'employee') as total_employees,
        (SELECT COUNT(*) FROM users WHERE role = 'guard') as total_guards,
        (SELECT COUNT(*) FROM requests WHERE status = 'pending' AND type != 'opening') as pending_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'approved') as active_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'completed') as completed_requests,
        (SELECT COUNT(*) FROM requests WHERE status = 'rejected') as rejected_requests,
        (SELECT COUNT(*) FROM opening_notifications WHERE status = 'pending') as pending_openings
    `, (err, rows) => {
        res.json(rows[0] || {});
    });
});

app.get('/api/admin/stats/daily', (req, res) => {
    db.all(`
        SELECT date(created_at) as date, COUNT(*) as count 
        FROM requests 
        WHERE created_at >= date('now', '-7 days') AND type != 'opening'
        GROUP BY date(created_at)
        ORDER BY date ASC
    `, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/admin/stats/types', (req, res) => {
    db.get(`
        SELECT 
            SUM(CASE WHEN type = 'car' THEN 1 ELSE 0 END) as car,
            SUM(CASE WHEN type = 'person' THEN 1 ELSE 0 END) as person
        FROM requests
        WHERE type != 'opening'
    `, (err, row) => {
        res.json(row || { car: 0, person: 0 });
    });
});

app.get('/api/admin/requests', (req, res) => {
    const { search, status } = req.query;
    let query = `
        SELECT r.*, u.full_name as sender_name 
        FROM requests r
        JOIN users u ON r.sender_id = u.id
        WHERE r.type != 'opening'
    `;
    let params = [];
    if (search) {
        query += ` AND (r.description LIKE ? OR u.full_name LIKE ?)`;
        params.push(`%${search}%`, `%${search}%`);
    }
    if (status && status !== 'all') {
        query += ` AND r.status = ?`;
        params.push(status);
    }
    query += ` ORDER BY r.created_at DESC`;
    db.all(query, params, (err, rows) => {
        res.json(rows || []);
    });
});

app.put('/api/admin/requests/:id', (req, res) => {
    const { id } = req.params;
    const { type, description, date_from, date_to, status, reject_reason } = req.body;
    db.run(`
        UPDATE requests 
        SET type = ?, description = ?, date_from = ?, date_to = ?, status = ?, reject_reason = ?
        WHERE id = ? AND type != 'opening'
    `, [type, description, date_from, date_to, status, reject_reason, id], function(err) {
        res.json({ success: !err });
    });
});

app.get('/api/admin/chat-logs', (req, res) => {
    const { search } = req.query;
    let query = `
        SELECT m.*, u.full_name as sender_name 
        FROM messages m
        JOIN users u ON m.sender_id = u.id
    `;
    let params = [];
    if (search) {
        query += ` WHERE m.message LIKE ?`;
        params.push(`%${search}%`);
    }
    query += ` ORDER BY m.created_at DESC LIMIT 200`;
    db.all(query, params, (err, rows) => {
        res.json(rows || []);
    });
});

app.get('/api/admin/settings', (req, res) => {
    db.all(`SELECT key, value FROM settings`, (err, rows) => {
        const result = {};
        rows.forEach(row => result[row.key] = row.value);
        res.json(result);
    });
});

app.put('/api/admin/settings', (req, res) => {
    const settings = req.body;
    const queries = Object.keys(settings).map(key => {
        return new Promise((resolve) => {
            db.run(`UPDATE settings SET value = ? WHERE key = ?`, [settings[key], key], () => resolve());
        });
    });
    Promise.all(queries).then(() => res.json({ success: true }));
});

// ========== API для авторизации ==========

app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    db.get(`SELECT id, username, full_name, role, guard_post, email FROM users WHERE username = ? AND password = ?`, [username, password], (err, user) => {
        if (user) res.json(user);
        else res.status(401).json({ error: 'Неверный логин или пароль' });
    });
});

app.listen(PORT, () => {
    console.log(`
================================================
Сервер запущен: http://localhost:${PORT}
Админ: admin/admin123

Посты охраны:
- guard4 (Пост N4) - только машины
- guard1 (Пост N1) - только люди
- guard3 (ПЦО) - согласование заявок + уведомления об открытии

Функции:
- Обычные заявки (машины/люди)
- Уведомления об открытии цехов/складов
- Чат между постами
- Email уведомления (если настроены)
================================================
`);
});