#!/bin/bash
# Relais SAIGIC -> ORIGEN (LECTURE SEULE du SAIGIC : aucune validation, aucune ecriture)
# Usage : saigic_relais.sh [--configurer | --planifier [minutes, defaut 5] | --arreter | --dry-run | --diag | --diag-detail <connaiss_id>]
# v3 : lit aussi la page détail de chaque connaissement (departement, sous-prefecture, localites) pour connaitre la provenance du cacao.
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
    MIN="${2:-5}"
    case "$MIN" in ''|*[!0-9]*) echo "Intervalle invalide : $MIN"; exit 2 ;; esac
    if [ "$MIN" -lt 1 ] || [ "$MIN" -gt 30 ]; then echo "Intervalle hors limites (1 a 30 minutes) : $MIN"; exit 2; fi
    ( crontab -l 2>/dev/null | grep -vF "$SCRIPT" ; echo "*/$MIN * * * * $SCRIPT >> /var/log/saigic_relais.log 2>&1" ) | crontab -
    echo "Planification installee : un passage toutes les $MIN minutes, 24h/24."
    crontab -l | grep -F "$SCRIPT"
    exit 0 ;;
  --arreter)
    ( crontab -l 2>/dev/null | grep -vF "$SCRIPT" ) | crontab -
    echo "Planification retiree."
    exit 0 ;;
  ""|--dry-run|--diag|--diag-detail|--diag-lien|--diag-recep) ;;
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

# --- Lecture de la page « Details connaissement » (departement, sous-prefecture, localites des producteurs) ---
# Usage : lire_detail_page <fichier_html> <connaiss_id> [fichier_cache] ; sans fichier_cache : affiche le resultat (diagnostic).
lire_detail_page() {
  python3 - "$@" <<'PY'
import re, html, json, sys, unicodedata
from collections import Counter
page = open(sys.argv[1], encoding='utf-8', errors='replace').read()
cid = sys.argv[2]
cache_f = sys.argv[3] if len(sys.argv) > 3 else None
page = re.sub(r'<(script|style)\b.*?</\1>', ' ', page, flags=re.S | re.I)
def norm(s): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', s))).strip()
def sa(s): return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn').upper()
# jetons : texte (txt) ou champ de formulaire (val), dans l'ordre de la page
jetons = []
for m in re.finditer(r'<textarea\b[^>]*>(?P<ta>.*?)</textarea>|<select\b[^>]*>(?P<sel>.*?)</select>|<input\b(?P<inp>[^>]*)>|>(?P<txt>[^<>]+)(?=<)', page, re.S | re.I):
    if m.group('ta') is not None: jetons.append(('val', norm(m.group('ta'))))
    elif m.group('sel') is not None:
        o = re.search(r'<option\b[^>]*\bselected\b[^>]*>(.*?)</option>', m.group('sel'), re.S | re.I)
        jetons.append(('val', norm(o.group(1)) if o else ''))
    elif m.group('inp') is not None:
        a = m.group('inp')
        if re.search(r'type\s*=\s*["\']?(hidden|button|submit|checkbox|radio)', a, re.I): continue
        v = re.search(r'\bvalue\s*=\s*"([^"]*)"|\bvalue\s*=\s*\'([^\']*)\'', a, re.I)
        jetons.append(('val', html.unescape((v.group(1) if v and v.group(1) is not None else (v.group(2) if v else '')) or '').strip()))
    else:
        t = norm(m.group('txt'))
        if t: jetons.append(('txt', t))
out = {}
for i, (k, t) in enumerate(jetons[:-1]):
    if k != 'txt' or jetons[i + 1][0] != 'val': continue
    L = sa(t).rstrip(' :')
    v = jetons[i + 1][1]
    if re.match(r'^DEPARTEMENT$', L) and 'departement' not in out: out['departement'] = v
    elif re.match(r'^(S\s*/\s*PREF|SOUS[- ]?PREF)', L) and 'sous_prefecture' not in out: out['sous_prefecture'] = v
    elif re.match(r'^CERTIFICAT$', L) and 'certificat' not in out: out['certificat'] = v
# colonne « Localite » du tableau des producteurs (si le tableau est dans la page)
loc = []
for tb in re.findall(r'<table\b.*?</table>', page, re.S | re.I):
    lignes = re.findall(r'<tr\b.*?</tr>', tb, re.S | re.I)
    idx = None
    for ln in lignes:
        cel = [norm(c) for c in re.findall(r'<t[hd]\b[^>]*>(.*?)</t[hd]>', ln, re.S | re.I)]
        if idx is None:
            for j, c in enumerate(cel):
                if sa(c).startswith('LOCALIT'): idx = j
            continue
        if idx < len(cel) and cel[idx]: loc.append(cel[idx])
if loc: out['localites'] = [x for x, _ in Counter(loc).most_common()]
if cache_f is None:
    out['_textes_vus'] = [t for k, t in jetons if k == 'txt'][:60]
    out['_taille_page'] = len(page)
    print(json.dumps(out, ensure_ascii=False, indent=1))
else:
    try: cache = json.load(open(cache_f))
    except Exception: cache = {}
    util = out.get('sous_prefecture') or out.get('departement') or out.get('localites')
    if util:
        out['pousse'] = False
        cache[cid] = out
    else:
        e = cache.get(cid, {}); e['echec'] = int(e.get('echec', 0)) + 1; cache[cid] = e
    json.dump(cache, open(cache_f, 'w'), ensure_ascii=False)
    print('ok' if util else 'vide')
PY
}

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

