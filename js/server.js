// =============================================
//  PropFlow — Express + MySQL2 Backend Server
// =============================================
import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import mysql from 'mysql2/promise';
import AfricasTalking from 'africastalking';

dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ──────────────────────────────
app.use(cors({ origin: '*' }));   // Tighten in production
app.use(express.json());

// ── DB Pool ─────────────────────────────────
const pool = mysql.createPool({
  host:               process.env.DB_HOST     || 'localhost',
  port:               parseInt(process.env.DB_PORT || '3306'),
  user:               process.env.DB_USER     || 'root',
  password:           process.env.DB_PASSWORD || '',
  database:           process.env.DB_NAME     || 'propflow_db',
  waitForConnections: true,
  connectionLimit:    10,
  queueLimit:         0
});

// Test connection on startup
pool.getConnection()
  .then(conn => {
    console.log('✅  MySQL connected — PropFlow DB ready');
    conn.release();
  })
  .catch(err => {
    console.error('❌  MySQL connection failed:', err.message);
    process.exit(1);
  });

// ── Africa's Talking SMS ─────────────────────
const AT = AfricasTalking({
  username: process.env.AT_USERNAME,
  apiKey:   process.env.AT_API_KEY
});
const sms = AT.SMS;

// ── Helper: compute totals from body ────────
function computeTotals(b) {
  const otherCharges =
    (b.ch_electricity    || 0) + (b.ch_tokens        || 0) +
    (b.ch_security_pump  || 0) + (b.ch_caretaker_wifi|| 0) +
    (b.ch_wifi_cctv      || 0) + (b.ch_security      || 0) +
    (b.ch_rujuwasco      || 0) + (b.ch_care_taker     || 0) +
    (b.ch_repair_works   || 0) + (b.ch_bio_digester   || 0) +
    (b.ch_repainting     || 0) + (b.ch_wifi           || 0) +
    (b.ch_house_refunds  || 0) + (b.ch_garbage        || 0) +
    (b.ch_other          || 0);

  const waterBill =
    ((b.current_reading || 0) - (b.previous_reading || 0)) *
    (b.rate_per_unit || 0);

  const totalRent = (b.base_rent || 0) + waterBill + otherCharges;
  return { otherCharges, totalRent };
}

// ── Helper: map DB row → frontend tenant obj ─
function rowToTenant(row) {
  return {
    id:                row.id,
    tenantName:        row.tenant_name,
    unitNumber:        row.unit_number,
    email:             row.email,
    phone:             row.phone,
    previousReading:   parseFloat(row.previous_reading),
    currentReading:    parseFloat(row.current_reading),
    unitsConsumed:     parseFloat(row.units_consumed),
    ratePerUnit:       parseFloat(row.rate_per_unit),
    waterBill:         parseFloat(row.water_bill),
    baseRent:          parseFloat(row.base_rent),
    paymentStatus:     row.payment_status,
    dueDate:           row.due_date ? row.due_date.toISOString().split('T')[0] : null,
    otherCharges:      parseFloat(row.other_charges),
    totalRent:         parseFloat(row.total_rent),
    createdAt:         row.created_at,
    otherChargesBreakdown: {
      electricity:   parseFloat(row.ch_electricity),
      tokens:        parseFloat(row.ch_tokens),
      securityPump:  parseFloat(row.ch_security_pump),
      caretakerWifi: parseFloat(row.ch_caretaker_wifi),
      wifiCCTV:      parseFloat(row.ch_wifi_cctv),
      security:      parseFloat(row.ch_security),
      rujuwasco:     parseFloat(row.ch_rujuwasco),
      careTaker:     parseFloat(row.ch_care_taker),
      repairWorks:   parseFloat(row.ch_repair_works),
      bioDigester:   parseFloat(row.ch_bio_digester),
      repainting:    parseFloat(row.ch_repainting),
      wifi:          parseFloat(row.ch_wifi),
      houseRefunds:  parseFloat(row.ch_house_refunds),
      garbage:       parseFloat(row.ch_garbage),
      other:         parseFloat(row.ch_other),
    }
  };
}

// ── SMS Helper: format phone to E.164 ───────
// 07XXXXXXXX  → +2547XXXXXXXX
// 2547XXXXXXXX → +2547XXXXXXXX
// +2547XXXXXXXX → unchanged
function toE164(phone) {
  if (!phone) return null;
  const clean = phone.replace(/[\s\-().]/g, '');
  if (clean.startsWith('+'))   return clean;
  if (clean.startsWith('254')) return `+${clean}`;
  if (clean.startsWith('0'))   return `+254${clean.slice(1)}`;
  return `+254${clean}`;
}

