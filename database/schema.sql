-- =============================================
--  PropFlow — MySQL Database Schema
--  Run this in MySQL Workbench (step 1)
--  Or: mysql -u root -p < database/schema.sql
-- =============================================

CREATE DATABASE IF NOT EXISTS propflow_db
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE propflow_db;

-- ─── SETTINGS ────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  company_name  VARCHAR(255)  NOT NULL DEFAULT 'PropFlow Properties',
  address       VARCHAR(500)  DEFAULT '',
  phone         VARCHAR(50)   DEFAULT '',
  mpesa_number  VARCHAR(50)   DEFAULT '',
  bank_account  VARCHAR(100)  DEFAULT '',
  bank_name     VARCHAR(100)  DEFAULT '',
  updated_at    TIMESTAMP     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Seed default settings row
INSERT INTO settings (company_name, address, phone, email, mpesa_number, bank_account, bank_name)
VALUES ('JKL PROPERTIES', 'Nairobi, Kenya',
        '+254 115558365', 'johnkennedymunjogu@gmail.com',
        '0700 000 000', '1234567890', 'Equity Bank')
ON DUPLICATE KEY UPDATE id = id;

-- ─── TENANTS ─────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  tenant_name         VARCHAR(255)   NOT NULL,
  unit_number         VARCHAR(50)    NOT NULL,
  phone               VARCHAR(50)    DEFAULT '',

  -- Water meter
  previous_reading    DECIMAL(10,2)  NOT NULL DEFAULT 0,
  current_reading     DECIMAL(10,2)  NOT NULL DEFAULT 0,
  units_consumed      DECIMAL(10,2)  GENERATED ALWAYS AS (current_reading - previous_reading) STORED,
  rate_per_unit       DECIMAL(10,2)  NOT NULL DEFAULT 0,
  water_bill          DECIMAL(10,2)  GENERATED ALWAYS AS ((current_reading - previous_reading) * rate_per_unit) STORED,

  -- Rent
  base_rent           DECIMAL(10,2)  NOT NULL DEFAULT 0,
  payment_status      ENUM('pending','paid','overdue') NOT NULL DEFAULT 'pending',
  due_date            DATE           DEFAULT NULL,

  -- Other charges (individual columns for reporting)
  ch_electricity      DECIMAL(10,2)  DEFAULT 0,
  ch_tokens           DECIMAL(10,2)  DEFAULT 0,
  ch_repair_works     DECIMAL(10,2)  DEFAULT 0,
  ch_house_refunds    DECIMAL(10,2)  DEFAULT 0,
  ch_garbage          DECIMAL(10,2)  DEFAULT 0,

  -- Computed totals (stored for fast queries)
  other_charges       DECIMAL(10,2)  NOT NULL DEFAULT 0,
  total_rent          DECIMAL(10,2)  NOT NULL DEFAULT 0,

  created_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  updated_at          TIMESTAMP      DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,

  INDEX idx_unit       (unit_number),
  INDEX idx_status     (payment_status),
  INDEX idx_due_date   (due_date)
);

-- ─── PAYMENT HISTORY ─────────────────────────
CREATE TABLE IF NOT EXISTS payment_history (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id     INT            NOT NULL,
  amount_paid   DECIMAL(10,2)  NOT NULL,
  payment_date  DATE           NOT NULL,
  method        VARCHAR(50)    DEFAULT 'M-Pesa',
  reference     VARCHAR(100)   DEFAULT '',
  notes         TEXT           NULL,
  recorded_at   TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  INDEX idx_tenant  (tenant_id),
  INDEX idx_date    (payment_date)
);

-- ─── WATER METER HISTORY ─────────────────────
CREATE TABLE IF NOT EXISTS water_history (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  tenant_id         INT            NOT NULL,
  reading_date      DATE           NOT NULL,
  previous_reading  DECIMAL(10,2)  NOT NULL,
  current_reading   DECIMAL(10,2)  NOT NULL,
  units_consumed    DECIMAL(10,2)  NOT NULL,
  rate_per_unit     DECIMAL(10,2)  NOT NULL,
  water_bill        DECIMAL(10,2)  NOT NULL,
  recorded_at       TIMESTAMP      DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  INDEX idx_tenant  (tenant_id),
  INDEX idx_date    (reading_date)
);

-- ─── USEFUL VIEWS ────────────────────────────

-- Dashboard summary view
CREATE OR REPLACE VIEW v_dashboard_summary AS
SELECT
  COUNT(*)                                          AS total_tenants,
  SUM(total_rent)                                   AS total_revenue,
  SUM(water_bill)                                   AS total_water_bills,
  SUM(CASE WHEN payment_status != 'paid' THEN total_rent ELSE 0 END) AS pending_amount,
  SUM(CASE WHEN payment_status = 'paid'  THEN 1 ELSE 0 END)         AS paid_count,
  SUM(CASE WHEN payment_status = 'overdue' THEN 1 ELSE 0 END)       AS overdue_count,
  AVG(total_rent)                                   AS avg_rent
FROM tenants;

-- Top water consumers view
CREATE OR REPLACE VIEW v_top_water_consumers AS
SELECT
  id, tenant_name, unit_number,
  units_consumed, water_bill
FROM tenants
ORDER BY units_consumed DESC;