# --- Diagnostic : page « Liste des receptions » (Tracabilite) : colonnes et adresse de la liste (rien n'est envoye) ---
if [ "$MODE" = "--diag-recep" ]; then
  C=$("${CURLB[@]}" -e "$BASE/Pesee/ConnaissementValidation" -o "$PAGE" -w '%{http_code}' "$BASE/Tracabilite/Connaissements")
  echo "=== Liste des receptions : HTTP $C, $(wc -c < "$PAGE") octets ==="
  cp "$PAGE" "$DIR/saigic_recep.html"
  echo "--- colonnes du tableau :"
  python3 - "$PAGE" <<'PY'
import re, html, sys
t = open(sys.argv[1], encoding='utf-8', errors='replace').read()
t = re.sub(r'<(script|style)\b.*?</\1>', ' ', t, flags=re.S | re.I)
print(" | ".join(re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', ' ', c))).strip() for c in re.findall(r'<th\b[^>]*>(.*?)</th>', t, re.S | re.I)))
PY
  echo "--- champs de recherche :"; grep -o -i '<\(input\|select\)[^>]*\(id\|name\)="[^"]*"' "$PAGE" | grep -o '\(id\|name\)="[^"]*"' | sort -u | tr '\n' ' '; echo
  echo "--- code de la liste (lignes 296 a 345 de la page) :"; sed -n '296,345p' "$PAGE" | cut -c1-170 | grep -v '^[[:space:]]*$'
  echo "--- appel de la liste avec les filtres habituels :"
  DD0=$(date -d "$(date +%Y-%m-01) -1 month" +%d/%m/%Y); DF0=$(date +%d/%m/%Y)
  C2=$("${CURLB[@]}" -G --max-time 90 -H 'X-Requested-With: XMLHttpRequest' -H 'Accept: application/json, text/javascript, */*; q=0.01' -e "$BASE/Tracabilite/Connaissements" \
    --data-urlencode "sEcho=1" --data-urlencode "iColumns=12" --data-urlencode "iDisplayStart=0" --data-urlencode "iDisplayLength=3" \
    --data-urlencode "DateDebut=$DD0" --data-urlencode "DateFin=$DF0" --data-urlencode "Prdt_Id=2" --data-urlencode "ddlExp_Id=$EXP" --data-urlencode "Exp_Id=$EXP" --data-urlencode "txtRecherche=" \
    -o "$JS" -w '%{http_code}' "$BASE/Tracabilite/Connaissements")
  echo "HTTP $C2, $(wc -c < "$JS") octets"; head -c 1800 "$JS"; echo
  exit 0
fi

# --- Diagnostic : comment la liste construit le lien vers le detail d'un connaissement (rien n'est envoye) ---
if [ "$MODE" = "--diag-lien" ]; then
  echo "=== Lien « Details » dans la page de validation ==="
  grep -o -i '.\{0,250\}ConnaissementDetails.\{0,250\}' "$PAGE" | head -6
  for SRC in $(grep -o 'src="[^"]*\.js[^"]*"' "$PAGE" | sed 's/src="//;s/"$//' | grep -v -i -E 'jquery|bootstrap|leaflet|bootbox|moment|axios|datatables' | grep '^/' | head -15); do
    "${CURLB[@]}" -e "$BASE/Pesee/ConnaissementValidation" -o "$JS" "$BASE$SRC"
    if grep -q -i 'ConnaissementDetails' "$JS"; then echo "--- dans $SRC :"; grep -o -i '.\{0,250\}ConnaissementDetails.\{0,250\}' "$JS" | head -6; fi
  done
  exit 0
fi

# --- Diagnostic : page detail d'un connaissement (rien n'est envoye) ---
if [ "$MODE" = "--diag-detail" ]; then
  ID="${2:-}"; case "$ID" in ''|*[!0-9]*) echo "Usage : $0 --diag-detail <connaiss_id>   (ex. 1162728)"; exit 2 ;; esac
  # comme dans le navigateur : on demande d'abord la liste (filtres campagne / exportateur), puis on ouvre le detail
  DD0=$(date -d "$(date +%Y-%m-01) -1 month" +%d/%m/%Y); DF0=$(date +%d/%m/%Y)
  "${CURLB[@]}" -G --max-time 90 -H 'X-Requested-With: XMLHttpRequest' -H 'Accept: application/json, text/javascript, */*; q=0.01' \
    -e "$BASE/Pesee/ConnaissementValidation" --data-urlencode "sEcho=1" --data-urlencode "iColumns=11" \
    --data-urlencode "iDisplayStart=0" --data-urlencode "iDisplayLength=200" --data-urlencode "Prdt_Id=2" --data-urlencode "Camp_Id=$CAMP" --data-urlencode "Exp_Id=$EXP" \
    --data-urlencode "DateDebut=$DD0" --data-urlencode "DateFin=$DF0" --data-urlencode "TexteRecherche=" --data-urlencode "Statut=3" --data-urlencode "Trace=" \
    -o "$JS" -w 'liste demandee d abord : HTTP %{http_code}\n' "$BASE/Pesee/ConnaissementValidation"
  CD=$("${CURLB[@]}" -e "$BASE/Pesee/ConnaissementValidation" -o "$PAGE" -w '%{http_code}' "$BASE/pesee/ConnaissementDetails/$ID")
  echo "=== Detail du connaissement $ID : HTTP $CD, $(wc -c < "$PAGE") octets ==="
  cp "$PAGE" "$DIR/saigic_detail_$ID.html" && echo "Page enregistree dans $DIR/saigic_detail_$ID.html"
  echo "--- La page (sans parametre) contient-elle les champs ? $(grep -c 'Fournisseur' "$PAGE") occurrence(s) de « Fournisseur », $(grep -c 'Aucune donn' "$PAGE") « Aucune donnee »"
  shift 2
  for SPF in "" "$@"; do
    echo "=== codeSpf='$SPF' ==="
    CP=$("${CURLB[@]}" -G -H 'X-Requested-With: XMLHttpRequest' -e "$BASE/pesee/ConnaissementDetails/$ID" \
      --data-urlencode "cnsement_id=$ID" --data-urlencode "codeSpf=$SPF" -o "$JS" -w '%{http_code}' "$BASE/Tracabilite/getCnsementProducteurs")
    echo "producteurs : HTTP $CP, $(wc -c < "$JS") octets"
    python3 - "$JS" <<'PY'
import re, html, sys
t = open(sys.argv[1], encoding='utf-8', errors='replace').read()
t = re.sub(r'<(script|style)\b.*?</\1>', ' ', t, flags=re.S | re.I)
t = re.sub(r'<[^>]+>', ' | ', t)
print("  ", re.sub(r'(\s*\|\s*)+', ' | ', re.sub(r'\s+', ' ', html.unescape(t)))[:500])
PY
    if [ -n "$SPF" ]; then
      CQ=$("${CURLB[@]}" -e "$BASE/Pesee/ConnaissementValidation" -o "$PAGE" -w '%{http_code}' "$BASE/pesee/ConnaissementDetails/$ID?codeSpf=$SPF")
      echo "page avec ?codeSpf= : HTTP $CQ, $(grep -c 'Fournisseur' "$PAGE") « Fournisseur », $(grep -c 'Aucune donn' "$PAGE") « Aucune donnee »"
    fi
  done
  exit 0
fi

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

# --- Etape 7 : detail de chaque connaissement (departement, sous-prefecture, localites) -> provenance du cacao ---
# Ne touche jamais au compteur d'echecs. Au plus 15 pages detail par passage, une seule fois par connaissement (cache local).
if [ "$DRY" != "1" ]; then
  DETAILS_URL="${RELAIS_URL_DETAILS:-${RELAIS_URL}-details}"
  CACHE_DET="$DIR/.saigic_details.json"
  IDS=$(python3 - "$MERGED" "$TOUS" "$CACHE_DET" <<'PY'
import json, sys
def lire(f):
    try: return json.load(open(f))
    except Exception: return []
try: cache = json.load(open(sys.argv[3]))
except Exception: cache = {}
vus, ids = set(), []
for r in lire(sys.argv[1]) + lire(sys.argv[2]):
    i = str(r.get("connaiss_id") or "")
    if not i or i in vus: continue
    vus.add(i)
    e = cache.get(i)
    if e is None or ("pousse" not in e and int(e.get("echec", 0)) < 3): ids.append(i)
print(" ".join(ids[:15]))
PY
)
  for ID in $IDS; do
    CD=$("${CURLB[@]}" -e "$BASE/Pesee/ConnaissementValidation" -o "$PAGE" -w '%{http_code}' "$BASE/pesee/ConnaissementDetails/$ID")
    if [ "$CD" = "200" ]; then R=$(lire_detail_page "$PAGE" "$ID" "$CACHE_DET"); [ "$R" = "ok" ] || journal "Detail $ID : aucune provenance lue dans la page."
    else journal "Detail $ID : HTTP $CD"; fi
    sleep 1
  done
  # envoi a ORIGEN des details pas encore pousses (le connaissement doit deja exister cote ORIGEN)
  NBD=$(python3 - "$MERGED" "$TOUS" "$CACHE_DET" "$PAYLOAD" <<'PY'
import json, sys
def lire(f):
    try: return json.load(open(f))
    except Exception: return []
try: cache = json.load(open(sys.argv[3]))
except Exception: cache = {}
ids = {str(r.get("connaiss_id")): r.get("N_connais") for r in lire(sys.argv[1]) + lire(sys.argv[2]) if r.get("connaiss_id")}
det = []
for i, code in ids.items():
    e = cache.get(i)
    if e and e.get("pousse") is False:
        det.append({"connaiss_id": i, "N_connais": code, "departement": e.get("departement"), "sous_prefecture": e.get("sous_prefecture"), "localites": e.get("localites")})
json.dump({"details": det}, open(sys.argv[4], "w"), ensure_ascii=False)
print(len(det))
PY
)
  if [ "${NBD:-0}" -gt 0 ]; then
    HTTP3=$(curl -s --max-time 120 -H 'Content-Type: application/json' -H "x-relais-secret: $RELAIS_SECRET" \
      --data-binary @"$PAYLOAD" -o "$REP" -w '%{http_code}' "$DETAILS_URL")
    journal "Provenance ($NBD detail(s)) : HTTP $HTTP3 $(cut -c1-300 "$REP")"
    if [ "$HTTP3" = "200" ]; then
      python3 - "$REP" "$CACHE_DET" <<'PY'
import json, sys
try:
    rep = json.load(open(sys.argv[1])); cache = json.load(open(sys.argv[2]))
except Exception:
    sys.exit(0)
for i in rep.get("traites", []):
    if str(i) in cache: cache[str(i)]["pousse"] = True
json.dump(cache, open(sys.argv[2], "w"), ensure_ascii=False)
PY
    fi
  fi
fi