// ── SMS Helper: build reminder message ──────
function buildMessage(tenant, cfg) {
  const due = tenant.due_date
    ? new Date(tenant.due_date).toLocaleDateString('en-GB')
    : 'soon';
  const amount = parseFloat(tenant.total_rent).toLocaleString('en-KE', {
    minimumFractionDigits: 0, maximumFractionDigits: 0
  });
  return (
    `Dear ${tenant.tenant_name}, your rent of KES ${amount} ` +
    `for unit ${tenant.unit_number} is due on ${due}. ` +
    `Please pay via M-Pesa: ${cfg.mpesa_number || 'N/A'}. ` +
    `Thank you — ${cfg.company_name || 'PropFlow'}.`
  );
}

// ── SMS Helper: log to DB (non-fatal) ───────
async function logReminder(tenantId, phone, status, error = null) {
  await pool.query(
    `INSERT INTO reminder_log (tenant_id, phone, status, error_msg, sent_at)
     VALUES (?, ?, ?, ?, NOW())
     ON DUPLICATE KEY UPDATE
       status    = VALUES(status),
       error_msg = VALUES(error_msg),
       sent_at   = NOW()`,
    [tenantId, phone, status, error]
  ).catch(() => {});
}

// ══════════════════════════════════════════════
//  TENANT ROUTES
// ══════════════════════════════════════════════

