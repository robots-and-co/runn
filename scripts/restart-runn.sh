#!/usr/bin/env bash
# Restart the Runn service (systemd `runn.service`) and health-check it.
#
# WHY THIS EXISTS: the frontend is bind-mounted and updates live, but changes to
# worker/*.js (routes, boot) only load on a service restart. A Claude session
# running inside Runn lives in the runn.service cgroup, so restarting from there
# would kill the session mid-command. Trigger this DETACHED instead, e.g.:
#
#   sudo systemd-run --collect --on-active=15 \
#     /home/waz/projects/runn/scripts/restart-runn.sh
#
# systemd-run puts it in its own cgroup, so the restart survives even as
# runn.service (and the calling session) go down. Progress is written to the log
# below so you can confirm it came back cleanly after your session drops.

set -u
LOG=/home/waz/runn-data/restart.log
URL=http://127.0.0.1:17778
SUDO=""; [ "$(id -u)" -ne 0 ] && SUDO="sudo"

{
  echo "=== $(date '+%F %T %Z') restart requested ==="
  $SUDO systemctl restart runn
  sleep 3
  ok=0
  for i in $(seq 1 20); do
    code=$(curl -s -o /dev/null -w '%{http_code}' "$URL/" || echo 000)
    # The new build serves /finance/commitments as JSON; the old build had no such
    # route and fell through to the HTML single-page app. Content-type = json is
    # the tell that the restarted code is actually the new code.
    ct=$(curl -s -o /dev/null -w '%{content_type}' "$URL/finance/commitments" || echo '')
    echo "check $i: / -> $code · /finance/commitments type -> ${ct:-none}"
    if [ "$code" = "200" ] && printf '%s' "$ct" | grep -qi json; then
      echo "OK: Runn is back and the Debts & purchases routes are live."
      ok=1; break
    fi
    sleep 2
  done
  [ "$ok" = 1 ] || echo "WARN: Runn did not confirm the new routes within ~40s — check 'systemctl status runn' and 'journalctl -u runn -n 50'."
  echo "=== $(date '+%F %T %Z') done ==="
} >>"$LOG" 2>&1
