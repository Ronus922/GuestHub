# Database Exposure Mitigation — Defect C2

**Date:** 2026-07-18 · **Stage:** 2 · **Status:** Applied and boot-persistent · **Defect:** C2 (`docs/audit/DEFECT_MATRIX.md`)

## The problem

Docker publishes three database ports on `0.0.0.0`:

| Host port | Container | Container port | Purpose |
|---|---|---|---|
| 5432 | `supabase-pooler` | 5432 | Supavisor session pooler (the app's `DATABASE_URL`) |
| 6543 | `supabase-pooler` | 6543 | Supavisor transaction pooler |
| 5433 | `guesthub-testdb` | 5432 | Disposable test DB |

The host firewall (UFW) allows only 22/80/443/41641 inbound, but **Docker's DNAT is evaluated in the `FORWARD` path and bypasses UFW's `INPUT` rules entirely**. The `DOCKER-USER` chain — the one place an operator is meant to add restrictions, evaluated before Docker's own DNAT rules — was **empty**. Result: the database ports were reachable from the public internet, with password authentication as the only barrier.

Verified 2026-07-18: external nodes (check-host.net, Russia/Sweden) reached `51.195.82.57:5432`; after mitigation their SYNs are dropped (see Evidence).

## The mitigation

An interface-scoped DROP in `DOCKER-USER` on the public interface (`ens3`) for the container-side DB ports:

```
iptables  -I DOCKER-USER -i ens3 -p tcp --dport 5432 -j DROP   # pooler session + testdb (host 5433 DNATs to container 5432)
iptables  -I DOCKER-USER -i ens3 -p tcp --dport 6543 -j DROP   # pooler transaction
ip6tables -I DOCKER-USER -i ens3 -p tcp --dport 5432 -j DROP
ip6tables -I DOCKER-USER -i ens3 -p tcp --dport 6543 -j DROP
```

### Why this is safe (does not break anything)

- **Localhost apps unaffected:** `127.0.0.1:5432` traffic (every GuestHub app + the other apps) is handled locally via `docker-proxy` and never traverses the `FORWARD`/`DOCKER-USER` path. Confirmed still OPEN post-change; prod app `:3007` returns HTTP 200; live query `guesthub.tenants=1`.
- **Container-to-container unaffected:** inter-container traffic arrives on the docker bridge interfaces, not `ens3`.
- **Tailscale admin access preserved:** VPN traffic arrives on `tailscale0`, not `ens3`, so remote DBA access over Tailscale still works.
- **Post-DNAT matching:** in `DOCKER-USER` the destination is already the container port, so `--dport 5432` covers both the pooler (5432) and the test DB (host 5433 → container 5432); `--dport 6543` covers the transaction pooler.
- **No container/daemon restart:** rules are inserted live. Zero PM2 restarts observed (guesthub stayed at 66, worker 49, and the three unrelated apps unchanged).

### Scope note — gateway ports 8000/8443 (Kong) NOT blocked here

The Supabase Kong gateway (`8000`/`8443`) is also published on `0.0.0.0`. It is **intentionally left open** by this mitigation because `NEXT_PUBLIC_SUPABASE_URL=https://db.bios.co.il` (browser auth) appears to reach Kong's `:8443` directly (the `supabase` nginx vhost that would proxy 443→127.0.0.1:8000 exists only in `sites-available`, not `sites-enabled`). Blocking Kong externally could break authentication for GuestHub and possibly the other apps on the shared stack. Kong requires anon/service-role JWTs and is a narrower surface than raw Postgres. **Gateway hardening (confirm the true `db.bios.co.il` ingress path, then restrict 8000/8443 or move behind nginx/Tailscale) is tracked for Stage 6** (`DEFECT_MATRIX.md` C2 → Stage 6 verify).

## Persistence

`DOCKER-USER` rules do not survive a reboot or a Docker daemon restart (Docker rebuilds the chain empty). Persistence is provided by:

- **Script:** `scripts/ops/guesthub-db-firewall.sh` (repo source of truth) → installed to `/usr/local/sbin/guesthub-db-firewall.sh`. Idempotent (`-C` check before `-I`), v4+v6.
- **Unit:** `/etc/systemd/system/guesthub-db-firewall.service` — `Type=oneshot`, `After=docker.service`, `PartOf=docker.service` (re-asserts whenever Docker restarts), `enabled --now`.

Re-apply manually any time: `sudo /usr/local/sbin/guesthub-db-firewall.sh` (safe, idempotent).

To install on a fresh host:
```
sudo cp scripts/ops/guesthub-db-firewall.sh /usr/local/sbin/
sudo cp <this unit> /etc/systemd/system/guesthub-db-firewall.service   # unit text above
sudo systemctl daemon-reload && sudo systemctl enable --now guesthub-db-firewall.service
```

## Evidence (2026-07-18)

- Before: `51.195.82.57:{5432,6543,5433}` OPEN.
- After: external check-host.net nodes → "Connection timed out" on 5432; the `DOCKER-USER` DROP counter for tcp/5432 incremented to **16 packets / 960 bytes** from those external probes — proving (a) external SYNs do reach `ens3` (no blanket upstream/OVH block to rely on) and (b) the rule drops them.
- Localhost `{5432,6543,5433}` still OPEN; prod app HTTP 200; DB query OK; all 5 PM2 apps online, restart counts unchanged.

## Residual / follow-up

- **Defense in depth:** an upstream OVH cloud firewall is recommended as a second layer (user action; the panel cannot be verified from the host). This host-level rule stands on its own regardless.
- **Kong 8000/8443** gateway hardening → Stage 6.
- The structural fix for the *shared-database* aspect (C1) — moving GuestHub onto dedicated clusters so the shared pooler is no longer GuestHub's DB at all — is the main body of Stage 2 (ADR-0002).
