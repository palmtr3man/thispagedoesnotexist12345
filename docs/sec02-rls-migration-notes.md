# SEC-02 · RLS Migration Notes

## Purpose

SEC-02 enables row-level security for the flagged cohort-platform tables and installs explicit policies for SELECT, INSERT, UPDATE, and DELETE surfaces. The migration file is `supabase/migrations/20260511_sec02_rls_flagged_tables.sql`.

The migration is intentionally **conditional**. It applies policy changes only to tables that exist in the target database, and it applies owner-only policies only when a recognized owner column is present. This lets the migration run safely across local, staging, and production environments while schema ownership is being finalized.

## Policy Classes

| Policy Class | Intended Tables | Access Model |
|---|---|---|
| `owner_admin` | User-owned and creator-owned records such as Resume, Application, Subscription, settings, seats, and passenger records. | Authenticated owners can CRUD their rows; admins can read/update/delete; `service_role` can perform all operations. |
| `admin_service` | Operational logs such as EmailLog and AuditLog. | Admins can read; `service_role` can perform all operations; non-admin authenticated users are denied by default. |
| `public_read` | Public metadata such as Flight, Cohort, template metadata, and LoadingDockMessage. | `anon` and authenticated users can read; only `service_role` can write. |
| `public_insert` | Public intake records such as WaitlistSubmission. | `anon` and authenticated users can insert; only `service_role` can read/update/delete. |

## Flagged Table Targets

The migration covers the priority tables named in the SEC-02 task first, then applies the same policy-class model across the remaining flagged table set. The table names are quoted CamelCase because the SEC-02 task names are entity-style names. Missing tables are skipped with a `NOTICE` so the migration remains portable while schema deployment catches up.

| Priority | Table | Policy Class |
|---:|---|---|
| 1 | `public."Resume"` | `owner_admin` |
| 2 | `public."Application"` | `owner_admin` |
| 3 | `public."Subscription"` | `owner_admin` |
| 4 | `public."GmailSyncState"` | `owner_admin` |
| 5 | `public."NotionSettings"` | `owner_admin` |
| 6 | `public."EmailLog"` | `admin_service` |
| 7 | `public."PassengerFlight"` | `owner_admin` |
| 8 | `public."Seat"` | `owner_admin` |
| 9–25 | Passenger, Flight, JobDescription, CoverLetter, ResumeVariant, SavedJob, Interview, FollowUp, Task, Reminder, LoadingDockMessage, EmailTemplate, TemplateRegistry, Cohort, AuditLog, WaitlistSubmission, UserProfile | Mixed policy classes based on owner/public/operational category. |

## Ownership Columns

For `owner_admin` tables, the migration detects the first available owner column from this ordered list: `user_id`, `owner_id`, `created_by`, `passenger_id`. If no recognized owner column exists, the migration emits a warning and installs only admin/service policies for that table. This prevents silent broad access while still allowing the migration to surface schema gaps during review.

## SEC-03 Alignment

The migration is designed to satisfy the SEC-03 acceptance scaffold for the priority validation surfaces: Resume, Application, Subscription, EmailLog, and LoadingDockMessage. After SEC-02 is applied in a database containing those tables and fixture users, run `supabase/sec03_rls_acceptance_tests.sql` to verify cross-user denial, owner-spoof prevention, admin access, public-write denial, and the EmailLog service-role policy surface.

## Known Follow-Ups

The database migration cannot prove that an EmailLog service-role write came only from an approved server-side function. That final assurance requires SEC-06 invocation hardening and SEC-09 audit logging. This migration establishes the database-side policy boundary that those follow-up tasks can enforce and observe.
