# Security Specification — CARL PETERS Asistencia & Nómina PY 2026

## 1. Data Invariants
1. Every Firestore read or write requires a verified Firebase Auth user (`request.auth != null && request.auth.token.email_verified == true`).
2. `settings/company` is readable by verified users (`get` only, no `list`) and writable only by verified admins.
3. `employees/{employeeId}` contains PII (`ci`, `pin`, `email`) and is readable only by verified admins or the employee owning the record (`ownerUid == request.auth.uid` or verified `email == request.auth.token.email`).
4. A non-admin cannot create an employee record with another user's `ownerUid`, nor promote themselves into `/admins`.
5. `marks/{markId}`, `gpsLive/{employeeId}`, and `gpsHistory/{histId}` must reference an existing `/employees/{employeeId}` document on create, and non-admins can only read/write documents where `ownerUid == request.auth.uid`.
6. Every timestamp (`createdAt`, `updatedAt`) is strictly bound to `request.time`, and `createdAt`, `employeeId`, `date`, and `ownerUid` are immutable once written (except verified email-based first claim of `ownerUid` on an admin-created employee).
7. All arrays (`points` in `gpsHistory`) are strictly bounded (`<= 300`) and element-checked (`points[0] is map`). All strings enforce explicit `.size()` and regex bounds.

## 2. The "Dirty Dozen" Adversarial Payloads
1. **Unauthenticated read on `/employees/emp1`**: Must fail (`PERMISSION_DENIED`).
2. **Unverified email admin spoof (`email: "jociaperalta1@gmail.com", email_verified: false`)**: Must fail.
3. **Cross-user PII read (`/employees/emp_other` by non-owner non-admin)**: Must fail.
4. **Blanket scrape (`list /employees` without owner filter by non-admin)**: Must fail.
5. **Identity spoofing (`create /employees/emp_fake` with `ownerUid: "victim_uid"`)**: Must fail.
6. **Privilege escalation (`create /admins/attacker_uid`)**: Must fail.
7. **Shadow field injection (`create /employees/emp1` with extra key `isAdmin: true`)**: Must fail via `hasOnly`.
8. **Orphan attendance mark (`create /marks/ghost_2026-11-26` where `/employees/ghost` does not exist)**: Must fail via `exists()`.
9. **Path ID poisoning (`create /employees/../../evil` or 200-char ID)**: Must fail via `isValidId()`.
10. **Timestamp forgery (`create /marks/emp1_2026-11-26` with client `createdAt` != `request.time`)**: Must fail.
11. **Value poisoning on update (`update /marks/emp1_2026-11-26` setting `e1: "not-a-time"` or `lat: 999`)**: Must fail via `isValidMark()`.
12. **Unbounded GPS array DoS (`update /gpsHistory/emp1_2026-11-26` with 301 points)**: Must fail via `points.size() <= 300`.
