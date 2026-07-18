#!/usr/bin/env bash
# guesthub-db-firewall — Stage 2 mitigation for defect C2 (docs/audit/DEFECT_MATRIX.md).
#
# Docker publishes the Supabase pooler (5432/6543) and the disposable test DB
# (host 5433 -> container 5432) on 0.0.0.0, and Docker's DNAT bypasses UFW's
# INPUT filtering, so these database ports are reachable from the public
# internet. This script blocks external access to those ports at the netfilter
# layer via the DOCKER-USER chain (evaluated in FORWARD before Docker's own
# rules), scoped to the public interface only.
#
# Why interface-scoped (-i ens3):
#   * localhost app traffic (127.0.0.1:5432) never enters via FORWARD -> unaffected.
#   * container-to-container traffic arrives on docker bridge ifaces -> unaffected.
#   * Tailscale admin traffic arrives on tailscale0 -> still allowed (VPN access kept).
# Post-DNAT the destination is the CONTAINER port: pooler=5432/6543, testdb=5432,
# so a single --dport 5432 rule covers both pooler(5432) and testdb.
#
# SAFETY: idempotent (checks before inserting); never restarts Docker or any
# container; touches only the DOCKER-USER chain. Re-run any time.
#
# Install as a boot-persistent unit (see docs/database/DB_EXPOSURE_MITIGATION.md):
#   sudo cp scripts/ops/guesthub-db-firewall.sh /usr/local/sbin/
#   sudo systemctl enable --now guesthub-db-firewall.service
set -euo pipefail

PUB_IF="${PUB_IF:-ens3}"          # public interface
PORTS=(5432 6543)                  # container-side DB ports to block externally
COMMENT_PREFIX="guesthub-C2: block external DB"

# C2 Kong portion (Stage 6): the shared Supabase gateway (supabase-kong) publishes
# 8000 (plaintext) and 8443 (TLS) on 0.0.0.0 — internet-exposed. The only
# legitimate ingress is nginx :443 (Certbot TLS for db.bios.co.il) -> proxy_pass
# http://127.0.0.1:8000, i.e. LOOPBACK. Host apps also reach the gateway via
# localhost:8000. Neither path enters via ${PUB_IF}, so an interface-scoped DROP
# closes the external attack surface (esp. plaintext auth on 8000) without
# touching the nginx ingress, container-to-container traffic, or Tailscale admin.
# Ingress path confirmed 2026-07-18: /etc/nginx/sites-available/supabase.
GATEWAY_PORTS=(8000 8443)
GATEWAY_COMMENT_PREFIX="guesthub-C2: block external Kong gateway"

ensure() {  # ensure <iptables-bin> <port> <comment-prefix>
  local bin="$1" port="$2" prefix="$3"
  if ! "$bin" -C DOCKER-USER -i "$PUB_IF" -p tcp --dport "$port" \
        -m comment --comment "${prefix} ${port}" -j DROP 2>/dev/null; then
    "$bin" -I DOCKER-USER -i "$PUB_IF" -p tcp --dport "$port" \
        -m comment --comment "${prefix} ${port}" -j DROP
    echo "inserted ${bin} DROP ${PUB_IF} tcp/${port}"
  else
    echo "present  ${bin} DROP ${PUB_IF} tcp/${port}"
  fi
}

for p in "${PORTS[@]}"; do
  ensure iptables "$p" "$COMMENT_PREFIX"
  ensure ip6tables "$p" "$COMMENT_PREFIX"
done

for p in "${GATEWAY_PORTS[@]}"; do
  ensure iptables "$p" "$GATEWAY_COMMENT_PREFIX"
  ensure ip6tables "$p" "$GATEWAY_COMMENT_PREFIX"
done

echo "guesthub-db-firewall applied on ${PUB_IF} for ports: ${PORTS[*]} ${GATEWAY_PORTS[*]}"
