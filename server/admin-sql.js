import { hashPassword } from './auth.js';

// Explicit E strings escape both quotes and backslashes, independent of the
// SQL editor's standard_conforming_strings setting.
const literal = value => `E'${value.replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;

export async function adminCreationSql(email, password) {
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) throw new Error('Enter a valid email address.');
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('Use a password between 12 and 256 characters.');
  const hash = await hashPassword(password);
  return `WITH available_slot AS (
  SELECT slot.id FROM (VALUES (1), (2)) AS slot(id)
  WHERE NOT EXISTS (SELECT 1 FROM admin WHERE admin.id = slot.id)
  ORDER BY slot.id LIMIT 1
)
INSERT INTO admin (id, email, password_hash)
SELECT id, ${literal(email.trim().toLowerCase())}, ${literal(hash)} FROM available_slot
ON CONFLICT DO NOTHING
RETURNING id, email;`;
}
