# Clearstage runbook

Operational notes for the founder. The full on-call runbook (CTO deliverable E3, due 11 Dec) extends this file.

## Access
- `platform_admin` is set by hand in the SQL editor; the founder is its only member.

## Roles (017, G2)
- Roles live in `member_role` (super_admin, hr, recruiter, manager) with the `see_pay` and `offer_approver` flags on `member`. They change only through Settings → People (`set_member_roles`, `invite_member`): Super admin only, never your own, every change in the company's audit log (`roles_changed`, `member_invited`, `invite_accepted`).
- `member.app_role` is a read-only mirror of the roles for one release, so today's rules keep working. Don't edit it in the SQL editor; if you must, the roles are re-mapped from it automatically. It is removed in the release after go-live, with the role permissions.
