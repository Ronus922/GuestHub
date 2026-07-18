# GUESTHUB — COMPLETE PMS ARCHITECTURE, STABILITY, SECURITY, CHANNEX CERTIFICATION AND PRODUCTION-READINESS PROGRAM

Version 2 — reviewed and extended. Section numbering is unchanged from Version 1; content was added, not removed.

## 0. PRIMARY MISSION

Work in:

`/var/www/guesthub`

The production checkout may exist at:

`/var/www/guesthub-production`

Your mission is to perform a complete system-wide engineering program for GuestHub.

This is not a request to add a few isolated Channex features.

Treat GuestHub as a serious commercial PMS product that must be redesigned, reconciled, hardened and completed to the standard expected from mature and stable property-management systems.

The final result must be:

1. A complete, coherent and maintainable PMS platform.
2. Stable enough for daily hotel and vacation-rental operations.
3. Architecturally consistent across all existing and new modules.
4. Safe against double bookings, lost reservations, incorrect prices and synchronization drift.
5. Ready to complete Channex PMS certification.
6. Ready for a future controlled transition from Channex Staging to Production.
7. Backed by a database infrastructure dedicated only to GuestHub.
8. Fully observable, testable, documented and recoverable.
9. Secure against credential leakage, tenant crossover, unauthorized access, forged requests and common application attacks.
10. Understandable by another senior engineer without relying on undocumented tribal knowledge.
11. Prepared for future growth to more properties, more tenants, more channels and substantially higher traffic.

You must inspect the entire existing codebase and determine:

* What is already designed correctly.
* What works but is fragile.
* What is incomplete.
* What is duplicated.
* What is obsolete.
* What is inconsistent.
* What will fail under real production load.
* What will become difficult to maintain.
* What mature PMS systems normally include that GuestHub currently lacks.
* Which missing capabilities are essential now.
* Which capabilities should be prepared architecturally but deferred until a later business phase.

Do not merely build new features around existing mistakes.

Reconcile the full system into one large, coherent technical plan and implementation.

The final product must behave as though its architecture, database, modules, background processing, security and operations had been planned correctly from the beginning.

---

# 1. FINAL TARGET

At the end of this program, GuestHub must have:

## Core PMS foundations

* A canonical property model.
* A canonical physical-room model.
* A canonical sellable-inventory model.
* A canonical reservation model.
* A canonical guest model.
* A canonical rate and restriction engine.
* A canonical payment ledger.
* A canonical channel-integration model.
* A canonical audit trail.
* A canonical background-job infrastructure.
* Clear ownership of every business rule.

## Operational stability

* Durable queues.
* Idempotent business operations.
* Transaction-safe reservation changes.
* Worker crash recovery.
* Retry and dead-letter handling.
* Explicit conflict management.
* Database backups and tested restores.
* Health checks.
* Monitoring.
* Operational dashboards.
* Safe deployments.
* Rollback procedures.
* No silent failures.

## Product completeness

The system should cover the important foundations expected from a mature PMS, including:

* Properties and business identity.
* Rooms and sellable units.
* Room types and attributes.
* Rate plans.
* Pricing and restrictions.
* Availability.
* Reservations.
* Guests.
* Payments and balances.
* Cancellation policies.
* Calendar.
* Channel management.
* Email and messaging.
* Tasks and operational follow-up.
* Housekeeping foundations.
* Maintenance and out-of-order management.
* User roles and permissions.
* Audit history.
* Reports and operational exports.
* Data import/export.
* Business settings.
* Integration settings.
* Production diagnostics.

Do not build shallow decorative modules merely to claim completeness.

Prioritize reliable foundations and real workflows over superficial screens.

## Channex

* Complete PMS certification readiness against the full official certification process, including the live screenshare stage.
* An isolated certification tenant and property.
* All officially documented certification scenarios (currently tests 1–11 as executable scenarios, plus declarations 12–14).
* Durable evidence and Task IDs.
* Safe Staging and Production separation.
* Full Sync and incremental synchronization.
* Booking creation, modification, cancellation and acknowledgement.
* Rate-limit compliance.
* Production activation safeguards.

## Database

* Dedicated GuestHub database infrastructure.
* No unrelated application data.
* Dedicated production and certification/staging environments.
* Least-privilege roles.
* Tested backup, restore, migration and rollback flows.

## Engineering quality

* Clear architecture.
* Small, well-defined modules.
* Strong typing.
* Domain invariants.
* Database constraints.
* Code documentation.
* Architecture documentation.
* Automated tests.
* Browser verification.
* Security testing.
* Performance testing.
* No hidden legacy runtime paths.

---

# 2. OPERATING AUTHORITY — MINIMIZE QUESTIONS AND INTERRUPTIONS

The user does not want to participate in routine engineering decisions.

You are authorized to make technical and architectural decisions using senior engineering judgment.

Do not ask the user to choose:

* File names.
* table names.
* class or function names.
* implementation libraries already compatible with the project.
* normal schema structure.
* normal UI behavior.
* test strategy.
* retry policy.
* internal module boundaries.
* whether to refactor duplicated code.
* whether to add missing constraints.
* whether to improve fragile code.
* whether to add required documentation.
* whether to fix bugs discovered during the work.

Make these decisions yourself.

Choose the option that best provides:

1. Data integrity.
2. Operational stability.
3. Security.
4. Maintainability.
5. Performance.
6. Simplicity.
7. Testability.
8. Clear recovery behavior.
9. Compatibility with current GuestHub behavior.
10. Alignment with official Channex requirements.
11. Long-term suitability for a commercial PMS.

If effort must ever be prioritized, the order is:

1. Data integrity and safety of existing production data.
2. Channex certification readiness through real PMS workflows.
3. Reliability, security and observability of existing modules.
4. New PMS capability foundations.

Do not stop after each phase.

Continue through:

* Audit.
* Architecture.
* Implementation.
* Migrations.
* Tests.
* Security review.
* Browser verification.
* Documentation.
* Final independent review.
* Draft pull request.

Only stop for an external fact that is genuinely impossible to derive or replace safely, such as:

* A missing external API credential.
* A paid account that cannot be provisioned.
* DNS access that does not exist.
* An irreversible live-production action.

Even when an external blocker exists:

* Complete every other possible task.
* Build mocks and contract tests.
* Build the required architecture.
* prepare migration and deployment tooling.
* document the blocker.
* return only when the rest of the program is complete.

Do not use a missing credential as a reason to stop early.

---

# 3. ABSOLUTE SAFETY BOUNDARIES

Do not:

* Activate a real Channex Production connection.
* Replace a real Production API key.
* Activate Booking.com, Airbnb or Expedia live channels.
* send ARI updates to a real live property.
* create, change or cancel a real guest reservation.
* merge directly into `main`.
* deploy the feature branch to the live production application.
* execute the final production database cutover.
* delete the current production database.
* delete production data.
* run destructive migrations without verified backup and rollback.
* use `git reset --hard`.
* force-push.
* discard uncommitted work.
* expose secrets.
* expose full card numbers.
* store CVV.
* log payment tokens.
* claim a scenario passed without evidence.
* use Postman or direct scripts as a substitute for a workflow that Channex requires to exist inside the PMS.

You may:

* Create a feature branch.
* Implement all required functionality.
* provision a separate certification/staging environment.
* provision a dedicated certification database.
* prepare a dedicated production database.
* create migration and cutover tooling.
* use Channex Staging.
* create certification-only test data.
* use Booking.com test accounts and Booking CRS.
* run test reservations only in the isolated certification environment.
* create commits.
* open a draft pull request.
* produce a production activation runbook.

The final live activation remains a later explicit action after user testing.

## Execution-environment safety

The working directories may live on the same server that runs the live production application and a shared database used by other, unrelated applications. Therefore:

