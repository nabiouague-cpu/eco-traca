#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Robot PESÉES SAIGIC -> ORIGEN (lecture seule). Second robot sur le VPS, même modèle que saigic_relais.sh.

Un passage :
  1. connexion au SAIGIC (porte 1 : HTTP Basic ; porte 2 : formulaire /SGAccount/LogOn) ;
  2. lecture de la liste « Validation des pesées » (/pesee/AjaxHandlerIndex, JSON paginé),
     cacao, achat tout-venant, du 1er septembre de la campagne à aujourd'hui, tous statuts ;
  3. pour chaque pesée nouvelle ou modifiée : lecture du détail (POST /Pesee/DetailPeseeCCQ/{id}),
     qui donne le n° de connaissement, le code fournisseur, les sacs et les poids ;
  4. envoi à ORIGEN (fonction Supabase reception-pesees-saigic), en-tête x-relais-secret.
Il ne clique JAMAIS sur « Valider » : aucune écriture sur le SAIGIC.

Variables d'environnement (chargées par saigic_pesees.sh depuis /root/.saigic_relais.env) :
  identifiant, mot de passe popup, mot de passe formulaire, secret du relais — repérés par leur nom.
  SAIGIC_BASE (défaut https://www.conseilcafecacao.ci:8088), RELAIS_PESEES_URL.
Options : --dry-run (rien n'est écrit dans ORIGEN), --verifier (montre les variables trouvées, sans valeurs),
          --une (ne traite qu'une pesée, pour contrôler la lecture du détail).
"""
import base64, html, http.cookiejar, json, os, re, ssl, sys, time, urllib.parse, urllib.request, urllib.error
from datetime import date, datetime

BASE = os.environ.get('SAIGIC_BASE', 'https://www.conseilcafecacao.ci:8088').rstrip('/')
RELAIS_URL = os.environ.get('RELAIS_PESEES_URL', 'https://sfjvtwzrnzjvyhfqxswm.supabase.co/functions/v1/reception-pesees-saigic')
ALERTE_URL = os.environ.get('RELAIS_URL', 'https://sfjvtwzrnzjvyhfqxswm.supabase.co/functions/v1/reception-saigic')
ETAT = os.environ.get('PESEES_ETAT', '/root/.saigic_pesees_etat.json')
STOP = os.environ.get('PESEES_STOP', '/root/.saigic_pesees.stop')
FAILS = os.environ.get('PESEES_FAILS', '/root/.saigic_pesees.fails')
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36'
VERSION = '4'
DRY = '--dry-run' in sys.argv
UNE = '--une' in sys.argv

def log(m): print(datetime.now().strftime('%Y-%m-%d %H:%M:%S') + ' ' + m, flush=True)

# ---------- variables d'environnement : repérées par leur nom ----------
def trouver_env():
    env = {k: v for k, v in os.environ.items() if v}
    def pick(*motifs, exclure=()):
        for k in sorted(env):
            K = k.upper()
            if any(re.search(e, K) for e in exclure): continue
            if all(re.search(m, K) for m in motifs): return k
        return None
    ident = pick(r'SAIGIC', r'USER|IDENT|LOGIN')
    popup = pick(r'SAIGIC', r'POPUP|BASIC')
    form = pick(r'SAIGIC', r'FORM|PASS|MDP', exclure=(r'POPUP', r'BASIC'))
    secret = pick(r'RELAIS|SAIGIC', r'SECRET') or pick(r'SECRET')
    return {'identifiant': ident, 'popup': popup, 'formulaire': form, 'secret': secret}

# ---------- client HTTP ----------
class Client:
    def __init__(self, ident, popup):
        self.cj = http.cookiejar.CookieJar()
        self.basic = 'Basic ' + base64.b64encode((ident + ':' + popup).encode()).decode()
        self.ctx = None
        self.opener = self._opener(None)
    def _opener(self, ctx):
        h = [urllib.request.HTTPCookieProcessor(self.cj)]
        if ctx: h.append(urllib.request.HTTPSHandler(context=ctx))
        return urllib.request.build_opener(*h)
    def req(self, path, data=None, referer=None, json_=False):
        url = BASE + path if path.startswith('/') else path
        body = None
        hdr = {'User-Agent': UA, 'Authorization': self.basic}
        if referer: hdr['Referer'] = referer
        if json_: hdr['Accept'] = 'application/json, text/javascript, */*'
        if data is not None:
            body = urllib.parse.urlencode(data).encode() if isinstance(data, dict) else data
            hdr['Content-Type'] = 'application/x-www-form-urlencoded'
        r = urllib.request.Request(url, data=body, headers=hdr)
        for essai in range(2):
            try:
                with self.opener.open(r, timeout=60) as rep:
                    return rep.status, rep.read().decode('utf-8', 'replace'), rep.geturl()
            except urllib.error.HTTPError as e:
                return e.code, e.read().decode('utf-8', 'replace'), url
            except (ssl.SSLError, urllib.error.URLError) as e:
                est_ssl = isinstance(e, ssl.SSLError) or isinstance(getattr(e, 'reason', None), ssl.SSLError) or 'CERTIFICATE_VERIFY_FAILED' in str(e)
                if est_ssl and essai == 0 and self.ctx is None:
                    log('⚠ certificat TLS du SAIGIC non vérifiable : nouvel essai sans vérification')
                    self.ctx = ssl._create_unverified_context(); self.opener = self._opener(self.ctx)
                    continue
                raise

class RefusMotDePasse(Exception): pass

def connexion(c, ident, mdp_form):
    st, page, _ = c.req('/SGAccount/LogOn')
    if st == 401: raise RefusMotDePasse('porte 1 (popup) refusée : 401')
    if st != 200: raise RuntimeError('page de connexion : HTTP %s' % st)
    m = re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', page) or re.search(r'value="([^"]+)"[^>]*name="__RequestVerificationToken"', page)
    if not m: raise RuntimeError('jeton __RequestVerificationToken introuvable')
    st, page, url = c.req('/SGAccount/LogOn', {'__RequestVerificationToken': m.group(1), 'UserName': ident, 'Password': mdp_form, 'RememberMe': 'false'}, referer=BASE + '/SGAccount/LogOn')
    if st == 401: raise RefusMotDePasse('porte 1 refusée au POST')
    noms = {ck.name for ck in c.cj}
    if '.ASPXAUTH' not in noms:
        if re.search(r'LogOn', url or '') or 'UserName' in page: raise RefusMotDePasse('porte 2 (formulaire) refusée : pas de cookie .ASPXAUTH')
        raise RuntimeError('connexion incertaine : pas de cookie .ASPXAUTH (HTTP %s)' % st)

# ---------- référentiels (produit, type de mouvement) ----------
def id_libelle(obj):
    """Retourne (id, libellé) d'un objet JSON de combo, quels que soient les noms de champs."""
    if not isinstance(obj, dict): return None, str(obj)
    idv = None; lib = ''
    for k, v in obj.items():
        K = k.lower()
        if idv is None and (K.endswith('_id') or K == 'id' or K.endswith('id')) and v not in (None, ''): idv = v
        if isinstance(v, str) and len(v) > len(lib): lib = v
    return idv, lib

def choisir(c, path, params, motif):
    q = ('?' + urllib.parse.urlencode(params)) if params else ''
    st, txt, _ = c.req(path + q, json_=True)
    if st != 200: raise RuntimeError('%s : HTTP %s' % (path, st))
    data = json.loads(txt)
    if isinstance(data, dict):
        for k in ('aaData', 'data', 'Data', 'items'):
            if k in data: data = data[k]; break
    for o in data:
        i, l = id_libelle(o)
        if re.search(motif, l.upper()): return i, l
    raise RuntimeError('%s : aucun libellé ne correspond à %s (reçu : %s)' % (path, motif, [id_libelle(o)[1] for o in data][:10]))

# ---------- liste des pesées ----------
def date_debut_campagne(auj):
    return date(auj.year if auj.month >= 9 else auj.year - 1, 9, 1)

def lire_liste(c, prdt, mvt):
    auj = date.today()
    base = {'CodePesee': '', 'Prdt_Id': prdt, 'TypeMvt_Id': mvt, 'Exp_Id': '009', 'Fournisseur_Id': '',
            'DateDebut': date_debut_campagne(auj).strftime('%d/%m/%Y'), 'DateFin': auj.strftime('%d/%m/%Y'),
            'Acceptation': '', 'Conformite': '', 'IDControleur': '', 'NumeroAnalyse': '', 'CodePont': '', 'Dept_Id': '',
            'Approuve': 'Toutes', 'Declare': '', 'Traite': '', 'iSortCol_0': '1', 'sSortDir_0': 'asc', 'iColumns': '12'}
    lignes = []; start = 0; taille = 100; echo = 1
    while True:
        p = dict(base); p.update({'sEcho': str(echo), 'iDisplayStart': str(start), 'iDisplayLength': str(taille)})
        st, txt, _ = c.req('/pesee/AjaxHandlerIndex?' + urllib.parse.urlencode(p), referer=BASE + '/Pesee/ValidationExportateur', json_=True)
        if st != 200: raise RuntimeError('liste des pesées : HTTP %s' % st)
        js = json.loads(txt)
        rows = js.get('aaData') or js.get('data') or []
        lignes.extend(rows)
        total = int(js.get('iTotalDisplayRecords') or js.get('recordsFiltered') or len(lignes))
        start += taille; echo += 1
        if not rows or start >= total or echo > 50: break
    return lignes

# ---------- détail d'une pesée ----------
CHAMPS = [  # (motif du libellé, clé ORIGEN)
    (r'^CNSMENT|CONNAISSEMENT', 'connaissement'), (r'^CODEFOURN', 'code_fourn'), (r'^FOURNISSEUR$', 'fournisseur'),
    (r'^N.?\s*TICKET', 'ticket'), (r'^DATE\s*P2', 'date_p2'), (r'^NSDECHARG', 'sacs_decharges'), (r'^NSACCEPT', 'sacs_acceptes'),
    (r'^NSDECLAR', 'sacs_declares'), (r'^PDSBRUT', 'poids_brut'), (r'^POIDS\s*NET$', 'poids_net'), (r'^PDSREFAC', 'poids_refac'),
    (r'^PDSNETACC', 'poids_net_acc'), (r'^TRANSPORTEUR', 'transporteur'), (r'^IMMATRICULATION', 'immatriculation'),
    (r'^MAGASIN', 'magasin'), (r'^LOCALIT', 'localite'), (r'^DEPARTEMENT', 'departement'), (r'^NATURE', 'nature'), (r'^CODE\s*PESEE', 'code_pesee_detail'),
]
def norm(s): return re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', s))).strip()
def lire_detail(c, pesee_id):
    st, page, _ = c.req('/Pesee/DetailPeseeCCQ/' + str(pesee_id), data=b'', referer=BASE + '/Pesee/ValidationExportateur')
    if st != 200: raise RuntimeError('détail %s : HTTP %s' % (pesee_id, st))
    # découpe la page aux <label> ; pour chaque label, on prend le premier input/select/textarea qui suit
    out = {}; libelles = []
    morceaux = re.split(r'(<label\b[^>]*>.*?</label>)', page, flags=re.S | re.I)
    for i in range(1, len(morceaux) - 1, 2):
        lib = norm(morceaux[i]); suite = morceaux[i + 1]
        if not lib: continue
        val = None
        m = re.search(r'<(input|select|textarea)\b[^>]*>', suite, re.I)
        if m:
            tag = m.group(1).lower(); ouv = m.group(0)
            if tag == 'input':
                v = re.search(r'\bvalue="([^"]*)"', ouv); val = html.unescape(v.group(1)) if v else ''
            elif tag == 'select':
                bloc = suite[m.start():]; fin = bloc.find('</select>'); bloc = bloc[:fin if fin > 0 else None]
                s = re.search(r'<option\b[^>]*\bselected\b[^>]*>(.*?)</option>', bloc, re.S | re.I)
                val = norm(s.group(1)) if s else ''
            else:
                bloc = suite[m.end():]; fin = bloc.find('</textarea>'); val = norm(bloc[:fin if fin > 0 else None])
        libelles.append(lib)
        L = lib.upper()
        for motif, cle in CHAMPS:
            if re.search(motif, L) and cle not in out: out[cle] = (val or '').strip()
    out['_libelles'] = libelles
    return out

def nombre(v):
    if v is None: return None
    s = str(v).strip().replace(' ', '').replace(' ', '')
    if s == '': return None
    if ',' in s and '.' in s: s = s.replace('.', '')
    s = s.replace(',', '.')
    try: return float(s)
    except ValueError: return None

# ---------- ORIGEN ----------
def poster(url, secret, corps):
    r = urllib.request.Request(url, data=json.dumps(corps).encode(), headers={'Content-Type': 'application/json', 'x-relais-secret': secret, 'User-Agent': 'saigic-pesees/1'})
    try:
        with urllib.request.urlopen(r, timeout=120) as rep: return rep.status, json.loads(rep.read().decode() or '{}')
    except urllib.error.HTTPError as e:
        return e.code, {'error': e.read().decode('utf-8', 'replace')[:300]}

def alerter(secret, texte):
    try: poster(ALERTE_URL, secret, {'alerte': '[Robot pesées] ' + texte})
    except Exception as e: log('alerte non envoyée : %s' % e)

def charger_etat():
    try:
        with open(ETAT) as f: return json.load(f)
    except Exception: return {}
def sauver_etat(e):
    tmp = ETAT + '.tmp'
    with open(tmp, 'w') as f: json.dump(e, f)
    os.replace(tmp, ETAT)

def main():
    env = trouver_env()
    if '--verifier' in sys.argv:
        for k, v in env.items(): print('%-12s : %s' % (k, v or 'INTROUVABLE'))
        print('SAIGIC_BASE  :', BASE); print('RELAIS       :', RELAIS_URL)
        return 0 if all(env.values()) else 2
    manquants = [k for k, v in env.items() if not v]
    if manquants: log('variables introuvables : %s (lance --verifier)' % ', '.join(manquants)); return 2
    if os.path.exists(STOP): log('arrêté (fichier %s présent : refus de mot de passe antérieur). Supprime-le après vérification.' % STOP); return 3
    ident, popup, form, secret = (os.environ[env[k]] for k in ('identifiant', 'popup', 'formulaire', 'secret'))

    log('robot pesées v' + VERSION)
    c = Client(ident, popup)
    try:
        connexion(c, ident, form)
        prdt, lib_p = choisir(c, '/Produit/getProduitJson', None, r'^CACAO')
        mvt, lib_m = choisir(c, '/TypeMouvement/GetTypeMouvementJson', {'Option': 'MouvementPeseeAll'}, r'ACHAT.*TOUT.?VENANT')
        log('référentiels : produit %s (%s), mouvement %s (%s)' % (prdt, lib_p, mvt, lib_m))
        liste = lire_liste(c, prdt, mvt)
    except RefusMotDePasse as e:
        log('⛔ ' + str(e) + ' — arrêt immédiat pour protéger le compte partagé')
        open(STOP, 'w').write(str(e)); alerter(secret, 'Mot de passe refusé par le SAIGIC (%s). Le robot des pesées est arrêté.' % e); return 4
    except Exception as e:
        n = 0
        try: n = int(open(FAILS).read() or 0)
        except Exception: pass
        n += 1; open(FAILS, 'w').write(str(n))
        log('échec : %s (consécutifs : %d)' % (e, n))
        if n in (3, 12, 48): alerter(secret, '%d échecs consécutifs du robot des pesées. Dernier : %s' % (n, e))
        return 1
    if os.path.exists(FAILS): os.remove(FAILS)
    log('%d pesée(s) listée(s) depuis le %s' % (len(liste), date_debut_campagne(date.today()).strftime('%d/%m/%Y')))

    etat = charger_etat(); envoi = []; nb_detail = 0
    for row in liste:
        code = str(row.get('CodePesee') or '').strip(); pid = row.get('Pesee_Id')
        if not code or pid in (None, ''): continue
        empreinte = json.dumps([row.get('NbSacsAcceptes'), row.get('PoidsNetAccepte'), row.get('ValidationExp'), row.get('Declaration_Id'), row.get('DatePesee')], sort_keys=True, default=str)
        if etat.get(code, {}).get('h') == empreinte and etat[code].get('ok'): continue
        try:
            d = lire_detail(c, pid); nb_detail += 1
        except Exception as e:
            log('détail %s : %s' % (code, e)); continue
        if UNE and nb_detail == 1:
            log('libellés lus dans le détail : ' + ' | '.join(d.get('_libelles', [])))
            log('champs retenus : ' + json.dumps({k: v for k, v in d.items() if k != '_libelles'}, ensure_ascii=False))
        p = {'code_pesee': code, 'pesee_id': pid, 'connaissement': d.get('connaissement', ''), 'code_fourn': d.get('code_fourn', ''),
             'fournisseur': d.get('fournisseur') or row.get('NomFournisseur') or '', 'date_p2': d.get('date_p2') or row.get('DatePesee') or '',
             'sacs_decharges': nombre(d.get('sacs_decharges')), 'sacs_acceptes': nombre(d.get('sacs_acceptes')) if d.get('sacs_acceptes') not in (None, '') else nombre(row.get('NbSacsAcceptes')),
             'poids_brut': nombre(d.get('poids_brut')), 'poids_net': nombre(d.get('poids_net')), 'poids_refac': nombre(d.get('poids_refac')),
             'poids_net_acc': nombre(d.get('poids_net_acc')) if d.get('poids_net_acc') not in (None, '') else nombre(row.get('PoidsNetAccepte')),
             'localite': d.get('localite', ''), 'departement': d.get('departement', ''), 'nature': d.get('nature', ''),
             'transporteur': d.get('transporteur', ''), 'immatriculation': d.get('immatriculation', ''), 'magasin': d.get('magasin', ''),
             'statut_saigic': row.get('ValidationExp') or '', 'declare_saigic': bool(row.get('Declaration_Id'))}
        if not p['connaissement']: log('⚠ %s : pas de n° de connaissement dans le détail (libellés : %s)' % (code, ' | '.join(d.get('_libelles', [])[:30])))
        envoi.append((code, empreinte, p))
        if UNE: break
        time.sleep(0.4)

    if not envoi: log('rien de nouveau.'); return 0
    log('%d pesée(s) nouvelle(s) ou modifiée(s) à envoyer%s' % (len(envoi), ' (ESSAI À BLANC)' if DRY else ''))
    st, rep = poster(RELAIS_URL, secret, {'pesees': [p for _, _, p in envoi], 'dry_run': DRY})
    if st != 200 or not rep.get('ok'):
        log('ORIGEN a refusé (HTTP %s) : %s' % (st, rep)); return 1
    resume = {k: rep.get(k) for k in ('lues', 'creees', 'mises_a_jour', 'inchangees', 'verrouillees', 'sans_connaissement', 'rattachees', 'coop_inconnue', 'erreurs')}
    log('ORIGEN : ' + json.dumps(resume, ensure_ascii=False))
    if DRY:
        for pl in rep.get('plan', [])[:20]: log('  plan : ' + json.dumps(pl, ensure_ascii=False))
        return 0
    for code, h, p in envoi:
        if not any(str(e).startswith(p['connaissement'] or '§') for e in rep.get('erreurs', [])):
            etat[code] = {'h': h, 'ok': True, 'le': datetime.now().isoformat(timespec='seconds')}
    sauver_etat(etat)
    return 0

if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        log('erreur inattendue : %r' % e); sys.exit(1)
