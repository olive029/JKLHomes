-- =============================================
--  PropFlow — Migration: Add Reminder System
--  Run in MySQL Workbench AFTER schema.sql (step 2)
--  Or: mysql -u root -p < database/migration-reminders.sql
--
--  Fixed: MySQL doesn't allow DATE() function
--  inside UNIQUE KEY definition directly.
--  Solution: use a generated column instead.
-- =============================================

USE propflow_db;

CREATE TABLE IF NOT EXISTS reminder_log (
  id          INT           NOT NULL AUTO_INCREMENT,
  tenant_id   INT           NOT NULL,
  phone       VARCHAR(20)   NOT NULL,
  status      ENUM('sent','failed') NOT NULL DEFAULT 'sent',
  error_msg   TEXT          NULL,
  sent_at     DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,

  -- Virtual column we can put in a UNIQUE KEY
  sent_date   DATE          GENERATED ALWAYS AS (DATE(sent_at)) VIRTUAL,

  PRIMARY KEY (id),
  KEY idx_tenant  (tenant_id),
  KEY idx_sent_at (sent_at),
  UNIQUE KEY uq_tenant_day (tenant_id, sent_date),

  FOREIGN KEY (tenant_id)
    REFERENCES tenants(id)
    ON DELETE CASCADE
);