* Before running any migration, seed, test, script or application process, resolve and print the exact target database identity (host, port, database name, schema) from the effective environment. If it resolves to the production database, abort.
* Automated tests, destructive scripts and experiments run only against the disposable test database or the certification/staging database. Never against production.
* Never stop, restart, reconfigure or upgrade production PM2 processes, the production web server, or the shared database stack. Other applications depend on this shared infrastructure and must remain untouched and unaffected.
* Development and staging processes must bind to ports that do not conflict with production services.
* Before provisioning any new database stack, verify available disk space, memory and CPU headroom on the host. If provisioning a full additional stack would endanger the stability of the host, choose a lighter dedicated topology and document the decision.
* Take a fresh, verified backup of all current GuestHub data before beginning any modification phase — not only before the final cutover.
* Never commit `.env` files, credentials or secrets to the branch or pull request. Verify `.gitignore` coverage and scan the branch history for accidentally committed secrets before opening the PR.

---

# 4. READ PROJECT GUIDANCE AND CURRENT DOCUMENTATION

Before editing anything, read:

* `AGENTS.md`
* `CLAUDE.md`
* `GUIDELINES.md`
* `DECISIONS.md`
* `README.md`
* deployment documentation.
* PM2 configuration.
* environment examples.
* package scripts.
* every database migration.
* all channel-related modules.
* all pricing modules.
* all inventory modules.
* all reservation modules.
* all payment modules.
* all messaging modules.
* all authorization modules.
* all existing checks and test scripts.

Read the current official Channex documentation, including:

* PMS Certification Tests.
* Authentication.
* Staging and Production environments.
* Properties.
* Room Types.
* Rate Plans.
* Availability.
* Rates and Restrictions.
* Booking Revisions.
* Booking acknowledgement.
* Webhooks.
* Rate limits.
* Property size limits.
* Retention periods.
* Best practices.
* Booking CRS.
* Applications.
* Booking.com test accounts.
* PCI and credit-card handling.
* Tokenization capabilities.

Fetch this documentation live at execution time. The certification test tables (dates, values, expected counts) change periodically; do not rely on values remembered from training or from this document. Channex documentation pages are also available as Markdown by appending `.md` to the page URL, and a full index exists at `llms.txt`.

Create a versioned requirements document containing:

* Date accessed.
* Official scenario definitions.
* Official expected values.
* Expected API call count.
* Evidence required.
* Task IDs required.
* Manual steps.
* The official multi-stage certification process, including form submission and the live screenshare review.
* The official pre-flight checklist (change-detection mechanism, outbox/queue, retry and backoff on 429/5xx, webhook plus acknowledgement flow, mapping layer).
* The officially rejected anti-patterns (standalone scripts, certification-only UI, timer-based full sync, per-date calls, hardcoded values).
* Vacation-rental inventory interpretation.
* Known limitations.

Official documentation is the external protocol source of truth.

Repository comments are not proof that the implementation is correct.

---

# 5. MULTI-AGENT PROGRAM

Use the maximum practical number of parallel agents.

A single lead architect/integrator remains responsible for the unified final result.

Begin with parallel read-only audits.

Do not allow multiple agents to modify the same files concurrently.

Use the following roles.

## Agent A — Lead PMS Architect

Responsibilities:

* Map the entire system.
* Define the final architecture.
* Identify sources of truth.
* identify duplicated models.
* identify obsolete paths.
* resolve disagreements between agents.
* protect existing working functionality.
* approve all major refactors.

## Agent B — Full Codebase Auditor

Inspect the entire repository for:

* Bugs.
* unfinished implementations.
* placeholders.
* hidden TODOs.
* stale comments.
* dead code.
* unreachable code.
* duplicated logic.
* unsafe assumptions.
* unhandled errors.
* inconsistent validation.
* inconsistent naming.
* excessive coupling.
* circular dependencies.
* large modules requiring decomposition.
* incorrect boundaries between UI, domain logic, persistence and integrations.

This agent must inspect more than the Channex code.

## Agent C — Mature PMS Product-Gap Analyst

Compare GuestHub's current capabilities with the foundations normally present in stable commercial PMS products.

Create a gap matrix for:

* Reservations.
* Calendar.
* Guests.
* Payments.
* Pricing.
* Inventory.
* Housekeeping.
* Maintenance.
* Tasks.
* Communications.
* Reports.
* Exports.
* Audit.
* Users and permissions.
* Multi-property support.
* Channel management.
* Direct booking.
* Business configuration.
* Operational control.
* Data recovery.

Classify each item:

* Required for operational safety now.
* High-value near-term completion.
* Architectural preparation only.
* Optional future module.

Do not implement large unrelated modules only to fill a checklist.

Implement foundations that materially improve reliability and operational completeness.

## Agent D — Channex Certification Specialist

Map every certification requirement to:

* Existing code.
* Missing code.
* UI workflow.
* API request.
* request count.
* Task ID.
* screenshot.
* database evidence.
* automated test.
* manual step.

Verify readiness against the full official multi-stage certification process, including the pre-flight checklist and the live screenshare review, not only the scenario tables.

For every scenario, identify the exact normal PMS UI action that triggers it and the exact file and function in the main codebase from which the Channex API call fires.

Independently verify the final result against current official Channex documentation.

## Agent E — Database and Data-Integrity Architect

Audit:

* Database topology.
* shared databases.
* schemas.
* roles.
* migrations.
* functions.
* triggers.
* constraints.
* indexes.
* transaction boundaries.
* tenant isolation.
* backup.
* restore.
* retention.
* data deletion.
* audit history.
* database performance.

Design the dedicated GuestHub database architecture.

## Agent F — Reservations and Inventory Reliability Engineer

Audit:

* Reservation creation.
* reservation editing.
* room assignment.
* room changes.
* date changes.
* cancellation.
* no-show.
* availability.
* holds.
* conflicts.
* overbooking prevention.
* concurrent reservations.
* OTA imports.
* inventory release.

Attempt to create double-booking and lost-update scenarios.

## Agent G — Rates and Revenue Logic Engineer

Audit:

* Rate plans.
* inheritance.
* derived rates.
* base rates.
* occupancy rates.
* extra guests.
* minimum and maximum stay.
* CTA.
* CTD.
* Stop Sell.
* date ranges.
* weekly/monthly rates.
* cancellation policies.
* rounding.
* taxes.
* quote consistency.
* ARI projection consistency.

Verify the same price is used by:

* Reservation quote.
* calendar.
* rate grid.
* direct booking preparation.
* Channex ARI.

## Agent H — Payment and Financial Integrity Engineer

Audit:

* Payment ledger.
* payment status.
* balance calculations.
* refunds.
* voids.
* manual payments.
* gateway seams.
* card metadata.
* token storage.
* reconciliation.
* currency.
* taxes.
* invoice readiness.
* audit history.

Do not implement fake payment success.

## Agent I — Security and Red-Team Agent

Threat-model and attack:

* Authentication.
* authorization.
* tenant isolation.
* server actions.
* APIs.
* webhooks.
* credentials.
* tokens.
* payment data.
* database access.
* file uploads.
* email templates.
* XSS.
* CSRF.
* SQL injection.
* SSRF.
* privilege escalation.
* replay.
* brute-force abuse.
* unsafe logs.
* environment crossover.
* deployment secrets.

## Agent J — Performance and Scalability Engineer

Inspect:

* Query plans.
* missing indexes.
* N+1 queries.
* large result sets.
* pagination.
* memory growth.
* worker throughput.
* queue throughput.
* connection pools.
* browser rendering.
* long transactions.
* lock contention.
* rate-grid performance.
* calendar performance.
* full-sync performance.

Test current property scale and plausible future scale.

## Agent K — Observability and Operations Engineer

Audit and build:

* Health checks.
* worker heartbeat.
* structured errors.
* diagnostics.
* metrics.
* alerts.
* queue visibility.
* dead-letter visibility.
* backup status.
* deployment status.
* integration status.
* operational runbooks.

## Agent L — Testing and Fault-Injection Engineer

Build tests for:

* Domain rules.
* database rules.
* integration contracts.
* concurrency.
* browser workflows.
* failures.
* retries.
* worker crashes.
* database restarts.
* malformed API responses.
* duplicate events.
* security boundaries.

## Agent M — Documentation and Maintainability Reviewer

Ensure:

* Architecture documentation is complete.
* code comments explain critical intent.
* public functions have useful documentation.
* database objects are documented.
* diagrams match reality.
* operational runbooks are usable.
* code comments do not become noise.
* stale comments are removed.

## Agent N — Independent Final Verifier

This agent must not trust the implementing agents.

It must:

* Review the final diff.
* re-read official requirements.
* run tests independently.
* inspect architecture.
* attempt failures.
* attempt unauthorized actions.
* verify database isolation.
* verify no hardcoded Staging path remains.
* verify Production cannot activate accidentally.
* verify critical PMS workflows.
* issue a final pass/fail matrix.

No implementing agent may self-certify its own work.

---

# 6. GIT AND WORKTREE SAFETY

Before editing:

1. Run `git status --short --branch`.
2. inspect all tracked and untracked work.
3. preserve uncommitted work in a verified patch.
4. verify the patch is non-empty when changes exist.
5. inspect `origin/main`.
6. inspect existing remote and local feature branches from previous efforts; do not duplicate or silently conflict with them, and document any that will be superseded.
7. create a dedicated feature branch, such as:

`feat/pms-hardening-channex-certification`

8. Never work directly on `main`.
9. Commit by logical milestone.
10. Every milestone commit must leave the branch in a working state: build, typecheck and lint pass at every commit.
11. Keep commits reviewable.
12. finish with a draft pull request.
13. The pull request description must include a review map: the list of changed areas, the order in which a reviewer should read them, and the risk level of each area.
14. do not merge.
15. do not deploy to production.

Do not silently overwrite changes created by another previous effort.

---

# 7. INITIAL SYSTEM-WIDE AUDIT

Before implementing, generate an internal audit containing:

## Architecture inventory

* Runtime applications.
* workers.
* databases.
* schemas.
* external providers.
* background jobs.
* queues.
* file storage.
* authentication.
* webhooks.
* scheduled tasks.
* environment variables.
* deployment process.

## Domain inventory

Map all entities and relationships:

* Tenant.
* property.
* building.
* floor.
* room.
* room type.
* sellable unit.
* guest.
* reservation.
* reservation room.
* rate plan.
* nightly rate.
* restriction.
* closure.
* payment.
* refund.
* payment method.
* template.
* message.
* channel connection.
* mapping.
* channel booking revision.
* audit log.
* user.
* role.
* permission.

## Workflow inventory

Document the current paths for:

* Manual reservation creation.
* OTA reservation creation.
* reservation modification.
* cancellation.
* room move.
* payment.
* refund.
* rate edit.
* bulk rate update.
* room closure.
* Full Sync.
* incremental sync.
* inbound revision.
* webhook.
* email.
* background work.
* deployment.

## Defect inventory

Find and classify:

* Critical data-integrity defects.
* Critical security defects.
* production blockers.
* reliability defects.
* business-logic inconsistencies.
* performance problems.
* maintainability problems.
* UI inconsistencies.
* missing operational controls.
* missing documentation.

Use severity:

* Critical.
* High.
* Medium.
* Low.

Persist every audit output as versioned files in the repository, for example under `docs/audit/`, as the work progresses. Audit knowledge must survive session restarts and context loss; chat output alone is not durable.

Do not implement until the lead architect has reconciled the findings into a target architecture.

---

# 8. TARGET ARCHITECTURE PRINCIPLES

The final architecture must follow these principles.

## One source of truth

Each business concept must have one canonical source.

Examples:

* Room identity comes from the canonical rooms model.
* availability comes from the canonical inventory calculation.
* price comes from the canonical pricing engine.
* payment state comes from the canonical payment ledger.
* reservation source comes from the canonical source field.
* channel environment comes from the channel connection.
* rate-plan assignment comes from canonical pricing-plan relationships.

UI components must not invent business state.

Integration modules must not recalculate business logic independently.

## Domain layer separation

Separate:

* UI.
* validation.
* application services.
* domain logic.
* database persistence.
* external provider clients.
* background workers.
* audit and observability.

Server actions should orchestrate, not contain large amounts of business logic.

## Transaction safety

Any operation changing multiple related entities must be transactional.

Examples:

* Reservation plus room assignment.
* reservation date change plus inventory.
* cancellation plus inventory release.
* payment plus balance update.
* rate update plus channel outbox.
* OTA revision plus local reservation state.
* ACK only after successful commit.

## Idempotency

Every external or repeatable operation must be safe to run twice.

Examples:

* Booking revision.
* webhook.
* message send.
* channel sync job.
* Full Sync request.
* payment callback.
* migration.
* certification provisioning.
* import.

## Time and date discipline

* All business-day logic (calendar days, arrivals, departures, "today", night boundaries, scheduled messages, the 500-day sync window) must be computed in the property's local timezone through one shared date utility.
* Naive mixing of UTC timestamps and local calendar dates is a defect.
* Behavior across daylight-saving transitions must be tested explicitly.

## Money discipline

* Monetary amounts are stored and computed as exact decimal or integer minor-unit values, never as binary floating point.
* One shared money module owns rounding, currency formatting and arithmetic.
* Rounding rules are defined once and tested.

## Fail visibly

Never silently ignore:

* Missing mappings.
* malformed bookings.
* warnings.
* failed sync.
* conflicts.
* failed messages.
* missing prices.
* failed payments.
* worker failures.

## Fail closed where correctness is unknown

Examples:

* Missing price should Stop Sell rather than send zero.
* unknown room mapping should quarantine rather than guess.
* unknown environment should refuse rather than default to Production.
* insufficient authorization should deny.
* invalid payment status should not be marked paid.
* incomplete restriction data should not fabricate values.

---

# 9. DEDICATED GUESTHUB DATABASE

GuestHub must have database infrastructure dedicated only to GuestHub.

A `guesthub` schema inside a database containing unrelated systems is not sufficient as the final target.

## Protect the shared infrastructure

The current database stack is shared with other, unrelated applications. While provisioning dedicated GuestHub infrastructure:

* Do not modify, restart, reconfigure, upgrade or migrate the shared stack itself.
* Do not change roles, extensions, global settings or authentication configuration that other applications depend on.
* Read from the shared stack only for inventory, backup and data-copy purposes.
* The other applications must work exactly as before, at every point during and after this program.

## Required topology

Prepare:

### GuestHub Production

A database or dedicated self-hosted Supabase/PostgreSQL stack used only by the real GuestHub production application.

### GuestHub Certification/Staging

A completely separate database used only for:

* GuestHub development.
* Channex Staging.
* certification scenarios.
* Booking CRS.
* integration tests requiring realistic data.

### Disposable test database

Used for destructive automated tests.

## Topology decision

Before provisioning, decide deliberately between:

* A full dedicated Supabase stack per environment.
* A dedicated PostgreSQL cluster plus only the Supabase components GuestHub actually uses (for example GoTrue for authentication).

Base the decision on what GuestHub actually consumes, on host resource headroom (a full Supabase stack is heavy: PostgreSQL, GoTrue, PostgREST, Realtime, Storage, gateway), and on operational simplicity. Record the decision as an ADR.

## Authentication dependency

If GuestHub depends on Supabase GoTrue or other Supabase schemas:

* Provision a dedicated GuestHub Supabase stack where needed.
* Preserve authentication relationships.
* do not separate application data in a way that breaks login.
* document ownership of authentication schemas.

Also audit how Supabase keys are used today:

* The `service_role` key must never reach the browser and must be confined to trusted server-side code.
* If any Supabase client is used from the browser, Row Level Security policies must actually enforce tenant isolation; absent or permissive RLS with browser-side access is a critical finding.
* Document which enforcement layer (RLS, server-side authorization, or both) is canonical for each access path.

## Database roles

Create least-privilege roles:

* Owner/migration role.
* application runtime role.
* read-only diagnostic role.
* backup/restore role.

The runtime role must not own schemas or migration objects.

## Data migration tooling

Build:

1. Current database inventory.
2. GuestHub-owned object list.
3. verified logical backup.
4. restore verification.
5. target database provisioning.
6. migration replay from zero.
7. data-copy tooling.
8. validation tooling.
9. checksum and row-count comparison.
10. application smoke testing.
11. worker smoke testing.
12. rollback tooling.
13. final cutover runbook.

Do not execute the final production cutover.

## Verify

* UUID preservation.
* foreign keys.
* constraints.
* indexes.
* triggers.
* functions.
* audit logs.
* users.
* active reservations.
* payment totals.
* room identities.
* channel mappings.
* migration versions.

## Required documentation

Create:

* `docs/database/DEDICATED_DATABASE_ARCHITECTURE.md`
* `docs/database/MIGRATION_AND_CUTOVER_RUNBOOK.md`
* `docs/database/BACKUP_RESTORE_AND_ROLLBACK.md`
* `docs/database/DATA_INTEGRITY_CHECKLIST.md`

Add an automated:

`check:db-isolation`

---

# 10. PMS DOMAIN COMPLETENESS REVIEW

Evaluate every major PMS area.

For each area:

1. Document current capability.
2. list defects.
3. list missing foundations.
4. define target state.
5. implement critical missing foundations.
6. document deferred optional enhancements.

## Properties and business identity

Verify:

* Legal/business name.
* property name.
* address.
* timezone.
* currency.
* VAT/tax configuration.
* contact information.
* check-in/check-out rules.
* cancellation policies.
* branding.
* channel identity.
* multi-property readiness.

Do not duplicate business identity across unrelated tables.

## Rooms and inventory

Verify:

* Physical room identity.
* room type.
* building.
* floor.
* capacity.
* occupancy.
* active status.
* out-of-order.
* maintenance closures.
* owner blocks.
* room attributes.
* images.
* sellable-unit assignment.
* availability calculation.
* no stale aliases.

## Reservations

Verify and improve:

* Manual booking.
* external booking.
* edit.
* cancel.
* no-show.
* room move.
* date change.
* guest change.
* occupancy change.
* price override.
* status.
* payment balance.
* source.
* cancellation origin.
* reservation history.
* conflict resolution.
* duplicate prevention.
* audit trail.
* concurrency protection.

Add or strengthen database constraints and locks where required.

For double-booking prevention specifically, prefer database-level guarantees as the last line of defense, not only application checks. In PostgreSQL the canonical pattern is an exclusion constraint on the room and the stay date range (for example `EXCLUDE USING gist` over `room_id` and a `daterange` of the stay) applied to active reservation states, combined with row locks or advisory locks in the reservation transaction. An application-level check alone is insufficient under concurrency.

## Guests

Audit whether GuestHub needs a canonical guest profile separate from reservation snapshots.

A mature design may require:

* Canonical guest record.
* reservation-specific guest snapshot.
* contact information.
* language.
* notes.
* consent.
* communication preference.
* duplicate detection.
* stay history.
* privacy/anonymization support.

Do not redesign this area without migration safety.

## Pricing and restrictions

Verify:

* Base rates.
* derived rates.
* room-specific rates.
* occupancy pricing.
* extra-adult/child/infant pricing.
* weekly/monthly pricing.
* date overrides.
* minimum stay.
* maximum stay.
* CTA.
* CTD.
* Stop Sell.
* valid periods.
* advance restrictions.
* inheritance.
* rounding.
* currency.
* taxes.
* quote equality.
* channel equality.

## Payments

Verify:

* Ledger integrity.
* unpaid/partial/paid/refunded calculations.
* payment method.
* manual payment.
* gateway payment.
* refund.
* reversal.
* failed payment.
* authorization versus capture.
* external reference.
* idempotency.
* reconciliation.
* audit.
* currency.
* financial exports.

Do not fake payment-provider operations.

## Communications

Verify:

* Templates.
* template versioning.
* message rendering.
* email.
* WhatsApp provider seams.
* automations.
* delivery attempts.
* retries.
* failure classification.
* opt-out.
* guest-language readiness.
* immutable history.
* test sends.
* auditing.

## Housekeeping foundation

Audit whether current GuestHub has sufficient operational support.

At minimum design or implement the foundation for:

* Room cleaning state.
* clean/dirty/inspected.
* assigned staff.
* due date/time.
* checkout-driven cleaning task.
* notes.
* history.
* manual override.
* dashboard visibility.

Do not build a decorative housekeeping screen disconnected from reservation lifecycle.

## Maintenance foundation

Audit or implement:

* Maintenance issue.
* room.
* severity.
* status.
* owner.
* opened/closed timestamps.
* notes.
* photos or attachments where safe.
* optional out-of-order block.
* audit trail.
* inventory effect.

## Operational tasks

Audit or implement a general task foundation supporting:

* Reservation task.
* guest request.
* housekeeping.
* maintenance.
* payment follow-up.
* channel conflict.
* owner.
* priority.
* due date.
* completion.
* audit history.

Avoid separate incompatible task systems per module.

## Reports and exports

Determine the essential operational reports:

* Arrivals.
* departures.
* in-house guests.
* cancellations.
* occupancy.
* revenue.
* balances due.
* payments.
* room availability.
* channel production.
* rate-plan performance.
* audit exports.

Implement only reports whose underlying data is reliable.

Add CSV/Excel export through safe server-side generation where appropriate.

## Audit and history

Every sensitive change should be attributable:

* Who.
* what.
* when.
* before.
* after.
* source.
* external reference.
* request/correlation ID.

Avoid storing secrets or unnecessary PII in audits.

## Israel-market readiness

GuestHub operates for an Israeli business. Audit and, where the underlying data is reliable, prepare or implement foundations for:

* VAT handling that supports the Israeli accommodation rules, including zero-rated VAT for eligible foreign tourists versus standard VAT for Israeli residents, driven by guest attributes rather than hardcoded assumptions.
* Invoice and receipt readiness compatible with Israeli bookkeeping practice, or a documented, clean integration seam for an external invoicing provider.
* Hebrew and RTL correctness across the entire UI: layout direction, alignment, date and number formatting, and mixed Hebrew/English content. Browser verification must include RTL rendering checks.
* Guest-facing communications in the guest's language, with Hebrew and English at minimum.
* Guest PII handling consistent with Israeli privacy law obligations: data minimization, access control, retention and deletion capability, and documented location of personal data.

Do not build a full accounting system. Build correct foundations and clean seams, and document what is intentionally deferred.

---

# 11. CHANNEX ENVIRONMENT SEPARATION

The connection's `environment` field must be the only source of truth.

Every Channex operation must resolve:

`CHANNEX_BASE_URLS[connection.environment]`

Audit:

* Connection tests.
* properties.
* room types.
* rate plans.
* Full Sync.
* incremental ARI.
* bookings.
* revisions.
* acknowledgement.
* webhooks.
* applications.
* Booking CRS.
* reporting actions.
* tokenization integrations.

Remove hardcoded runtime assumptions such as:

`const CHANNEX_ENV = "staging"`

when they prevent Production support.

## Rules

* Staging credential cannot reach Production.
* Production credential cannot reach Staging.
* Property IDs cannot cross environments.
* mappings belong to one environment-specific connection.
* UI shows a prominent environment badge.
* every job and evidence row records environment.
* Production remains disabled until an explicit activation workflow.
* no deployment or page load can activate Production.
* Production and Staging credentials are stored separately.

Add:

* `check:channex-environment-routing`
* environment crossover tests.
* credential/property mismatch tests.
* production activation guard tests.

---

# 12. CHANNEX CERTIFICATION ENVIRONMENT

## Certification execution model — mandatory

