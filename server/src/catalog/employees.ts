import type { SignedInEmployee } from '@ssbazar/shared';

import type { Queryable } from '../db/queryable.js';
import { asRow, readId, readNullableText, readText } from '../db/rows.js';

/**
 * Who is at the machine.
 *
 * The whole of it, for R0: list the active employees, and confirm one exists.
 * There is no password check here, which is a deliberate limit and not an
 * oversight - see `signIn` in `api.ts` for what that does and does not buy.
 *
 * It lives beside the catalogue rather than in a module of its own because the
 * only thing that needs it today is `changed_by` on a price or slab change.
 * When roles and permissions arrive (`docs/DECISIONS.md` D25) this is what they
 * grow out of.
 */

const ACTIVE_EMPLOYEES_SQL = `
  SELECT e.id,
         e.emp_code,
         e.name,
         e.preferred_language,
         r.name AS role_name
    FROM employees e
    LEFT JOIN roles r ON r.id = e.role_id
   WHERE e.status = 'active'
   ORDER BY e.name, e.id`;

const EMPLOYEE_SQL = `
  SELECT e.id,
         e.emp_code,
         e.name,
         e.preferred_language,
         r.name AS role_name
    FROM employees e
    LEFT JOIN roles r ON r.id = e.role_id
   WHERE e.id = $1 AND e.status = 'active'`;

function toEmployee(value: unknown): SignedInEmployee {
  const row = asRow(value);
  return {
    employeeId: readId(row, 'id'),
    empCode: readText(row, 'emp_code'),
    name: readText(row, 'name'),
    roleName: readNullableText(row, 'role_name'),
    preferredLanguage: readNullableText(row, 'preferred_language'),
  };
}

/**
 * Everyone who could be at the machine, for the sign-in list.
 *
 * Active only. A discontinued employee must not be selectable, or a change made
 * after somebody left is attributed to them - which is worse than an unattributed
 * change, because it looks like an answer.
 */
export async function listActiveEmployees(db: Queryable): Promise<SignedInEmployee[]> {
  const { rows } = await db.query(ACTIVE_EMPLOYEES_SQL);
  return rows.map(toEmployee);
}

/** One active employee, or null - which `signIn` treats as a refusal. */
export async function findActiveEmployee(
  db: Queryable,
  employeeId: number,
): Promise<SignedInEmployee | null> {
  const { rows } = await db.query(EMPLOYEE_SQL, [employeeId]);
  const [row] = rows;
  return row === undefined ? null : toEmployee(row);
}
