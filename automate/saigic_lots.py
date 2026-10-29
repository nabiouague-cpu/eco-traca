#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Robot LOTS EXPORT SAIGIC -> ORIGEN (LECTURE SEULE). Troisième robot du VPS, même connexion que saigic_pesees.py.

ÉTAPE 1 (cette version) : explorer le formulaire « Situation des lots fabriqués (Fèves) » (/Rapport/EtatLotFeves)
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
    if not any(o in sys.argv for o in ('--formulaire', '--apercu', '--outils', '--listes')):
        print(__doc__); return 0
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
    r0 = L['Récoltes (ddlRecolte)'][0][0] if L['Récoltes (ddlRecolte)'] else ''
    L['Traites (ddlTraite)'] = [(o.get('LibelleTraite'), o.get('Intitule')) for o in lire_json(c, '/Recolte/GetTraite', {'Option': 'ListeTraite', 'Camp_Id': CAMP_ID, 'Recolte': r0, 'Exp_Id': '', 'Prdt_Id': PRDT_CACAO})]
    L['Exportateurs (ddlExportateur)'] = [(o.get('Exp_Id'), o.get('NomCourt')) for o in lire_json(c, '/Exportateur/GetExportateurJson', {'Exp_Id': EXP_ECORIGINE, 'type': 1})]
    L['Listes des états (ddlListeEtat)'] = [(o.get('IDWithCodeEtat'), o.get('LibelleEtat')) for o in lire_json(c, '/ListeEtat/GetListeEtatJson', {'vppPrdt': PRDT_CACAO, 'vppGroupe': 'LOT'})]
    return L

def option(argv, nom, defaut=None):
    return argv[argv.index(nom) + 1] if nom in argv and argv.index(nom) + 1 < len(argv) else defaut

def apercu(c, L):
    """Reproduit le clic sur « Aperçu » : POST /Rapport/ShowEtatLotFeves puis lecture de /Rapport/AfficherEtat. Lecture seule."""
    from datetime import date
    auj = date.today()
    etats = L['Listes des états (ddlListeEtat)']
    etat = option(sys.argv, '--etat') or next((v for v, lib in etats if re.search(r'fabriqu', str(lib), re.I)), (etats[0][0] if etats else ''))
    recolte = option(sys.argv, '--recolte') or (L['Récoltes (ddlRecolte)'][0][0] if L['Récoltes (ddlRecolte)'] else '')
    traite = option(sys.argv, '--traite') or (L['Traites (ddlTraite)'][0][0] if L['Traites (ddlTraite)'] else '')
    fmt = (option(sys.argv, '--format', 'XLS') or 'XLS').upper()
    fmt = 'XLS' if fmt.startswith('EX') else fmt
    du = option(sys.argv, '--du', P.date_debut_campagne(auj).strftime('%d/%m/%Y')); au = option(sys.argv, '--au', auj.strftime('%d/%m/%Y'))
    data = {'Prdt_Id': PRDT_CACAO, 'ddlListeEtat': etat, 'ddlRecolte': recolte, 'ddlTraite': traite, 'txtParite': '', 'ddlExportateur': EXP_ECORIGINE,
            'DateDebut': du, 'DateFin': au, 'ddlSite': option(sys.argv, '--site', ''), 'ddlMagasin': option(sys.argv, '--magasin', ''), 'txtNumeroLot': option(sys.argv, '--lot', ''),
            'ddlFormule': '-1', 'ddlD6': '-1', 'ddlVueEmb': '-1', 'ddlExportType': fmt}
    P.log('Aperçu : ' + json.dumps(data, ensure_ascii=False))

    def appel(chemin, corps=None, referer=PAGE):
        hdr = {'User-Agent': P.UA, 'Authorization': c.basic, 'Referer': P.BASE + referer}
        if corps is not None: hdr['Content-Type'] = 'application/x-www-form-urlencoded'
        r = urllib.request.Request(P.BASE + chemin, data=corps, headers=hdr)
        try:
            with c.opener.open(r, timeout=180) as rep: return rep.status, rep.read(), rep.headers, rep.geturl()
        except urllib.error.HTTPError as e: return e.code, e.read(), e.headers, chemin

    st, brut, h, u = appel('/Rapport/ShowEtatLotFeves?Length=7', urllib.parse.urlencode(data).encode())
    P.log('POST ShowEtatLotFeves : HTTP %s, %s, %d octets' % (st, h.get('Content-Type', '?'), len(brut)))
    print(brut[:600].decode('utf-8', 'replace'))
    st, brut, h, u = appel('/Rapport/AfficherEtat')
    ctype = h.get('Content-Type', '?'); cd = h.get('Content-Disposition', '')
    P.log('GET AfficherEtat : HTTP %s, %s, %d octets, %s' % (st, ctype, len(brut), cd))
    ext = 'pdf' if brut[:4] == b'%PDF' else ('xlsx' if brut[:2] == b'PK' else ('xls' if brut[:4] == b'\xd0\xcf\x11\xe0' else 'html'))
    chemin = '%s.%s' % (SORTIE_APERCU, ext); open(chemin, 'wb').write(brut)
    P.log('fichier reçu enregistré : %s' % chemin)
    if ext == 'pdf':
        try:
            txt = subprocess.run(['pdftotext', '-layout', chemin, '-'], capture_output=True, text=True, timeout=60).stdout
            open(SORTIE_APERCU + '.txt', 'w').write(txt); print(txt[:4000])
        except Exception as e: P.log('pdftotext indisponible (%s) : apt-get install -y poppler-utils' % e)
    elif ext == 'xlsx':
        try:
            import openpyxl
            ws = openpyxl.load_workbook(chemin, data_only=True).active
            for row in ws.iter_rows(values_only=True):
                if any(v not in (None, '') for v in row): print(' | '.join('' if v is None else str(v) for v in row))
        except Exception as e: P.log('lecture xlsx impossible (%s) : pip install openpyxl' % e)
    else:
        t = brut.decode('utf-8', 'replace')
        if '<table' in t.lower():
            for tr in re.findall(r'<tr\b.*?</tr>', t, re.S | re.I)[:40]:
                print(' | '.join(re.sub(r'\s+', ' ', html.unescape(re.sub(r'<[^>]+>', '', td))).strip() for td in re.findall(r'<t[dh]\b.*?</t[dh]>', tr, re.S | re.I)))
        else: print(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', t))[:2000])
    return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        P.log('erreur : %r' % e); sys.exit(1)