Channex certification is not a set of API calls to execute. It verifies that the real PMS product pushes correct data to Channex as a side effect of real user actions, and it ends with a live screenshare review in which arbitrary ad-hoc changes are performed in the PMS UI while Channex watches the API calls fire.

Therefore:

* Every executable certification scenario must be triggered from the normal, production GuestHub UI: the rate grid, Group Update, calendar, reservation screens and channel-management screens. The integration side effect must fire from the main product code path.
* Never build a certification-only UI, endpoint, script or harness that triggers the scenario API calls directly. Channex explicitly rejects standalone scripts, certification-only UIs, timer-based full sync, per-date calls where one call is specified, and hardcoded values, and verifies this at the screenshare stage.
* Browser automation may drive the real UI for pre-verification, because it exercises the true product code path. The values must still propagate from the GuestHub database into the Channex payload.
* The system must handle arbitrary values, not only the values in the official tables. During the screenshare Channex asks for ad-hoc changes; nothing may be hardcoded to the documented test values.
* You must be able to point to the exact file and function in the main codebase from which each Channex call fires, and the integration must keep working if all certification-specific code were deleted.
* Tests 1–11 are executable scenarios. Items 12–14 are declarations and questionnaire answers (rate-limit compliance, delta-update-only logic, supported-features notes). Model the evidence accordingly and prepare written answers for the declarations.

## Certification tenant and property

Create an isolated certification tenant:

`GuestHub Certification`

Create a certification property through GuestHub and Channex Staging:

`Test Property - GuestHub`

Use:

* Currency: USD.
* isolated test contact data.
* no real guests.
* certification-only identifiers.

Create:

## Twin Room

* Occupancy 2.
* Best Available Rate: USD 100.
* Bed & Breakfast: USD 120.

## Double Room

* Occupancy 2.
* Best Available Rate: USD 100.
* Bed & Breakfast: USD 120.

Required:

* 2 physical rooms.
* 2 Channex Room Types.
* 2 local plans.
* 4 room × rate-plan mappings.

GuestHub uses one physical vacation-rental unit per Channex Room Type with inventory 1.

Document the certification interpretation:

* Open = 1.
* Sold/blocked = 0.
* Cancellation/release = 1.

Do not redesign GuestHub into pooled inventory merely to reproduce a hotel example using availability 8. The official documentation explicitly permits single-unit and vacation-rental products to adapt the affected tests to their real data model; record every adaptation, including adapted availability values, in the certification form notes.

## Realistic data requirement

Channex rejects synthetic, uniform data. Before the certification Full Sync, the certification property must carry realistic, varied values across the 500-day window: different prices on different dates and seasons, varied minimum-stay values, some restriction differences between plans, and availability changes caused by real test reservations. The provisioning fixture must seed this variation deterministically. A property where every date is identical will be flagged as synthetic.

## Provisioning

Build idempotent provisioning:

* `scripts/provision-channex-certification.mjs`
* safe reset script.
* Production refusal guards.
* deterministic test fixture.
* mapping verification.

Provisioning scripts must operate through GuestHub's own domain services and integration layer — the same code paths the product uses — not through raw one-off API calls that bypass the product. Provisioning creates data; it never substitutes for the UI-triggered scenarios themselves.

---

# 13. CERTIFICATION EVIDENCE LEDGER

Build durable evidence tables and services.

Store:

## Certification run

* Run ID.
* tenant.
* connection.
* environment.
* property.
* documentation version.
* actor.
* timestamps.
* status.
* verdict.

## Scenario

* Scenario number.
* official title.
* scenario kind: executable scenario or declaration.
* expected behavior.
* expected request count.
* actual request count.
* the UI workflow that triggered it.
* status.
* error.
* timestamps.

## ARI submission

* Correlation ID.
* connection.
* environment.
* endpoint.
* scenario.
* property.
* rooms.
* rate plans.
* date span.
* value count.
* serialized byte size.
* payload hash.
* Task IDs.
* status.
* warnings.
* sanitized failure.

Never store:

* API keys.
* authorization headers.
* raw card data.
* CVV.
* raw payment tokens.
* unnecessary guest PII.
* unbounded raw external response bodies.

## Booking evidence

* Channex Booking ID.
* Revision IDs.
* revision kind.
* local reservation ID.
* import result.
* ACK result.
* inventory before and after.
* timestamps.
* sanitized error.

## UI

Add a `Channex Certification` area for `super_admin` only.

This area is strictly an evidence and monitoring console plus test-data administration. It must not contain any control that directly triggers a certification scenario or fires a Channex API call for a scenario. Scenarios are performed only through the normal PMS UI. The only permitted actions in this console are provisioning and resetting certification test data, and managing the evidence records themselves.

Display:

* Certification readiness.
* property.
* environment.
* mappings.
* worker health.
* scenario matrix, with the triggering UI workflow per scenario.
* Task IDs.
* actual request counts.
* warnings.
* failures.
* Booking IDs.
* Revision IDs.
* screenshots checklist.
* certification-data provisioning and reset controls.
* prepared answers for the declaration items and the certification form.
* final pass/fail.

No status may be based only on optimistic UI state.

---

# 14. FULL SYNC

Full Sync is a real product feature, not a certification artifact. It lives in the channel-management UI as an explicit administrative action ("go live" / "resynchronize channel") and exists to establish a clean baseline when a property goes live and to recover from downtime or drift. Certification simulates exactly this product feature.

Certification Full Sync must cover exactly 500 property-local dates and send:

1. Exactly one `POST /availability`.
2. Exactly one `POST /restrictions`.

Build the complete payload before sending.

Measure actual UTF-8 JSON size.

If it fits within Channex's current documented limit:

* Send one request.

If it does not fit:

* fail preflight.
* show the calculated size.
* do not silently split a certification scenario requiring one request.

Normal non-certification production batching may use a safe separate policy.

Operationally, Full Sync must never run on a timer as the synchronization strategy. Channex allows a full sync at most once per 24 hours when genuinely required, scheduled off-peak; the routine strategy is delta updates on change events only.

A Full Sync succeeds only when:

* credentials authenticate.
* correct environment is used.
* all mappings are complete.
* projection succeeds.
* both requests succeed.
* Task IDs are returned.
* there are no warnings.
* there are no deferred values.
* evidence is persisted.
* incremental synchronization is activated only after the clean baseline.

Warnings are not success.

An unrecognized 2xx response is not success.

---

# 15. INCREMENTAL ARI AND GROUP UPDATE

Every canonical operation affecting availability, rates or restrictions must write the correct dirty range in the same business transaction.

Audit:

* Reservation create.
* reservation edit.
* cancellation.
* room change.
* date change.
* closure.
* reopening.
* room active/inactive.
* rate edit.
* Group Update.
* rate-plan changes.
* minimum/maximum stay.
* CTA.
* CTD.
* Stop Sell.

Upgrade the existing Group Update workflow to support:

* Multiple rooms.
* multiple plans.
* multiple ranges.
* weekday filters.
* different values per room/plan combination.
* price.
* Min Stay Arrival.
* Min Stay Through.
* Max Stay.
* CTA.
* CTD.
* Stop Sell.

The backend must:

1. Validate all rows.
2. write through the canonical rate service.
3. use one transaction.
4. roll back fully on error.
5. mark correct dirty ranges.
6. create one logical synchronization envelope.
7. allow a certification scenario to produce one combined Channex request.

Do not build a separate fake certification rate engine.

Determine and document whether GuestHub semantics are Min Stay Arrival, Min Stay Through, or both; this is an explicit declaration question in the certification form and must match what the integration actually sends.

---

# 16. RATE LIMITS AND CIRCUIT BREAKER

Implement the current official Channex rate-limit rules. At the time of writing the documented ARI budget is 20 ARI requests per minute; verify the current figures against the official Rate Limits page at execution time.

Requirements:

* Separate budgets for Availability and Restrictions.
* combined updates where possible.
* no request per date.
* no request per rate plan where one combined request is possible.
* persistent cooldown after 429.
* cautious cooldown after timeout, network failure or relevant 5xx.
* manual actions cannot bypass cooldown.
* worker restarts do not remove cooldown.
* bounded exponential backoff.
* validation/mapping/authentication errors do not retry forever.
* UI displays cooldown and last failure.

