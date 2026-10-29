#!/bin/bash
# Robot LOTS EXPORT SAIGIC -> ORIGEN. Même fichier d'identifiants que les autres robots ; lance saigic_lots.py.
# Options : --planifier [minutes, défaut 5], --arreter, --dry-run (rien n'est écrit dans ORIGEN), sans option = un passage.
set -u
ENV_FILE="${SAIGIC_ENV:-/root/.saigic_relais.env}"
LOCK=/root/.saigic_lots.lock
case "${1:-}" in
  --planifier)
    MIN="${2:-5}"
    case "$MIN" in ''|*[!0-9]*) echo "Intervalle invalide : $MIN"; exit 2 ;; esac
    if [ "$MIN" -lt 2 ] || [ "$MIN" -gt 30 ]; then echo "Intervalle hors limites (2 à 30 minutes) : $MIN"; exit 2; fi
    ( crontab -l 2>/dev/null | grep -v saigic_lots.sh ; echo "1-59/$MIN * * * * /bin/bash /root/saigic_lots.sh >> /var/log/saigic_lots.log 2>&1" ) | crontab -
    echo "Planifié : un passage toutes les $MIN minutes (décalé d'une minute des autres robots). Journal : /var/log/saigic_lots.log"; exit 0;;
  --arreter)
    crontab -l 2>/dev/null | grep -v saigic_lots.sh | crontab - ; echo "Robot des lots retiré du cron."; exit 0;;
esac
[ -r "$ENV_FILE" ] || { echo "fichier $ENV_FILE introuvable"; exit 2; }
set -a; . "$ENV_FILE"; set +a
exec 9>"$LOCK"; flock -n 9 || { echo "$(date '+%F %T') passage précédent encore en cours"; exit 0; }
exec /usr/bin/python3 /root/saigic_lots.py "$@"
