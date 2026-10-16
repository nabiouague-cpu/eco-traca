#!/bin/bash
# Relais SAIGIC -> ORIGEN (LECTURE SEULE du SAIGIC : aucune validation, aucune ecriture)
# Usage : saigic_relais.sh [--configurer | --planifier | --arreter | --dry-run | --diag]
# v2 : en plus de la liste « Non valide », lit la liste de TOUS les statuts et l'envoie a reception-saigic-rattrapage
#      (connaissements deja valides que le robot n'avait jamais vus). --diag : montre ce que renvoie le SAIGIC pour chaque statut (rien n'est envoye).
DIR="${SAIGIC_DIR:-/root}"
ENV_FILE="$DIR/.saigic_relais.env"
STOP_FILE="$DIR/.saigic_relais.stop"
FAIL_FILE="$DIR/.saigic_relais.fails"
LOCK_FILE="$DIR/.saigic_relais.lock"
BASE="${SAIGIC_BASE:-https://www.conseilcafecacao.ci:8088}"
RELAIS_URL="${RELAIS_URL:-https://sfjvtwzrnzjvyhfqxswm.supabase.co/functions/v1/reception-saigic}"
UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
MODE="${1:-}"
SCRIPT="$(readlink -f "$0")"

journal() { echo "$(date '+%F %T') $*"; }

case "$MODE" in
  --configurer)
    umask 077
    read -r -p 'Identifiant SAIGIC: ' U
    read -r -s -p 'Mot de passe du POPUP: ' PP; echo
    read -r -s -p 'Mot de passe du FORMULAIRE: ' PF; echo
    echo "longueurs: identifiant=${#U} popup=${#PP} formulaire=${#PF}"
    SECRET=$(openssl rand -hex 24)
    {
      printf 'SAIGIC_LOGIN=%q\n' "$U"
      printf 'SAIGIC_POPUP=%q\n' "$PP"
      printf 'SAIGIC_FORM=%q\n' "$PF"
      printf 'RELAIS_SECRET=%q\n' "$SECRET"
    } > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    rm -f "$STOP_FILE" "$FAIL_FILE"
    echo
    echo "Configuration enregistree dans $ENV_FILE (lisible par root seulement)."
    echo "Secret a copier dans Supabase sous le nom RELAIS_SAIGIC_SECRET :"
    echo "$SECRET"
    exit 0 ;;
  --planifier)
    chmod +x "$SCRIPT"
    ( crontab -l 2>/dev/null | grep -vF "$SCRIPT" ; echo "*/5 * * * * $SCRIPT >> /var/log/saigic_relais.log 2>&1" ) | crontab -
    echo "Planification installee : un passage toutes les 5 minutes, 24h/24."
    crontab -l | grep -F "$SCRIPT"
    exit 0 ;;
  --arreter)
    ( crontab -l 2>/dev/null | grep -vF "$SCRIPT" ) | crontab -
    echo "Planification retiree."
    exit 0 ;;
  ""|--dry-run|--diag) ;;
  *) echo "Option inconnue : $MODE"; exit 2 ;;
esac

DRY=0; [ "$MODE" = "--dry-run" ] && DRY=1

if [ -f "$STOP_FILE" ]; then
  journal "ARRET : veille suspendue (fichier $STOP_FILE present). Verifier les acces SAIGIC puis supprimer ce fichier."
  exit 0
fi
if [ ! -f "$ENV_FILE" ]; then journal "Configuration absente : lancer --configurer"; exit 1; fi
# shellcheck disable=SC1090
. "$ENV_FILE"

exec 9>"$LOCK_FILE"
if ! flock -n 9; then journal "Passage precedent encore en cours, on saute."; exit 0; fi

CJ=$(mktemp); PAGE=$(mktemp); JS=$(mktemp); MERGED=$(mktemp); PAYLOAD=$(mktemp); REP=$(mktemp); TOUS=$(mktemp)
trap 'rm -f "$CJ" "$PAGE" "$JS" "$MERGED" "$PAYLOAD" "$REP" "$TOUS"' EXIT

alerte() {
  local msg
  msg=$(printf '%s' "$1" | tr -d '"\\' | cut -c1-300)
  curl -s --max-time 30 -H 'Content-Type: application/json' -H "x-relais-secret: $RELAIS_SECRET" \
    -d "{\"alerte\": \"$msg\"}" "$RELAIS_URL" > /dev/null 2>&1
}
echec() {
  local n
  n=$(( $(cat "$FAIL_FILE" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAIL_FILE"
  journal "ECHEC ($n consecutif(s)) : $1"
  if [ "$n" -eq 6 ]; then alerte "La veille SAIGIC echoue depuis 6 passages consecutifs : $1"; fi
  exit 1
}
arret_acces() {
  touch "$STOP_FILE"
  journal "ARRET : $1"
  alerte "Veille SAIGIC arretee pour ne pas verrouiller le compte partage : $1. Verifier les acces puis supprimer $STOP_FILE sur le serveur."
  exit 1
}

CURLB=(curl -sk --max-time 60 --basic -u "$SAIGIC_LOGIN:$SAIGIC_POPUP" -c "$CJ" -b "$CJ" -A "$UA")

# --- Etape 1 : premiere porte (popup) et jeton du formulaire ---
C1=$("${CURLB[@]}" -o "$PAGE" -w '%{http_code}' "$BASE/SGAccount/LogOn")
case "$C1" in
  200) ;;
  401) arret_acces "mot de passe du popup refuse (401)" ;;
  *)   echec "SAIGIC injoignable ou reponse inattendue (code $C1)" ;;
