# Clearstage runbook

Operational notes for the founder. The full on-call runbook (CTO deliverable E3, due 11 Dec) extends this file.

## Access
- `platform_admin` is set by hand in the SQL editor; the founder is its only member.

## Roles (017, G2)
- Roles live in `member_role` (super_admin, hr, recruiter, manager) with the `see_pay` and `offer_approver` flags on `member`. They change only through Settings → People (`set_member_roles`, `invite_member`): Super admin only, never your own, every change in the company's audit log (`roles_changed`, `member_invited`, `invite_accepted`).
- `member.app_role` is a read-only mirror of the roles for one release, so today's rules keep working. Don't edit it in the SQL editor; if you must, the roles are re-mapped from it automatically. It is removed in the release after go-live, with the role permissions.

## Employee logins (018)
- Employees are never members. Their login is a row in `employee_account` (company, person, email, user), given by HR or a Super admin in Settings → Employee logins and change requests (`invite_employee`). They sign in with that email and see only their own record (`my_employee`).
- An email with a staff login can't also be an Employee login, and an Employee login can't create a workspace.
- Changes employees ask for (`request_profile_change`) apply only when HR or a Super admin approves them (`decide_profile_change`); every step is in the audit log.
- The public demo has five role logins (`admin@`, `hr@`, `recruiter@`, `manager@`, `employee@acme.demo`). They exist only in the signed-out demo, never in the database.
