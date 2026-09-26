// ---------------------------------------------------------------------------
// App configuration.
// NOTE: only the PUBLISHABLE (anon) key is ever shipped to the browser.
// SUPABASE_SECRET_KEY must stay server-side - it is intentionally NOT used here.
// ---------------------------------------------------------------------------
export const SUPABASE_URL = 'https://pocxenregwbvwiikmvya.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_Xz_G5bUztlZUkBb-WFc15w_CUxYKBro';

export const STORAGE_KEY = 'campusbook.state.v1';

// Booking status codes (must match public.booking_statuses.code)
export const STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  CANCELLED: 'cancelled',
  COMPLETED: 'completed',
  EXPIRED: 'expired',
};

/**
 * Statuses that still occupy a resource slot -> used by the conflict engine.
 * Must stay in sync with slot_held in sql/02_overlap_guard.sql.
 * 'expired' is deliberately excluded: an expired booking frees its slot.
 */
export const BLOCKING_STATUSES = [STATUS.PENDING, STATUS.APPROVED, STATUS.COMPLETED];

// Roles seeded by the schema (see the seed block in the main schema file).
export const APPROVER_ROLES = ['faculty', 'resource_manager', 'department_admin', 'campus_admin', 'super_admin'];
export const ADMIN_ROLES = ['campus_admin', 'super_admin'];
export const MANAGER_ROLES = ['resource_manager', 'department_admin', 'campus_admin', 'super_admin'];

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
export const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