Add connection-level fields or state for:

* cooldown until.
* failure category.
* consecutive transient failures.
* last successful request.
* circuit state.

Fault-test:

* 429.
* timeout.
* network error.
* 500.
* 502.
* 503.
* malformed response.
* 200 with warnings.
* recovery.
* concurrent save during cooldown.
* worker restart.

---

# 17. INBOUND BOOKINGS AND BOOKING CRS

The canonical flow must remain:

`Webhook or polling wake-up`
→ `fetch revision`
→ `persist sanitized revision`
→ `normalize`
→ `validate property and mappings`
→ `apply local transaction`
→ `commit`
→ `ACK`
→ `persist ACK evidence`

Use only the booking revisions feed endpoints, never the plain bookings listing endpoints, for retrieving bookings to process. Even with webhooks enabled, implement the pull method as a scheduled backup (the official guidance is every 15–20 minutes) so that a failed webhook cannot cause a lost booking.

## New reservation

Verify:

* Unique external identity.
* no duplicate local reservation.
* correct source.
* correct OTA number.
* correct room.
* correct dates.
* correct occupancy.
* correct price.
* correct guest data.
* availability reduction.
* unpaid state unless actual payment exists.
* audit history.

## Modification

Verify:

* Date change.
* room change.
* occupancy.
* price.
* guest.
* expected arrival.
* old inventory release.
* new inventory allocation.
* conflict behavior.
* notifications.
* audit.
* idempotency.

Do not overwrite a conflicting reservation silently.

## Cancellation

Verify:

* Cancel, never delete.
* preserve history.
* record OTA origin.
* release availability.
* mark ARI dirty.
* publish required events.
* ACK after commit.
* duplicate cancellation harmless.

## Webhook hardening

* Unguessable per-connection token.
* correct connection/environment.
* replay-safe.
* duplicate-safe.
* no trust in webhook payload as final truth.
* fetch canonical revision from Channex.
* polling fallback.
* size limit.
* malformed body handling.
* no tenant crossover.

## Booking receiving certification

For the booking-receiving scenario, prefer the officially provided Booking.com test account: create the channel, set up mapping, launch it, and perform create, modify and cancel through it. If the test account cannot be used, the officially documented fallback is the Booking CRS application, which allows creating, editing and cancelling bookings manually.

Prepare a repeatable workflow:

1. Create.
2. import.
3. verify inventory.
4. ACK.
5. modify.
6. import.
7. verify old/new inventory.
8. ACK.
9. cancel.
10. release inventory.
11. ACK.

Persist all identifiers and evidence, including the screenshots of the booking inside GuestHub that the certification form requires.

---

# 18. PAYMENT AND TOKENIZATION BOUNDARIES

GuestHub must not require raw credit-card data for certification.

Rules:

* Never store CVV.
* never reconstruct PAN.
* never log PAN.
* store masked card metadata only.
* tokens are provider-specific.
* a Stripe token cannot be used by Cardcom or Tranzila.
* a Cardcom token cannot be used by another processor.
* no fake charge workflow.
* payment success requires real provider evidence.

Design a provider-neutral payment-method reference model:

* Provider.
* external customer reference.
* external payment-method reference.
* card brand.
* last four.
* expiration metadata where lawful.
* status.
* consent/mandate.
* timestamps.

Protect token references according to provider requirements.

Create:

* `docs/payments/PAYMENT_ARCHITECTURE.md`
* `docs/payments/TOKENIZATION_AND_PCI_BOUNDARIES.md`

---

# 19. SECURITY REVIEW

Test:

## Authorization

* Unauthenticated.
* receptionist.
* manager.
* admin.
* super_admin.
* cross-tenant IDs.
* direct server actions.
* forged input.
* hidden UI controls.
* worker tenant scope.

## Secrets

* API key never reaches browser.
* ciphertext never reaches browser.
* no secrets in logs.
* safe rotation.
* wrong encryption key.
* revoked key.
* environment mismatch.
* password-manager autofill.
* no secrets committed anywhere in the branch history; scan the repository history for leaked credentials before opening the PR.
* Supabase key discipline: `service_role` confined to trusted server-side code; browser-side access, if any, protected by verified Row Level Security.

## Supply chain

* Run a dependency vulnerability audit (for example `npm audit` or an equivalent scanner) and resolve or document all high and critical advisories.
* Verify lockfile integrity and that installs are reproducible from the lockfile.
* Pin the Node.js runtime version used by the application and workers.

## Application attacks

* SQL injection.
* XSS.
* CSRF.
* SSRF.
* privilege escalation.
* malicious OTA text.
* malicious email-template content.
* oversized payloads.
* malicious file uploads.
* path traversal.
* denial-of-service.
* brute-force abuse.

## Synchronization attacks and failures

* Forged webhook.
* replayed webhook.
* duplicate webhook.
* duplicate revision.
* out-of-order revision.
* stale mapping.
* deleted external plan.
* worker crash.
* timeout after possible upstream success.
* concurrent Full Sync.
* credential replacement during queued work.
* environment change during queued work.

Resolve all Critical and High issues.

Document residual Medium/Low risks.

---

# 20. PERFORMANCE AND SCALABILITY

Measure and improve:

* Calendar queries.
* reservation lists.
* rate grid.
* Group Update.
* Full Sync.
* inventory functions.
* pricing engine.
* payment aggregates.
* communication history.
* channel diagnostics.
* worker queue.
* reporting.

Inspect query plans and add indexes only where justified.

Test at minimum:

## Current realistic scale

* 13 rooms.
* 4 plans.
* 500 days.
* existing reservation volume.

## Growth scale

Prepare a safe fixture approximating:

* 100 rooms.
* multiple properties.
* several years of reservations.
* multiple rate plans.
* high-volume rate updates.
* simultaneous workers or web requests.

Verify:

* No dropped work.
* no unbounded memory.
* no unbounded query.
* pagination.
* reasonable lock duration.
* acceptable page response.
* acceptable worker progress.

Include daylight-saving transition dates in date-heavy performance and correctness fixtures.

Do not optimize blindly without measurement.

---

# 21. OBSERVABILITY AND OPERATIONS

Provide sanitized operational visibility for:

* Application health.
* database health.
* worker heartbeat.
* queue state.
* retry state.
* dead letters.
* dirty ranges.
* failed ranges.
* inbound revisions.
* quarantine.
* unacknowledged imported revisions.
* Channex environment.
* mappings.
* last sync.
* cooldown.
* Task IDs.
* email delivery.
* payment failures.
* backup status.

Add or document alerts for:

* Worker offline.
* database unavailable.
* repeated 429.
* dead-letter job.
* failed dirty range.
* quarantined booking.
* stale unacknowledged revision.
* failed backup.
* Production connection missing mappings.
* environment mismatch.
* unusual error-rate increase.

Backups must be scheduled automatically with a defined retention policy and at least one copy stored off the application host, and the restore procedure must be exercised, not merely documented.

Logs must be structured and useful.

Logs must not contain:

* Secrets.
* full external payloads.
* full card data.
* CVV.
* raw payment tokens.
* unnecessary guest PII.

---

# 22. CODE DOCUMENTATION STANDARD

Code documentation is mandatory.

Do not merely create separate Markdown files.

Document the intent inside the code where future engineers need it.

## Add comments for

* Domain invariants.
* transaction boundaries.
* locking strategy.
* retry safety.
* idempotency.
* ACK-after-commit behavior.
* environment routing.
* warning handling.
* tenant isolation.
* availability logic.
* pricing inheritance.
* payment-ledger rules.
* security-sensitive operations.
* irreversible operations.
* Production activation gates.
* why a design rejects or quarantines data.

## Add JSDoc or equivalent documentation for

