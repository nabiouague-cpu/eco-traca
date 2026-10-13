#!/bin/bash
# Robot PESÉES SAIGIC -> ORIGEN. Charge les identifiants depuis le même fichier que le robot des connaissements,
# puis lance saigic_pesees.py. Options : --planifier, --arreter, --dry-run, --verifier, --une.
set -u
ENV_FILE="${SAIGIC_ENV:-/root/.saigic_relais.env}"
LOCK=/root/.saigic_pesees.lock
case "${1:-}" in
  --planifier)
    ( crontab -l 2>/dev/null | grep -v saigic_pesees.sh ; echo '2-59/5 * * * * /bin/bash /root/saigic_pesees.sh >> /var/log/saigic_pesees.log 2>&1' ) | crontab -
    echo "Planifié : toutes les 5 minutes (décalé de 2 min par rapport au robot des connaissements). Journal : /var/log/saigic_pesees.log"; exit 0;;
  --arreter)
    crontab -l 2>/dev/null | grep -v saigic_pesees.sh | crontab - ; echo "Robot des pesées retiré du cron."; exit 0;;
esac
[ -r "$ENV_FILE" ] || { echo "fichier $ENV_FILE introuvable"; exit 2; }
set -a; . "$ENV_FILE"; set +a
exec 9>"$LOCK"; flock -n 9 || { echo "$(date '+%F %T') passage précédent encore en cours"; exit 0; }
exec /usr/bin/python3 /root/saigic_pesees.py "$@"
