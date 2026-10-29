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
  --apercu       envoie le formulaire avec ses valeurs par défaut (campagne en cours, traite principale, exportateur 009)
                 comme le bouton « Aperçu », et décrit la réponse (type, taille) ; enregistre le fichier reçu
                 dans /root/saigic_lots_apercu.* (+ texte extrait si PDF et pdftotext présent).
                 Ajouter  --format Excel  (ou PDF, Word...) pour choisir le format de la liste à côté d'Aperçu.
Il ne clique JAMAIS sur Valider / Créer : un rapport est une simple lecture.
"""
import html, os, re, subprocess, sys, urllib.error, urllib.parse, urllib.request
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
    if '--formulaire' not in sys.argv and '--apercu' not in sys.argv:
        print(__doc__); return 0
    c = ouvrir_session()
    st, page, url = c.req(PAGE)
    P.log('page %s : HTTP %s, %d caractères' % (PAGE, st, len(page)))
    if st != 200: return 1
    open(SORTIE_FORM, 'w', encoding='utf-8').write(page)
    forms = lire_formulaires(page)
    # le formulaire du rapport = celui qui contient la liste « Site » / « Magasin » ou le plus grand
    forms = [f for f in forms if f['champs']]
    if not forms: P.log('aucun formulaire trouvé dans la page'); return 1
    if '--formulaire' in sys.argv:
        afficher_formulaire(forms)
        scripts = re.findall(r'<script[^>]*src="([^"]+)"', page, re.I)
        print('\nscripts de la page :', ' | '.join(scripts))
        print('\nPage enregistrée : %s (la déposer dans la conversation si besoin)' % SORTIE_FORM)
        return 0
    f = max(forms, key=lambda x: len(x['champs']))
    fmt = sys.argv[sys.argv.index('--format') + 1] if '--format' in sys.argv else 'PDF'
    data = valeurs_par_defaut(f, fmt)
    P.log('envoi du formulaire (%s %s) avec %d champs : %s' % (f['method'], f['action'], len(data), ', '.join('%s=%s' % (k, v) for k, v in data if not k.startswith('__'))))
    action = f['action'] or PAGE
    if f['method'] == 'GET':
        st, corps, u = c.req(action + ('&' if '?' in action else '?') + urllib.parse.urlencode(data), referer=P.BASE + PAGE)
        brut = corps.encode('utf-8', 'replace'); ctype = '?'
    else:
        import urllib.request
        body = urllib.parse.urlencode(data).encode()
        r = urllib.request.Request(P.BASE + action if action.startswith('/') else action, data=body, headers={
            'User-Agent': P.UA, 'Authorization': c.basic, 'Referer': P.BASE + PAGE, 'Content-Type': 'application/x-www-form-urlencoded'})
        try:
            with c.opener.open(r, timeout=120) as rep: st = rep.status; brut = rep.read(); ctype = rep.headers.get('Content-Type', '?'); u = rep.geturl(); cd = rep.headers.get('Content-Disposition', '')
        except urllib.error.HTTPError as e:
            st = e.code; brut = e.read(); ctype = e.headers.get('Content-Type', '?'); u = action; cd = ''
        else: pass
    P.log('réponse : HTTP %s, type %s, %d octets, adresse finale %s' % (st, ctype, len(brut), u))
    ext = 'pdf' if brut[:4] == b'%PDF' else ('xlsx' if brut[:2] == b'PK' else ('xls' if brut[:4] == b'\xd0\xcf\x11\xe0' else 'html'))
    chemin = '%s.%s' % (SORTIE_APERCU, ext); open(chemin, 'wb').write(brut)
    P.log('fichier reçu enregistré : %s' % chemin)
    if ext == 'pdf':
        try:
            txt = subprocess.run(['pdftotext', '-layout', chemin, '-'], capture_output=True, text=True, timeout=60).stdout
            open(SORTIE_APERCU + '.txt', 'w').write(txt); print(txt[:3000])
        except Exception as e: P.log('pdftotext indisponible (%s) : apt-get install -y poppler-utils' % e)
    elif ext == 'html':
        print(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', brut.decode('utf-8', 'replace')))[:1500])
        liens = re.findall(r'(?:src|href|data)="([^"]+)"', brut.decode('utf-8', 'replace'), re.I)
        print('liens/ressources dans la réponse :', ' | '.join(liens[:15]))
    return 0


if __name__ == '__main__':
    try: sys.exit(main())
    except Exception as e:
        P.log('erreur : %r' % e); sys.exit(1)