* Public domain services.
* integration clients.
* queue functions.
* worker entry points.
* certification services.
* migration utilities.
* complex validation functions.
* externally used types.

Documentation should explain:

* Purpose.
* inputs.
* outputs.
* important side effects.
* failure behavior.
* idempotency expectations.
* transaction expectations.
* security expectations.

## Database documentation

Use `COMMENT ON` for important:

* Tables.
* columns.
* functions.
* constraints.
* unusual indexes.

## Avoid noisy comments

Do not comment obvious syntax.

Do not add comments such as:

`// increment counter`

Document decisions and invariants, not every line.

## Remove stale documentation

A false or outdated comment is a defect.

Update comments whenever behavior changes.

Add a check or review rule to detect critical modules lacking required documentation.

## Keep the agent guidance files current

At the end of the program, update `CLAUDE.md`, `AGENTS.md` and `DECISIONS.md` (and `GUIDELINES.md` where relevant) so they describe the final canonical architecture, the sources of truth, the safety boundaries and the decisions made. Future engineering sessions must be able to rely on these files without rediscovering the architecture.

---

# 23. ARCHITECTURE DOCUMENTATION

Create:

* `docs/architecture/SYSTEM_OVERVIEW.md`
* `docs/architecture/DOMAIN_MODEL.md`
* `docs/architecture/RESERVATION_LIFECYCLE.md`
* `docs/architecture/INVENTORY_AND_AVAILABILITY.md`
* `docs/architecture/PRICING_AND_RESTRICTIONS.md`
* `docs/architecture/PAYMENTS_AND_LEDGER.md`
* `docs/architecture/BACKGROUND_JOBS.md`
* `docs/architecture/AUTHORIZATION_AND_TENANCY.md`
* `docs/architecture/OBSERVABILITY.md`
* `docs/architecture/DEPLOYMENT.md`
* `docs/architecture/PMS_CAPABILITY_MATRIX.md`

Create Channex documentation:

* `docs/channex/ARCHITECTURE.md`
* `docs/channex/PMS_CERTIFICATION_REQUIREMENTS.md`
* `docs/channex/CERTIFICATION_SCENARIO_MATRIX.md`
* `docs/channex/CERTIFICATION_RUNBOOK.md`
* `docs/channex/SCREENSHARE_DEMO_SCRIPT.md`
* `docs/channex/ARI_SYNC_FLOW.md`
* `docs/channex/BOOKING_REVISION_FLOW.md`
* `docs/channex/ENVIRONMENT_SEPARATION.md`
* `docs/channex/PRODUCTION_ACTIVATION_RUNBOOK.md`
* `docs/channex/FAILURE_AND_RECOVERY.md`

The screenshare demo script must list, for each certification scenario and for plausible ad-hoc requests, the exact UI steps the user will perform live, where the resulting Channex call can be observed, and the file and function it fires from.

Create security documentation:

* `docs/security/THREAT_MODEL.md`
* `docs/security/SECURITY_TEST_REPORT.md`
* `docs/security/SECRET_HANDLING.md`

Use Mermaid diagrams for:

* System architecture.
* reservation creation.
* OTA booking import.
* cancellation.
* ARI Full Sync.
* incremental ARI.
* worker queue.
* database deployment.
* Production activation.

The diagrams must match the actual final code.

---

# 24. TEST PROGRAM

Before refactoring any fragile or poorly understood area, first capture its current externally observable behavior with characterization tests, so refactors can prove behavior preservation.

Run all existing checks and add:

* `check:db-isolation`
* `check:pms-domain-invariants`
* `check:reservation-concurrency`
* `check:inventory-integrity`
* `check:pricing-equality`
* `check:payment-ledger-integrity`
* `check:background-job-recovery`
* `check:channex-environment-routing`
* `check:channex-certification`
* `check:channex-certification-evidence`
* `check:channex-full-sync-two-requests`
* `check:channex-group-update-batching`
* `check:channex-rate-limit-cooldown`
* `check:channex-booking-crs-flow`
* `check:channel-security`
* `check:channel-chaos`
* `check:production-activation-guard`
* `check:code-documentation`
* `check:no-secrets`
* `check:timezone-and-money-invariants`

## Unit tests

Test:

* Domain rules.
* date behavior.
* money.
* rounding.
* availability.
* quote calculation.
* payment state.
* environment resolution.
* batching.
* scenario fixtures.
* cooldown state.
* token classification.

## Database tests

Use disposable database only.

Test:

* Migration replay.
* constraints.
* uniqueness.
* tenant isolation.
* reservation concurrency.
* inventory.
* payment ledger.
* queue claims.
* lease recovery.
* evidence.
* ACK gates.
* backup restore.

## Integration tests

Use fake or injected provider responses.

Verify:

* exact URL.
* exact environment.
* exact endpoint.
* exact request count.
* exact payload.
* exact Task ID handling.
* warnings.
* timeout.
* malformed response.
* 429.
* duplicate call.
* recovery.

## Browser tests

Run against isolated certification/staging environment.

Verify:

* Calendar.
* reservations.
* reservation panel.
* rates.
* Group Update.
* channel management.
* certification console.
* mappings.
* Full Sync.
* Task IDs.
* Booking Revision.
* permissions.
* responsive behavior.
* correct RTL and Hebrew rendering across all verified screens.
* no console errors.
* no hydration errors.
* no overflow.

## Concurrency tests

* Two manual reservations for the last room.
* two OTA revisions.
* two Full Sync clicks.
* two workers.
* worker crash.
* simultaneous rate updates.
* simultaneous cancellation and modification.
* webhook plus poll.
* credential rotation during a job.
* certification reset during a run.

## Fault injection

* Database unavailable.
* worker killed.
* process restarted.
* network timeout.
* Channex 500.
* Channex 429.
* malformed booking.
* stale mapping.
* missing price.
* failed email.
* failed payment provider.
* corrupted queue payload.
* expired lease.

---

# 25. FULL REGRESSION

Run the entire existing suite.

Verify no regressions in:

* Manual reservation.
* external reservation.
* reservation editing.
* room move.
* cancellation.
* calendar.
* numeric room order.
* date picker.
* channel badges.
* payment ledger.
* status defaults.
* room availability.
* rate plans.
* rate grid.
* Group Update.
* pricing inheritance.
* communication templates.
* messaging worker.
* room images.
* permissions.
* production deploy guard.

Do not modify existing real production data.

---

# 26. PRODUCTION ACTIVATION GUARD

Build the complete Production capability but do not activate it.

Activation must require:

* Dedicated Production database confirmed.
* backup complete.
* restore proof available.
* Production API key authenticated against Production.
* Production property mapped.
* all rooms mapped.
* all channel-visible plans mapped.
* no failed mappings.
* worker online.
* no quarantine.
* no failed dirty ranges.
* future reservations reconciled.
* explicit Full Sync.
* typed confirmation.
* super_admin.
* audit entry.
* clear rollback package.

Live OTA activation remains a separate later action.

No page load, migration, deploy or ordinary save may activate Production.

---

# 27. IMPLEMENTATION PHASES

Execute without routine user approval.

## Phase 0 — Environment safety and baseline

Verify database targets, confirm no process can touch production data, take a verified backup of current GuestHub data, and record host resource headroom. Only then begin.

## Phase 1 — Read-only system audit

Produce current-state architecture and defect matrix. Persist all findings as files under `docs/audit/`.

## Phase 2 — Target architecture and ADRs

Have architecture, database, security and PMS-gap agents review it.

## Phase 3 — Dedicated database tooling

Provision Certification/Staging and prepare Production cutover.

## Phase 4 — Core domain-integrity corrections

Fix critical reservation, inventory, pricing, payment and tenant problems.

## Phase 5 — Maintainability refactor

Remove duplicate paths, split unsafe large modules and document invariants. Capture characterization tests before refactoring fragile areas.

## Phase 6 — Channex environment routing

Remove hardcoded Staging behavior.

## Phase 7 — Certification evidence model