esac
TOKEN=$(grep -oE 'name="__RequestVerificationToken"[^>]*value="[^"]*"' "$PAGE" | head -1 | sed -E 's/.*value="([^"]*)".*/\1/')
[ -n "$TOKEN" ] || echec "jeton de connexion introuvable (page modifiee ?)"

# --- Etape 2 : formulaire de connexion ---
C2=$("${CURLB[@]}" -e "$BASE/SGAccount/LogOn" \
  --data-urlencode "__RequestVerificationToken=$TOKEN" \
  --data-urlencode "UserName=$SAIGIC_LOGIN" \
  --data-urlencode "Password=$SAIGIC_FORM" \
  --data-urlencode "RememberMe=false" \
  -o /dev/null -w '%{http_code}' "$BASE/SGAccount/LogOn")
if [ "$C2" != "302" ]; then
  if [ "$C2" = "200" ]; then arret_acces "mot de passe du formulaire refuse"; fi
  echec "connexion au formulaire (code $C2)"
fi

# --- Etape 3 : page de validation (campagne et exportateur lus dans la page) ---
C3=$("${CURLB[@]}" -o "$PAGE" -w '%{http_code}' "$BASE/Pesee/ConnaissementValidation")
[ "$C3" = "200" ] || echec "page de validation inaccessible (code $C3)"
if grep -q 'name="UserName"' "$PAGE" && grep -q 'type="password"' "$PAGE"; then echec "session non etablie (renvoye vers la connexion)"; fi
CAMP=$(grep -oE '"name": *"Camp_Id", *"value": *'"'"'[0-9]+'"'"'' "$PAGE" | grep -oE '[0-9]+' | tail -1)
EXP=$(grep -oE 'Exp_Id", *"value": *[^}]*' "$PAGE" | grep -oE "[0-9]+" | tail -1)
[ -n "$CAMP" ] || { journal "Attention : campagne non lue dans la page, valeur 26 utilisee."; CAMP=26; }
[ -n "$EXP" ]  || { journal "Attention : exportateur non lu dans la page, valeur 009 utilisee."; EXP=009; }

# --- Etape 4 : liste des connaissements (cacao, non valides, du 1er du mois precedent a aujourd'hui) ---
DD=$(date -d "$(date +%Y-%m-01) -1 month" +%d/%m/%Y)
DF=$(date +%d/%m/%Y)
if [ "$MODE" = "--diag" ]; then
  echo "=== DIAGNOSTIC : ce que le SAIGIC renvoie selon le parametre Statut (du $DD au $DF, campagne $CAMP, exportateur $EXP) ==="
  for ST in "" 1 2 3 4 5 6; do
    CLD=$("${CURLB[@]}" -G --max-time 90 \
      -H 'X-Requested-With: XMLHttpRequest' -H 'Accept: application/json, text/javascript, */*; q=0.01' \
      -e "$BASE/Pesee/ConnaissementValidation" \
      --data-urlencode "sEcho=1" --data-urlencode "iColumns=11" \
      --data-urlencode "iDisplayStart=0" --data-urlencode "iDisplayLength=3" \
      --data-urlencode "Prdt_Id=2" --data-urlencode "Camp_Id=$CAMP" --data-urlencode "Exp_Id=$EXP" \
      --data-urlencode "DateDebut=$DD" --data-urlencode "DateFin=$DF" \
      --data-urlencode "TexteRecherche=" --data-urlencode "Statut=$ST" --data-urlencode "Trace=" \
      -o "$JS" -w '%{http_code}' "$BASE/Pesee/ConnaissementValidation")
    echo "--- Statut='$ST' : HTTP $CLD"
    python3 - "$JS" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    print("   (reponse illisible)"); sys.exit(0)
rows = d.get("aaData") or d.get("data") or []
print("   total =", d.get("iTotalRecords", d.get("recordsTotal", "?")), "| lignes lues =", len(rows))
if rows and isinstance(rows[0], dict):
    print("   colonnes :", ", ".join(sorted(rows[0].keys())))
    for r in rows[:3]:
        print("   ", r.get("N_connais"), "|", r.get("date_detail"), "|", {k: v for k, v in r.items() if "stat" in k.lower() or "valid" in k.lower()})
PY
    sleep 2
  done
  exit 0
fi