// GET /api/tenants
app.get('/api/tenants', async (req, res) => {
  try {
    const { search = '', status = 'all', sort = 'name' } = req.query;

    let sql = 'SELECT * FROM tenants WHERE 1=1';
    const params = [];

    if (search) {
      sql += ' AND (tenant_name LIKE ? OR unit_number LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (status !== 'all') {
      sql += ' AND payment_status = ?';
      params.push(status);
    }

    const orderMap = {
      name:         'tenant_name ASC',
      unit:         'unit_number ASC',
      'rent-high':  'total_rent DESC',
      'rent-low':   'total_rent ASC',
      'water-high': 'water_bill DESC'
    };
    sql += ` ORDER BY ${orderMap[sort] || 'tenant_name ASC'}`;

    const [rows] = await pool.query(sql, params);
    res.json(rows.map(rowToTenant));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/tenants/:id
app.get('/api/tenants/:id', async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json(rowToTenant(rows[0]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/tenants — create
app.post('/api/tenants', async (req, res) => {
  try {
    const b = req.body;
    const { otherCharges, totalRent } = computeTotals(b);

    const [result] = await pool.query(
      `INSERT INTO tenants
       (tenant_name, unit_number, email, phone,
        previous_reading, current_reading, rate_per_unit,
        base_rent, payment_status, due_date,
        ch_electricity, ch_tokens, ch_security_pump, ch_caretaker_wifi,
        ch_wifi_cctv, ch_security, ch_rujuwasco, ch_care_taker,
        ch_repair_works, ch_bio_digester, ch_repainting, ch_wifi,
        ch_house_refunds, ch_garbage, ch_other,
        other_charges, total_rent)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        b.tenant_name, b.unit_number, b.email||'', b.phone||'',
        b.previous_reading||0, b.current_reading||0, b.rate_per_unit||0,
        b.base_rent||0, b.payment_status||'pending', b.due_date||null,
        b.ch_electricity||0, b.ch_tokens||0, b.ch_security_pump||0, b.ch_caretaker_wifi||0,
        b.ch_wifi_cctv||0, b.ch_security||0, b.ch_rujuwasco||0, b.ch_care_taker||0,
        b.ch_repair_works||0, b.ch_bio_digester||0, b.ch_repainting||0, b.ch_wifi||0,
        b.ch_house_refunds||0, b.ch_garbage||0, b.ch_other||0,
        otherCharges, totalRent
      ]
    );

    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [result.insertId]);
    res.status(201).json(rowToTenant(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/tenants/:id — update
app.put('/api/tenants/:id', async (req, res) => {
  try {
    const b = req.body;
    const { otherCharges, totalRent } = computeTotals(b);

    await pool.query(
      `UPDATE tenants SET
        tenant_name=?, unit_number=?, email=?, phone=?,
        previous_reading=?, current_reading=?, rate_per_unit=?,
        base_rent=?, payment_status=?, due_date=?,
        ch_electricity=?, ch_tokens=?, ch_security_pump=?, ch_caretaker_wifi=?,
        ch_wifi_cctv=?, ch_security=?, ch_rujuwasco=?, ch_care_taker=?,
        ch_repair_works=?, ch_bio_digester=?, ch_repainting=?, ch_wifi=?,
        ch_house_refunds=?, ch_garbage=?, ch_other=?,
        other_charges=?, total_rent=?
       WHERE id=?`,
      [
        b.tenant_name, b.unit_number, b.email||'', b.phone||'',
        b.previous_reading||0, b.current_reading||0, b.rate_per_unit||0,
        b.base_rent||0, b.payment_status||'pending', b.due_date||null,
        b.ch_electricity||0, b.ch_tokens||0, b.ch_security_pump||0, b.ch_caretaker_wifi||0,
        b.ch_wifi_cctv||0, b.ch_security||0, b.ch_rujuwasco||0, b.ch_care_taker||0,
        b.ch_repair_works||0, b.ch_bio_digester||0, b.ch_repainting||0, b.ch_wifi||0,
        b.ch_house_refunds||0, b.ch_garbage||0, b.ch_other||0,
        otherCharges, totalRent,
        req.params.id
      ]
    );

    const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Tenant not found' });
    res.json(rowToTenant(rows[0]));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tenants/:id/status — quick status update
app.patch('/api/tenants/:id/status', async (req, res) => {
  try {
    const { payment_status } = req.body;
    if (!['paid','pending','overdue'].includes(payment_status))
      return res.status(400).json({ error: 'Invalid status' });

    await pool.query(
      'UPDATE tenants SET payment_status = ? WHERE id = ?',
      [payment_status, req.params.id]
    );

    if (payment_status === 'paid') {
      const [rows] = await pool.query('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
      if (rows.length) {
        await pool.query(
          'INSERT INTO payment_history (tenant_id, amount_paid, payment_date) VALUES (?,?,CURDATE())',
          [req.params.id, rows[0].total_rent]
        );
      }
    }

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/tenants/bulk/status — mark multiple
app.patch('/api/tenants/bulk/status', async (req, res) => {
  try {
    const { ids, payment_status } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids array required' });

    const placeholders = ids.map(() => '?').join(',');
    await pool.query(
      `UPDATE tenants SET payment_status = ? WHERE id IN (${placeholders})`,
      [payment_status, ...ids]
    );
    res.json({ success: true, updated: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tenants/:id
app.delete('/api/tenants/:id', async (req, res) => {
  try {
    const [result] = await pool.query('DELETE FROM tenants WHERE id = ?', [req.params.id]);
    if (result.affectedRows === 0)
      return res.status(404).json({ error: 'Tenant not found' });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/tenants/bulk
app.delete('/api/tenants/bulk', async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0)
      return res.status(400).json({ error: 'ids array required' });

    const placeholders = ids.map(() => '?').join(',');
    await pool.query(`DELETE FROM tenants WHERE id IN (${placeholders})`, ids);
    res.json({ success: true, deleted: ids.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
//  SETTINGS ROUTES
// ══════════════════════════════════════════════

app.get('/api/settings', async (_req, res) => {
  try {
    const [rows] = await pool.query('SELECT * FROM settings LIMIT 1');
    if (!rows.length) return res.status(404).json({ error: 'No settings found' });
    const r = rows[0];
    res.json({
      companyName:    r.company_name,
      companyAddress: r.address,
      companyPhone:   r.phone,
      companyEmail:   r.email,
      mpesaNumber:    r.mpesa_number,
      bankAccount:    r.bank_account,
      bankName:       r.bank_name
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put('/api/settings', async (req, res) => {
  try {
    const b = req.body;
    const [existing] = await pool.query('SELECT id FROM settings LIMIT 1');
    if (existing.length) {
      await pool.query(
        `UPDATE settings SET
          company_name=?, address=?, phone=?, email=?,
          mpesa_number=?, bank_account=?, bank_name=?
         WHERE id=?`,
        [b.companyName, b.companyAddress, b.companyPhone, b.companyEmail,
         b.mpesaNumber, b.bankAccount, b.bankName, existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO settings (company_name,address,phone,email,mpesa_number,bank_account,bank_name)
         VALUES (?,?,?,?,?,?,?)`,
        [b.companyName, b.companyAddress, b.companyPhone, b.companyEmail,
         b.mpesaNumber, b.bankAccount, b.bankName]
      );
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
//  DASHBOARD STATS
// ══════════════════════════════════════════════

app.get('/api/stats', async (_req, res) => {
  try {
    const [[summary]] = await pool.query('SELECT * FROM v_dashboard_summary');
    res.json({
      totalTenants:    summary.total_tenants || 0,
      totalRevenue:    parseFloat(summary.total_revenue)     || 0,
      totalWaterBills: parseFloat(summary.total_water_bills) || 0,
      pendingAmount:   parseFloat(summary.pending_amount)    || 0,
      paidCount:       summary.paid_count    || 0,
      overdueCount:    summary.overdue_count || 0,
      avgRent:         parseFloat(summary.avg_rent)          || 0
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
//  PAYMENT HISTORY
// ══════════════════════════════════════════════

app.get('/api/payment-history', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    let sql = `
      SELECT ph.*, t.tenant_name, t.unit_number
      FROM payment_history ph
      JOIN tenants t ON t.id = ph.tenant_id
    `;
    const params = [];
    if (tenant_id) { sql += ' WHERE ph.tenant_id = ?'; params.push(tenant_id); }
    sql += ' ORDER BY ph.payment_date DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
//  WATER HISTORY
// ══════════════════════════════════════════════

app.get('/api/water-history', async (req, res) => {
  try {
    const { tenant_id } = req.query;
    let sql = `
      SELECT wh.*, t.tenant_name, t.unit_number
      FROM water_history wh
      JOIN tenants t ON t.id = wh.tenant_id
    `;
    const params = [];
    if (tenant_id) { sql += ' WHERE wh.tenant_id = ?'; params.push(tenant_id); }
    sql += ' ORDER BY wh.reading_date DESC LIMIT 200';
    const [rows] = await pool.query(sql, params);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/water-history', async (req, res) => {
  try {
    const [tenants] = await pool.query('SELECT * FROM tenants');
    const today = new Date().toISOString().split('T')[0];
    const rows = tenants.map(t => [
      t.id, today,
      t.previous_reading, t.current_reading,
      t.units_consumed, t.rate_per_unit, t.water_bill
    ]);
    if (rows.length) {
      await pool.query(
        `INSERT INTO water_history
         (tenant_id, reading_date, previous_reading, current_reading,
          units_consumed, rate_per_unit, water_bill)
         VALUES ?`,
        [rows]
      );
    }
    res.json({ success: true, archived: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ══════════════════════════════════════════════
//  IMPORT (bulk insert)
// ══════════════════════════════════════════════

app.post('/api/tenants/import', async (req, res) => {
  const conn = await pool.getConnection();
  try {
    const tenants = req.body;
    await conn.beginTransaction();
    let count = 0;
    for (const b of tenants) {
      const { otherCharges, totalRent } = computeTotals(b);
      await conn.query(
        `INSERT INTO tenants
         (tenant_name, unit_number, email, phone,
          previous_reading, current_reading, rate_per_unit,
          base_rent, payment_status, due_date,
          ch_electricity, ch_tokens, ch_security_pump, ch_caretaker_wifi,
          ch_wifi_cctv, ch_security, ch_rujuwasco, ch_care_taker,
          ch_repair_works, ch_bio_digester, ch_repainting, ch_wifi,
          ch_house_refunds, ch_garbage, ch_other,
          other_charges, total_rent)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          b.tenant_name||'Unknown', b.unit_number||'N/A',
          b.email||'', b.phone||'',
          b.previous_reading||0, b.current_reading||0, b.rate_per_unit||0,
          b.base_rent||0, b.payment_status||'pending', b.due_date||null,
          b.ch_electricity||0, b.ch_tokens||0, b.ch_security_pump||0, b.ch_caretaker_wifi||0,
          b.ch_wifi_cctv||0, b.ch_security||0, b.ch_rujuwasco||0, b.ch_care_taker||0,
          b.ch_repair_works||0, b.ch_bio_digester||0, b.ch_repainting||0, b.ch_wifi||0,
          b.ch_house_refunds||0, b.ch_garbage||0, b.ch_other||0,
          otherCharges, totalRent
        ]
      );
      count++;
    }
    await conn.commit();
    res.json({ success: true, imported: count });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

// ══════════════════════════════════════════════
//  SMS REMINDER ROUTES
// ══════════════════════════════════════════════

// POST /api/reminders/send
// Body: { tenant_ids: [1, 2, 3], force: true|false }
// force:true bypasses the "already sent today" guard (for manual sends)
app.post('/api/reminders/send', async (req, res) => {
  try {
    const { tenant_ids, force = false } = req.body;
    if (!Array.isArray(tenant_ids) || !tenant_ids.length)
      return res.status(400).json({ error: 'tenant_ids array required' });

    // Load settings for M-Pesa number and company name
    const [settingsRows] = await pool.query('SELECT * FROM settings LIMIT 1');
    const cfg = settingsRows[0] || {};

    // Load the requested tenants
    const placeholders = tenant_ids.map(() => '?').join(',');
    const [tenantRows] = await pool.query(
      `SELECT * FROM tenants WHERE id IN (${placeholders})`,
      tenant_ids
    );

    // Find tenants already reminded today (skip unless force=true)
    const [todayLogs] = await pool.query(
      `SELECT tenant_id FROM reminder_log
       WHERE DATE(sent_at) = CURDATE()
         AND status = 'sent'
         AND tenant_id IN (${placeholders})`,
      tenant_ids
    );
    const alreadySentToday = new Set(todayLogs.map(r => r.tenant_id));

    const results = [];
    let sent = 0, skipped = 0, failed = 0;

    for (const tenant of tenantRows) {
      const phone = toE164(tenant.phone);

      // Skip: no phone number
      if (!phone) {
        results.push({ id: tenant.id, name: tenant.tenant_name, status: 'skipped', reason: 'no phone' });
        skipped++;
        continue;
      }

      // Skip: already paid
      if (tenant.payment_status === 'paid') {
        results.push({ id: tenant.id, name: tenant.tenant_name, status: 'skipped', reason: 'already paid' });
        skipped++;
        continue;
      }

      // Skip: already reminded today (unless forced)
      if (alreadySentToday.has(tenant.id) && !force) {
        results.push({ id: tenant.id, name: tenant.tenant_name, status: 'skipped', reason: 'already sent today' });
        skipped++;
        continue;
      }

      const message = buildMessage(tenant, cfg);

      // ── DEBUG: log exactly what we're sending ──
      console.log('─── SMS DEBUG ───────────────────────────');
      console.log('AT_USERNAME  :', process.env.AT_USERNAME);
      console.log('AT_API_KEY   :', process.env.AT_API_KEY ? '✓ set (' + process.env.AT_API_KEY.slice(0,6) + '...)' : '✗ MISSING');
      console.log('AT_SENDER_ID :', process.env.AT_SENDER_ID || '(none — using shortcode)');
      console.log('To           :', phone);
      console.log('Message      :', message);
      console.log('─────────────────────────────────────────');

      try {
        const atResponse = await sms.send({
          to:      [phone],
          message,
          from:    process.env.AT_SENDER_ID || undefined
        });
        // ── DEBUG: log full AT response ──
        console.log('AT response:', JSON.stringify(atResponse, null, 2));

        const recipients = atResponse?.SMSMessageData?.Recipients || [];
        const firstRecipient = recipients[0] || {};
        console.log('Recipient status:', firstRecipient.status);
        console.log('Recipient cost  :', firstRecipient.cost);

        await logReminder(tenant.id, phone, 'sent');
        results.push({ id: tenant.id, name: tenant.tenant_name, phone, status: 'sent', atResponse });
        sent++;
      } catch (smsErr) {
        const errMsg = smsErr.message || String(smsErr);
        console.error('─── SMS ERROR ───────────────────────────');
        console.error('Error:', errMsg);
        console.error('Full error object:', smsErr);
        console.error('─────────────────────────────────────────');
        await logReminder(tenant.id, phone, 'failed', errMsg);
        results.push({ id: tenant.id, name: tenant.tenant_name, phone, status: 'failed', error: errMsg });
        failed++;
      }
    }

    res.json({ sent, skipped, failed, results });
  } catch (err) {
    console.error('Reminder route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reminders/log — reminder history (latest 200)
app.get('/api/reminders/log', async (_req, res) => {
  try {
    const [rows] = await pool.query(`
      SELECT rl.*, t.tenant_name, t.unit_number
      FROM reminder_log rl
      JOIN tenants t ON t.id = rl.tenant_id
      ORDER BY rl.sent_at DESC
      LIMIT 200
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/reminders/upcoming?days=7 — tenants due within N days
app.get('/api/reminders/upcoming', async (req, res) => {
  try {
    const days = parseInt(req.query.days || '7');
    const [rows] = await pool.query(`
      SELECT id, tenant_name, unit_number, phone, due_date,
             total_rent, payment_status
      FROM tenants
      WHERE payment_status != 'paid'
        AND due_date IS NOT NULL
        AND due_date BETWEEN CURDATE() AND DATE_ADD(CURDATE(), INTERVAL ? DAY)
      ORDER BY due_date ASC
    `, [days]);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Health check ─────────────────────────────
app.get('/api/health', (_req, res) => res.json({ status: 'ok', time: new Date() }));
export default app;
