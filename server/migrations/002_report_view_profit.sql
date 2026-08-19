-- 002_report_view_profit.sql
--
-- Adds `report.view_profit` to the permission vocabulary (docs/DECISIONS.md D25).
--
-- Profit visibility has to be a role permission, not only the global
-- `show_profit_while_billing` toggle seeded in 001_foundation.sql. That toggle
-- is one switch for the whole shop: turning it on for the office turns it on at
-- the counters too, and a cashier who can see margin on every line is a leak.
-- The setting says whether the billing screen has a margin column at all; this
-- permission says who is allowed to look at it.
--
-- Owner only. 001 seeded Cashier with bill.create and Supervisor with
-- bill.void and stock.adjust — neither has any reason to see cost. Grants are
-- editable configuration (roles.is_system = false), so the owner can widen this
-- from the roles screen without a migration.
--
-- The migration runner wraps this file in a single transaction — no explicit
-- BEGIN/COMMIT here.

INSERT INTO permissions (key, module, description) VALUES
  ('report.view_profit', 'report', 'See cost, margin and profit figures on screens and reports.');

-- 001 granted the owner role everything by matching on role code alone, which
-- covered the permissions that existed at that moment. A permission added later
-- has to be granted explicitly or nobody holds it.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON p.key = 'report.view_profit'
 WHERE r.code = 'owner';