# Lit la liste des connaissements pour un statut. $1 = statut ("" = tous), $2 = fichier de cumul, $3 = dur (echec = arret) ou doux (renvoie 1).
lister() {
  local ST="$1" OUT="$2" SOFT="${3:-dur}" DEBUT=0 NBPAGES=0 TOTAL NB CL RES
  rm -f "$OUT"
  while :; do
    CL=$("${CURLB[@]}" -G --max-time 90 \
      -H 'X-Requested-With: XMLHttpRequest' -H 'Accept: application/json, text/javascript, */*; q=0.01' \
      -e "$BASE/Pesee/ConnaissementValidation" \
      --data-urlencode "sEcho=1" --data-urlencode "iColumns=11" \
      --data-urlencode "iDisplayStart=$DEBUT" --data-urlencode "iDisplayLength=200" \
      --data-urlencode "Prdt_Id=2" --data-urlencode "Camp_Id=$CAMP" --data-urlencode "Exp_Id=$EXP" \
      --data-urlencode "DateDebut=$DD" --data-urlencode "DateFin=$DF" \
      --data-urlencode "TexteRecherche=" --data-urlencode "Statut=$ST" --data-urlencode "Trace=" \
      -o "$JS" -w '%{http_code}' "$BASE/Pesee/ConnaissementValidation")
    if [ "$CL" != "200" ]; then [ "$SOFT" = "doux" ] && return 1; echec "liste des connaissements (code $CL)"; fi
    RES=$(python3 - "$JS" "$OUT" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
except Exception:
    print("ERR"); sys.exit(0)
rows = d.get("aaData") or d.get("data") or []
total = d.get("iTotalRecords", d.get("recordsTotal", len(rows)))
try:
    acc = json.load(open(sys.argv[2]))
except Exception:
    acc = []
acc.extend(rows)
json.dump(acc, open(sys.argv[2], "w"))
print(total, len(rows))
PY
)
    read -r TOTAL NB <<< "$RES"
    if [ "$TOTAL" = "ERR" ] || [ -z "$NB" ]; then [ "$SOFT" = "doux" ] && return 1; echec "reponse du SAIGIC illisible (pas du JSON)"; fi
    NBPAGES=$((NBPAGES+1)); DEBUT=$((DEBUT+200))
    [ "$NB" -lt 200 ] && break
    [ "$DEBUT" -ge "$TOTAL" ] && break
    [ "$NBPAGES" -ge 10 ] && break
    sleep 2
  done
  return 0
}

lister 3 "$MERGED" dur

NBL=$(python3 - "$MERGED" "$PAYLOAD" "$DRY" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
json.dump({"lignes": rows, "dry_run": sys.argv[3] == "1"}, open(sys.argv[2], "w"))
print(len(rows))
PY
)
journal "SAIGIC : $NBL connaissement(s) non valide(s) du $DD au $DF (campagne $CAMP, exportateur $EXP)."

# --- Etape 5 : envoi a ORIGEN ---
HTTP=$(curl -s --max-time 120 -H 'Content-Type: application/json' -H "x-relais-secret: $RELAIS_SECRET" \
  --data-binary @"$PAYLOAD" -o "$REP" -w '%{http_code}' "$RELAIS_URL")
if [ "$HTTP" = "200" ]; then
  rm -f "$FAIL_FILE"
  if [ "$DRY" = "1" ]; then journal "ORIGEN (essai a blanc, rien n'est cree) :"; cat "$REP"; echo; else journal "ORIGEN : $(cut -c1-600 "$REP")"; fi
else
  echec "reception ORIGEN refusee (code $HTTP) : $(cut -c1-200 "$REP")"
fi

# --- Etape 6 : rattrapage — connaissements de TOUS les statuts (dont ceux deja valides, jamais vus « Non valide ») ---
# Ne touche jamais au compteur d'echecs : si cette etape echoue, le robot principal n'est pas affecte.
if [ "$HTTP" = "200" ]; then
  RELAIS_RATT_URL="${RELAIS_URL_RATTRAPAGE:-${RELAIS_URL}-rattrapage}"
  if lister "" "$TOUS" doux; then
    NBT=$(python3 - "$TOUS" "$PAYLOAD" "$DRY" <<'PY'
import json, sys
try:
    rows = json.load(open(sys.argv[1]))
except Exception:
    rows = []
json.dump({"lignes": rows, "dry_run": sys.argv[3] == "1"}, open(sys.argv[2], "w"))
print(len(rows))
PY
)
    if [ "${NBT:-0}" -gt 0 ]; then
      HTTP2=$(curl -s --max-time 120 -H 'Content-Type: application/json' -H "x-relais-secret: $RELAIS_SECRET" \
        --data-binary @"$PAYLOAD" -o "$REP" -w '%{http_code}' "$RELAIS_RATT_URL")
      journal "Rattrapage (tous statuts, $NBT ligne(s)) : HTTP $HTTP2 $(cut -c1-400 "$REP")"
    else
      journal "Rattrapage : liste de tous les statuts vide ou non lue, rien a envoyer."
    fi
  else
    journal "Rattrapage : liste de tous les statuts illisible, etape ignoree."
  fi
fi
