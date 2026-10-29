#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Robot LOTS EXPORT SAIGIC -> ORIGEN (LECTURE SEULE). Troisième robot du VPS, même connexion que saigic_pesees.py.

Un passage (sans option, ou --dry-run) : lit l'état des lots fabriqués (toutes les traites de la récolte en cours), l'envoie à ORIGEN (fonction reception-lots-saigic),
sans rien écrire nulle part, pour que le robot sache exactement quoi envoyer.

Options :
  --formulaire   se connecte, lit la page du rapport et affiche tous les champs (nom, type, valeur par défaut)
                 et toutes les listes déroulantes (Site = sites d'usinage UA/US, Magasin = magasins de stockage,
                 Liste des Etats, format PDF/Excel...). Enregistre la page dans /root/saigic_lots_form.html.
  --listes       affiche le contenu réel des listes : sites, magasins, récoltes, traites, exportateurs, états.
  --outils       lit le script de la page (/Scripts/public/saigic.tools.core.js) et affiche comment les listes
                 Site, Magasin, Récolte, Traite, Exportateur, Liste des États sont remplies (adresses des appels).
  --apercu       reproduit le bouton « Aperçu » (campagne en cours, traite principale, exportateur 009, du 1er sept. à aujourd'hui),
                 lit le rapport reçu (/Rapport/AfficherEtat), l'enregistre dans /root/saigic_lots_apercu.* et en affiche le contenu.
                 Options : --format XLS|PDF (défaut XLS)  --etat <valeur>  --recolte  --traite  --du jj/mm/aaaa  --au jj/mm/aaaa  --site UA55  --magasin <code>  --lot 3700
Il ne clique JAMAIS sur Valider / Créer : un rapport est une simple lecture.
"""
import html, json, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request
from html.parser import HTMLParser

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import saigic_pesees as P   # connexion, client HTTP, variables d'environnement

PAGE = '/Rapport/EtatLotFeves'
SORTIE_FORM = os.environ.get('LOTS_FORM_OUT', '/root/saigic_lots_form.html')
SORTIE_APERCU = os.environ.get('LOTS_APERCU_OUT', '/root/saigic_lots_apercu')


class Formulaires(HTMLParser):
    """Relève les <form> avec leurs champs : input, select(+options), textarea, et les libellés <label>."""
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.forms = []; self.f = None; self.sel = None; self.opt = None; self.lab = None; self.dernier_label = ''
    def handle_starttag(self, tag, a):
        a = {k: (v if v is not None else '') for k, v in a}
        if tag == 'form':
            self.f = {'action': a.get('action', ''), 'method': (a.get('method') or 'GET').upper(), 'champs': []}
            self.forms.append(self.f)
        elif self.f is None:
            return
        elif tag == 'label':
            self.lab = ''
        elif tag == 'input':
            self.f['champs'].append({'tag': 'input', 'type': (a.get('type') or 'text').lower(), 'name': a.get('name', ''), 'id': a.get('id', ''),
                                     'value': a.get('value', ''), 'checked': 'checked' in a, 'label': self.dernier_label})
        elif tag == 'select':
            self.sel = {'tag': 'select', 'name': a.get('name', ''), 'id': a.get('id', ''), 'options': [], 'label': self.dernier_label}
            self.f['champs'].append(self.sel)
        elif tag == 'option' and self.sel is not None:
            self.opt = {'value': a.get('value', ''), 'label': '', 'selected': 'selected' in a}
            self.sel['options'].append(self.opt)
        elif tag == 'textarea':
            self.f['champs'].append({'tag': 'textarea', 'name': a.get('name', ''), 'id': a.get('id', ''), 'value': '', 'label': self.dernier_label})
    def handle_endtag(self, tag):
        if tag == 'label' and self.lab is not None:
            self.dernier_label = re.sub(r'\s+', ' ', self.lab).strip(); self.lab = None
        elif tag == 'option': self.opt = None
        elif tag == 'select': self.sel = None
        elif tag == 'form': self.f = None
    def handle_data(self, d):
        if self.lab is not None: self.lab += d
        if self.opt is not None: self.opt['label'] += d


def lire_formulaires(page):
    p = Formulaires(); p.feed(page)
    for f in p.forms:
        for c in f['champs']:
            for o in c.get('options', []): o['label'] = re.sub(r'\s+', ' ', o['label']).strip()
    return p.forms


def ouvrir_session():
    env = P.trouver_env()
    manquants = [k for k, v in env.items() if not v]
    if manquants: P.log('variables introuvables : %s' % ', '.join(manquants)); sys.exit(2)
    if os.path.exists(P.STOP): P.log('arrêté : fichier %s présent' % P.STOP); sys.exit(3)
    ident, popup, form = (os.environ[env[k]] for k in ('identifiant', 'popup', 'formulaire'))
    c = P.Client(ident, popup)
    try:
        P.connexion(c, ident, form)
    except P.RefusMotDePasse as e:
        P.log('⛔ %s — arrêt immédiat pour protéger le compte partagé' % e); open(P.STOP, 'w').write(str(e)); sys.exit(4)
    return c


def afficher_formulaire(forms):
    for i, f in enumerate(forms):
        print('\n=== FORMULAIRE %d : %s %s ===' % (i, f['method'], f['action']))
        for c in f['champs']:
            if c['tag'] == 'select':
                opts = c['options']; sel = [o for o in opts if o['selected']]
                print('\n[liste] name=%s id=%s libellé=« %s » — %d choix, sélectionné : %s' % (c['name'], c['id'], c['label'], len(opts), ', '.join('%s=%s' % (o['value'], o['label']) for o in sel) or '(aucun)'))
                if len(opts) <= 80:
                    for o in opts: print('     %s = %s' % (o['value'], o['label']))
                else:
                    for o in opts[:25]: print('     %s = %s' % (o['value'], o['label']))
                    print('     … (%d autres) …' % (len(opts) - 25))
                    for o in opts[-10:]: print('     %s = %s' % (o['value'], o['label']))
            else:
                if c.get('type') == 'hidden' and c['name'].startswith('__'): print('[caché] %s = (jeton)' % c['name']); continue
                print('[%s] name=%s id=%s libellé=« %s » valeur=« %s »%s' % (c.get('type', c['tag']), c['name'], c['id'], c['label'], c.get('value', ''), ' (coché)' if c.get('checked') else ''))


def valeurs_par_defaut(f, format_voulu):
    data = []
    for c in f['champs']:
        n = c['name']
        if not n: continue
        if c['tag'] == 'select':
            sel = [o for o in c['options'] if o['selected']] or c['options'][:1]
            v = sel[0]['value'] if sel else ''
            if format_voulu and re.search(r'format|type.?sortie|export', (n + ' ' + c['id']).lower()):
                for o in c['options']:
                    if o['label'].lower().startswith(format_voulu.lower()): v = o['value']
            data.append((n, v))
        elif c['tag'] == 'input':
            t = c.get('type')
            if t in ('submit', 'button', 'image', 'file', 'reset'): continue
            if t in ('checkbox', 'radio'):
                if c.get('checked'): data.append((n, c['value'] or 'true'))
            else: data.append((n, c['value']))
        else: data.append((n, c.get('value', '')))
    return data


def main():
    if '--lire' in sys.argv:
        lire_xls(option(sys.argv, '--lire', SORTIE_APERCU + '.xls')); return 0
    if '--aide' in sys.argv or '-h' in sys.argv:
        print(__doc__); return 0
    if not any(o in sys.argv for o in ('--formulaire', '--apercu', '--outils', '--listes')):
        return passage()
    c = ouvrir_session()
    if '--outils' in sys.argv:
        st, js, _ = c.req('/Scripts/public/saigic.tools.core.js')
        P.log('saigic.tools.core.js : HTTP %s, %d caractères' % (st, len(js)))
        open('/root/saigic_tools_core.js', 'w', encoding='utf-8').write(js)
        for nom in ('fpbChargerComboSites', 'fpbChargerComboMagasins', 'fpbChargerComboRecoltes', 'fpbChargerComboTraites',
                    'fpbChargerComboExportateurs', 'fpbChargerComboListeDesEtats', 'fpbChargerComboOuiNon'):
            m = re.search(r'(%s\s*[:=]\s*function|function\s+%s)' % (nom, nom), js)
            print('\n=== %s ===' % nom)
            print(js[m.start():m.start() + 1400] if m else '(définition introuvable)')
        return 0
    if '--listes' in sys.argv or '--apercu' in sys.argv:
        L = lire_listes(c)
        if '--listes' in sys.argv:
            for nom, lst in L.items():
                print('\n=== %s (%d) ===' % (nom, len(lst)))
                for v, lib in lst: print('   %s = %s' % (v, lib))
            return 0
        return apercu(c, L)
    st, page, url = c.req(PAGE)
    P.log('page %s : HTTP %s, %d caractères' % (PAGE, st, len(page)))
    if st != 200: return 1
    open(SORTIE_FORM, 'w', encoding='utf-8').write(page)
    forms = [f for f in lire_formulaires(page) if f['champs']]
    if not forms: P.log('aucun formulaire trouvé dans la page'); return 1
    afficher_formulaire(forms)
    print('\nPage enregistrée : %s' % SORTIE_FORM)
    return 0


# ---------- listes déroulantes (appels relevés dans /Scripts/public/saigic.tools.core.js) ----------
CAMP_ID = '26'      # campagne 2026-2027 (valeur codée en dur dans la page du SAIGIC)
PRDT_CACAO = '2'
EXP_ECORIGINE = '009'

def lire_json(c, chemin, params=None):
    q = ('?' + urllib.parse.urlencode(params)) if params else ''
    st, txt, _ = c.req(chemin + q, json_=True)
    if st != 200: raise RuntimeError('%s : HTTP %s' % (chemin, st))
    d = json.loads(txt)
    if isinstance(d, dict):
        for k in ('aaData', 'data', 'Data', 'items'):
            if k in d: d = d[k]; break
    return d

def lire_listes(c):
    L = {}
    L['Sites (ddlSite)'] = [(o.get('IDSite'), '%s - %s' % (o.get('IDSite'), o.get('NomCourt'))) for o in lire_json(c, '/Site/GetSiteJson')]
    L['Magasins (ddlMagasin)'] = [(o.get('CodeMagasin'), o.get('NomMagasin')) for o in lire_json(c, '/Magasin/getMagasinJson')]
    rec = lire_json(c, '/Recolte/GetRecolte', {'Option': 'ListeRecolteCamp', 'Camp_Id': CAMP_ID, 'Recolte': '', 'Exp_Id': '', 'Prdt_Id': 0})
    L['Récoltes (ddlRecolte)'] = [(o.get('RCLT_LIB'), o.get('RCLT_LIB')) for o in rec]
    r0 = option(sys.argv, '--recolte') or (L['Récoltes (ddlRecolte)'][-1][0] if L['Récoltes (ddlRecolte)'] else '')
    L['Traites (ddlTraite)'] = [(o.get('LibelleTraite'), o.get('Intitule')) for o in lire_json(c, '/Recolte/GetTraite', {'Option': 'ListeTraite', 'Camp_Id': CAMP_ID, 'Recolte': r0, 'Exp_Id': '', 'Prdt_Id': PRDT_CACAO})]
    L['Exportateurs (ddlExportateur)'] = [(o.get('Exp_Id'), o.get('NomCourt')) for o in lire_json(c, '/Exportateur/GetExportateurJson', {'Exp_Id': EXP_ECORIGINE, 'type': 1})]
    L['Listes des états (ddlListeEtat)'] = [(o.get('IDWithCodeEtat'), o.get('LibelleEtat')) for o in lire_json(c, '/ListeEtat/GetListeEtatJson', {'vppPrdt': PRDT_CACAO, 'vppGroupe': 'LOT'})]
    return L

def option(argv, nom, defaut=None):
    return argv[argv.index(nom) + 1] if nom in argv and argv.index(nom) + 1 < len(argv) else defaut

def lire_xls(chemin):
    try:
        import xlrd
    except ImportError:
        P.log('lecture .xls impossible : lancer  pip install --break-system-packages xlrd  puis  python3 saigic_lots.py --lire ' + chemin); return
    wb = xlrd.open_workbook(chemin)
    for sh in wb.sheets():
        print('--- feuille « %s » : %d lignes x %d colonnes ---' % (sh.name, sh.nrows, sh.ncols))
        for r in range(sh.nrows):
            vals = [str(v).strip() for v in sh.row_values(r)]
            if any(vals): print(' | '.join(vals))


def donnees_formulaire(L, **f):
    """Champs envoyés par le bouton « Aperçu » (valeurs relevées dans la page du SAIGIC)."""
    from datetime import date
    auj = date.today()
    etats = L['Listes des états (ddlListeEtat)']
    etat = f.get('etat') or next((v for v, lib in etats if re.search(r'fabriqu', str(lib), re.I)), (etats[0][0] if etats else ''))
    recolte = f.get('recolte') or (L['Récoltes (ddlRecolte)'][-1][0] if L['Récoltes (ddlRecolte)'] else '')
    traite = f.get('traite') if f.get('traite') is not None else (L['Traites (ddlTraite)'][0][0] if L['Traites (ddlTraite)'] else '')
    return {'Prdt_Id': PRDT_CACAO, 'ddlListeEtat': etat, 'ddlRecolte': recolte, 'ddlTraite': traite, 'txtParite': '', 'ddlExportateur': EXP_ECORIGINE,
            'DateDebut': f.get('du', ''), 'DateFin': f.get('au', ''), 'ddlSite': f.get('site', ''), 'ddlMagasin': f.get('magasin', ''), 'txtNumeroLot': f.get('lot', ''),
            'ddlFormule': f.get('fo1', ''), 'ddlD6': '-1', 'ddlVueEmb': '-1', 'ddlExportType': f.get('format', 'XLS')}


def telecharger(c, data):
    """Reproduit le clic sur « Aperçu » : POST /Rapport/ShowEtatLotFeves puis lecture de /Rapport/AfficherEtat. Lecture seule."""
    def appel(chemin, corps=None):
        hdr = {'User-Agent': P.UA, 'Authorization': c.basic, 'Referer': P.BASE + PAGE}
        if corps is not None: hdr['Content-Type'] = 'application/x-www-form-urlencoded'
        r = urllib.request.Request(P.BASE + chemin, data=corps, headers=hdr)
        try:
            with c.opener.open(r, timeout=180) as rep: return rep.status, rep.read(), rep.headers
        except urllib.error.HTTPError as e: return e.code, e.read(), e.headers
    st, brut, h = appel('/Rapport/ShowEtatLotFeves?Length=7', urllib.parse.urlencode(data).encode())
    if st != 200: raise RuntimeError('ShowEtatLotFeves : HTTP %s' % st)
    st, brut, h = appel('/Rapport/AfficherEtat')
    if st != 200: raise RuntimeError('AfficherEtat : HTTP %s' % st)
    ext = 'pdf' if brut[:4] == b'%PDF' else ('xlsx' if brut[:2] == b'PK' else ('xls' if brut[:4] == b'\xd0\xcf\x11\xe0' else 'html'))
    return ext, brut


def norme(x): return re.sub(r'[^a-z0-9]', '', html.unescape(str(x)).lower().replace('é', 'e').replace('è', 'e'))

def lots_du_xls(chemin):
    """Relit l'état des lots fabriqués (.xls) : une ligne par lot, colonnes repérées par leur titre."""
    import xlrd
    wb = xlrd.open_workbook(chemin); sh = wb.sheet_by_index(0)
    cles = {'datefab': 'date_fab', 'code': 'code_exp', 'exportateur': 'exportateur', 'numerolot': 'numero', 'grade': 'grade', 'marque': 'marque', 'recolte': 'recolte',
            'numerobv': 'numero_bv', 'nfo1provisoire': 'fo1_provisoire', 'nfo1': 'fo1', 'poidsthq': 'poids_theorique', 'poidsreel': 'poids_reel', 'd6': 'd6', 'vuemb': 'vu_emb'}
    entete = None; col = {}
    lots = []
    for r in range(sh.nrows):
        vals = sh.row_values(r)
        if entete is None:
            m = {norme(v): i for i, v in enumerate(vals) if str(v).strip()}
            if 'numerolot' in m and 'datefab' in m:
                entete = r; col = {cles[k]: i for k, i in m.items() if k in cles}
            continue
        brut = {k: (vals[i] if i < len(vals) else '') for k, i in col.items()}
        numero = str(brut.get('numero', '')).strip()
        if numero.endswith('.0'): numero = numero[:-2]
        if not numero.isdigit(): continue
        d = brut.get('date_fab')
        if isinstance(d, float) and d > 30000:
            d = xlrd.xldate_as_datetime(d, wb.datemode).strftime('%Y-%m-%dT%H:%M:%S')
        lot = {'numero': numero, 'date_fab': str(d or '')}
        for k in ('code_exp', 'exportateur', 'grade', 'marque', 'recolte', 'numero_bv', 'fo1_provisoire', 'fo1', 'd6', 'vu_emb'):
            v = brut.get(k, ''); lot[k] = (str(int(v)) if isinstance(v, float) and v == int(v) else str(v)).strip()
        for k in ('poids_theorique', 'poids_reel'):
            v = brut.get(k, ''); lot[k] = v if isinstance(v, float) else nombre_lot(v)
        lots.append(lot)
    return lots

def nombre_lot(v):
    return P.nombre(v)


def apercu(c, L):
    """Mode d'essai : reproduit « Aperçu » et affiche le contenu du rapport reçu."""
    from datetime import date
    f = {'etat': option(sys.argv, '--etat'), 'recolte': option(sys.argv, '--recolte'), 'traite': option(sys.argv, '--traite'), 'du': option(sys.argv, '--du', ''), 'au': option(sys.argv, '--au', ''),
         'site': option(sys.argv, '--site', ''), 'magasin': option(sys.argv, '--magasin', ''), 'lot': option(sys.argv, '--lot', ''), 'fo1': option(sys.argv, '--fo1', '')}
    fmt = (option(sys.argv, '--format', 'XLS') or 'XLS').upper(); f['format'] = 'XLS' if fmt.startswith('EX') else fmt
    data = donnees_formulaire(L, **{k: v for k, v in f.items() if v is not None})
    P.log('Aperçu : ' + json.dumps(data, ensure_ascii=False))
    ext, brut = telecharger(c, data)
    chemin = '%s.%s' % (SORTIE_APERCU, ext); open(chemin, 'wb').write(brut)
    P.log('fichier reçu (%d octets) enregistré : %s' % (len(brut), chemin))
    if ext == 'xls': lire_xls(chemin)
    elif ext == 'pdf':
        try:
            t = subprocess.run(['pdftotext', '-layout', chemin, '-'], capture_output=True, text=True, timeout=60).stdout
            open(SORTIE_APERCU + '.txt', 'w').write(t); print(t[:4000])
        except Exception as e: P.log('pdftotext indisponible (%s)' % e)
    else: print(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', brut.decode('utf-8', 'replace')))[:2000])
    return 0


# ---------- passage complet : SAIGIC -> ORIGEN ----------
ETAT = os.environ.get('LOTS_ETAT', '/root/.saigic_lots_etat.json')
FAILS = os.environ.get('LOTS_FAILS', '/root/.saigic_lots.fails')
LOTS_URL = os.environ.get('RELAIS_LOTS_URL', 'https://sfjvtwzrnzjvyhfqxswm.supabase.co/functions/v1/reception-lots-saigic')
DUREE_CACHE_SITE_H = 6   # un lot dont on n'a pas trouvé le site n'est re-cherché qu'après 6 h

def lire_etat():
    try: return json.load(open(ETAT))
    except Exception: return {}

def lots_du_rapport(c, L, **filtres):
    ext, brut = telecharger(c, donnees_formulaire(L, **filtres))
    if ext != 'xls': raise RuntimeError('format reçu inattendu : %s' % ext)
    tmp = '/tmp/saigic_lots_rapport.xls'; open(tmp, 'wb').write(brut)
    return lots_du_xls(tmp)

def passage():
    dry = '--dry-run' in sys.argv
    env = P.trouver_env()
    if not env.get('secret'): P.log('secret du relais introuvable (lancer saigic_pesees.py --verifier)'); return 2
    secret = os.environ[env['secret']]
    c = ouvrir_session()
    try:
        L = lire_listes(c)
        lots = []
        for traite in [v for v, _ in L['Traites (ddlTraite)']] or ['']:
            lots += lots_du_rapport(c, L, traite=traite)
        P.log('SAIGIC : %d lot(s) fabriqué(s) pour ECORIGINE (récolte en cours)' % len(lots))
        st, rep = P.poster(LOTS_URL, secret, {'lots': lots, 'complet': True, 'dry_run': dry})
        if st != 200 or not rep.get('ok'): raise RuntimeError('ORIGEN a refusé (HTTP %s) : %s' % (st, rep))
        etat = lire_etat(); cache = etat.get('site_inconnu', {}); maintenant = time.time()
        a_loc = [n for n in rep.get('a_localiser', []) if maintenant - cache.get(n, 0) > DUREE_CACHE_SITE_H * 3600]
        localisation = {}
        if a_loc:
            P.log('%d lot(s) sans site : recherche site par site (%d sites d\'ORIGEN)' % (len(a_loc), len(rep.get('sites_a_tester', []))))
            for site in rep.get('sites_a_tester', []):
                if not a_loc: break
                for traite in [v for v, _ in L['Traites (ddlTraite)']] or ['']:
                    for lot in lots_du_rapport(c, L, traite=traite, site=site):
                        if lot['numero'] in a_loc: localisation[lot['numero']] = site
                time.sleep(0.5)
            for n in a_loc:
                if n not in localisation: cache[n] = maintenant
            if localisation:
                st, rep = P.poster(LOTS_URL, secret, {'lots': lots, 'localisation': localisation, 'complet': True, 'dry_run': dry})
                if st != 200 or not rep.get('ok'): raise RuntimeError('ORIGEN a refusé (2e envoi, HTTP %s) : %s' % (st, rep))
        resume = {k: rep.get(k) for k in ('lues', 'creees', 'mises_a_jour', 'inchangees', 'a_classer', 'a_localiser', 'poids_corriges', 'ecarts_poids_signales', 'clients_completes', 'absents_du_saigic', 'erreurs')}
        P.log('ORIGEN%s : %s' % (' (essai à blanc)' if dry else '', json.dumps(resume, ensure_ascii=False)))
        if dry:
            for pl in rep.get('plan', [])[:30]: P.log('  plan : ' + json.dumps(pl, ensure_ascii=False))
        else:
            etat['site_inconnu'] = cache; json.dump(etat, open(ETAT, 'w'))
        if os.path.exists(FAILS): os.remove(FAILS)
        return 0
    except P.RefusMotDePasse as e:
        P.log('⛔ %s' % e); open(P.STOP, 'w').write(str(e)); return 4
    except Exception as e:
        n = 0
        try: n = int(open(FAILS).read() or 0)
        except Exception: pass
        n += 1; open(FAILS, 'w').write(str(n))
        P.log('échec : %s (consécutifs : %d)' % (e, n))
        if n in (3, 12, 48):
            try: P.alerter(secret, '[Robot lots] %d échecs consécutifs. Dernier : %s' % (n, e))
            except Exception: pass
        return 1


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        P.log('erreur : %r' % e); sys.exit(1)