Persist Task IDs and scenario proof.

## Phase 8 — Full Sync correction

Exactly 500 days and exactly two certification requests.

## Phase 9 — Group Update improvements

Multi-room, multi-plan and combined restrictions.

## Phase 10 — Rate-limit resilience

Cooldown, circuit breaker and recovery.

## Phase 11 — Inbound booking hardening

Create, modify, cancel, ACK and booking-receiving certification flow.

## Phase 12 — PMS capability completion

Implement critical operational foundations discovered in the gap analysis.

Do not create shallow non-functional modules.

## Phase 13 — Security and red-team testing

Resolve Critical and High findings.

## Phase 14 — Performance and fault testing

Resolve production-risk findings.

## Phase 15 — Browser verification and screenshare rehearsal

Verify actual rendered workflows, including RTL rendering. Execute a full screenshare rehearsal: perform each certification scenario and several ad-hoc arbitrary changes through the real UI, confirm the Channex calls fire from the main code paths, and finalize `docs/channex/SCREENSHARE_DEMO_SCRIPT.md`.

## Phase 16 — Documentation

Update code comments, JSDoc, database comments and architecture documents. Update `CLAUDE.md`, `AGENTS.md`, `DECISIONS.md` and `GUIDELINES.md` to reflect the final architecture.

## Phase 17 — Independent final verification

A separate agent re-runs and challenges everything.

## Phase 18 — Commits and draft PR

Do not merge or deploy.

---

# 28. DEFINITION OF DONE

The program is complete only when:

## Core PMS

* Reservation workflows are transaction-safe.
* double-booking prevention is proven, including at the database-constraint level.
* inventory is canonical.
* pricing is canonical.
* quote and ARI price equality is proven.
* payment balances are ledger-derived.
* important operations are audited.
* background work is durable.
* failures are visible.
* critical operational gaps are implemented or explicitly documented.

## Architecture

* One canonical path per business operation.
* no hidden competing source of truth.
* no active stale integration path.
* modules have clear ownership.
* critical code is documented.

## Database

* Dedicated Certification/Staging database works.
* Production dedicated database plan is ready.
* no unrelated data exists in target databases.
* other applications on the shared infrastructure are untouched and unaffected.
* migrations replay.
* backup and restore succeed.
* roles are least privilege.
* cutover and rollback are documented.

## Channex

* Correct environment routing.
* certification tenant.
* certification property with realistic, varied data across the 500-day window.
* complete mappings.
* 500-day Full Sync.
* exactly two Full Sync requests.
* Task IDs.
* full scenario matrix covering all executable tests plus prepared declaration answers.
* every executable scenario demonstrably triggered from the normal PMS UI, with the firing file and function identified.
* booking receiving with create, modify and cancel.
* ACK after commit.
* rate-limit protection.
* no periodic Full Sync.
* screenshare demo script complete and rehearsed.
* Production remains inactive.

## Security

* no critical or high unresolved issue.
* no raw card data.
* no CVV.
* no secret leakage, including in git history.
* no high or critical dependency vulnerabilities unresolved or undocumented.
* no tenant crossover.
* no environment crossover.
* authorization enforced server-side.
* webhooks replay-safe.

## Reliability

* worker crash recovery.
* lease recovery.
* dead-letter handling.
* cooldown persistence.
* idempotency.
* duplicate event safety.
* conflict visibility.
* backup and restore.

## Quality

* Build passes.
* typecheck passes.
* lint passes.
* existing tests pass.
* new tests pass.
* browser tests pass.
* no console errors.
* no hydration errors.
* documentation complete.
* `CLAUDE.md`, `AGENTS.md` and `DECISIONS.md` updated to the final architecture.
* a fresh-clone setup works: a new engineer can install, configure from the environment example, migrate and run the system using only the repository documentation, and this was actually verified.
* branch clean.
* draft PR created with a review map.

---

# 29. FINAL REPORT

Return only after completing everything possible without irreversible live Production actions.

The final report must include:

## Executive verdict

* Ready for user testing: yes/no.
* Ready for Channex certification request: yes/no.
* Ready for future Production activation: yes/no.
* exact blockers.

Provide the executive verdict and a concise summary of the whole report in Hebrew as well, for the product owner. The detailed technical sections may remain in English.

## System audit

* Critical findings.
* high findings.
* medium findings.
* obsolete paths.
* incomplete modules.
* PMS capability gaps.

## Architecture

* Previous architecture.
* final architecture.
* ADRs.
* canonical sources of truth.
* refactors.
* removed or disabled legacy paths.

## Database

* Previous topology.
* dedicated topology.
* roles.
* migration result.
* backup result.
* restore result.
* production cutover status.
* rollback.
* confirmation that other applications on the shared infrastructure were untouched.

## PMS improvements

For every major area report:

* What existed.
* what was wrong or incomplete.
* what was improved.
* what remains intentionally deferred.
* why.

Cover:

* Reservations.
* guests.
* inventory.
* pricing.
* payments.
* communications.
* housekeeping.
* maintenance.
* tasks.
* reports.
* permissions.
* audit.
* operations.
* Israel-market readiness.

## Channex

* Environment separation.
* property.
* rooms.
* plans.
* mappings.
* Full Sync.
* incremental sync.
* Task IDs.
* booking receiving.
* rate limits.
* Production guard.

## Certification scenario matrix

For every executable scenario:

* Expected.
* actual.
* expected request count.
* actual request count.
* the normal PMS UI workflow that triggered it.
* the file and function the Channex call fires from.
* Task IDs.
* evidence.
* pass/fail.
* manual step remaining.

For every declaration item: the prepared written answer.

## Remaining human steps

List explicitly what only the user can do, including at minimum:

* Reviewing and merging the draft PR.
* Submitting the official Channex certification form with the Task IDs and declaration answers.
* Scheduling and performing the live screenshare review using the prepared demo script.
* Approving the future production cutover and activation.

## Security

* Threats tested.
* findings.
* fixes.
* residual risks.
* card/token boundary.
* dependency-audit result.

## Performance

* Measurements.
* slow queries.
* indexes.
* load results.
* remaining limits.

## Documentation

* Code comments added.
* JSDoc added.
* database comments.
* documents.
* diagrams.
* runbooks.
* agent guidance files updated.

## Tests

List every command and result.

Do not say only "all tests passed."

## Git delivery

* Branch.
* commits.
* SHAs.
* PR.
* review map.
* merge status.
* deployment status.

## User test plan

Provide one ordered test plan covering:

1. Login and roles.
2. manual reservation.
3. reservation edit.
4. cancellation.
5. availability.
6. pricing.
7. Group Update.
8. payment ledger.
9. communications.
10. certification property.
11. Full Sync.
12. Task IDs.
13. booking receiving (test channel or Booking CRS).
14. failure handling.
15. database isolation.
16. Production activation preview.

## Safety confirmation

Confirm:

* Production was not activated.
* live OTA channels were not modified.
* no real booking was created, changed or cancelled.
* production database cutover was not executed.
* other applications on the shared infrastructure were not touched.
* no secrets were committed.
* rollback assets exist.

---

# 30. QUALITY STANDARD

Do not optimize for the fastest completion.

Optimize for a system that can survive:

* Daily hotel operations.
* concurrent users.
* network outages.
* worker crashes.
* duplicate webhooks.
* malformed OTA data.
* failed payments.
* rate-limit responses.
* database restore.
* credential rotation.
* future multi-property growth.
* a Channex certification screen share, including ad-hoc arbitrary changes requested live.
* a security review.
* another senior engineer maintaining the system later.

Do not return a superficial completion report.

Every important claim must be supported by:

* code.
* database constraints.
* tests.
* browser verification.
* Task IDs.
* logs.
* measured performance.
* or a clearly documented external blocker.

Begin with Phase 0 environment safety, then the read-only multi-agent audit.

Then create the unified target architecture.

Then implement, verify, document and prepare the draft pull request without asking the user routine engineering questions.
