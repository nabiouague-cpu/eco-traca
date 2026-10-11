// ==UserScript==
// @name         ORIGEN → Forms CARGILL (automate de saisie)
// @namespace    https://nabiouague-cpu.github.io/eco-traca/
// @version      1.14.0
// @description  Saisit automatiquement dans le formulaire Microsoft Forms de CARGILL les questionnaires producteurs collectés dans ORIGEN (ECORIGINE). Un lot copié depuis ORIGEN, un producteur par réponse, reprise automatique après chaque envoi.
// @author       ECORIGINE — ORIGEN
// @match        https://forms.office.com/*
// @match        https://forms.microsoft.com/*
// @match        https://forms.cloud.microsoft/*
// @match        https://*.forms.office.com/*
// @updateURL    https://nabiouague-cpu.github.io/eco-traca/automate/origen-forms-automate.user.js
// @downloadURL  https://nabiouague-cpu.github.io/eco-traca/automate/origen-forms-automate.user.js
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  const CLE = 'origen_forms_lot';
  const PAUSE = 450;           // ms entre deux actions (laisse React re-rendre)
  const ATTENTE_MAX = 15000;   // ms d'attente maximale d'un element
  const N = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.offsetParent !== null && !el.disabled;

  // ---------- lot (stocke dans localStorage de la page Forms) ----------
  function lireLot() { try { return JSON.parse(localStorage.getItem(CLE) || 'null'); } catch (e) { return null; } }
  function ecrireLot(lot) { localStorage.setItem(CLE, JSON.stringify(lot)); }
  function effacerLot() { localStorage.removeItem(CLE); }

  // ---------- panneau ----------
  let panneau, zoneTexte, zoneEtat, btnDemarrer, btnPause, btnStop, btnCopier;
  function creerPanneau() {
    if (document.getElementById('origen-automate')) return;
    panneau = document.createElement('div');
    panneau.id = 'origen-automate';
    panneau.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;width:340px;background:#fff;border:1px solid #cfd8d4;border-radius:12px;box-shadow:0 10px 30px rgba(14,59,54,.18);font:13px/1.45 Arial,Helvetica,sans-serif;color:#1e2b29;';
    panneau.innerHTML = '<div style="background:#0E3B36;color:#fff;padding:10px 14px;border-radius:12px 12px 0 0;font-weight:700;display:flex;justify-content:space-between;align-items:center;"><span>ORIGEN → Forms CARGILL</span><span id="oa-ferme" style="cursor:pointer;opacity:.8;">✕</span></div>'
      + '<div style="padding:12px 14px;">'
      + '<div id="oa-etat" style="margin-bottom:10px;white-space:pre-wrap;"></div>'
      + '<textarea id="oa-lot" placeholder="Colle ici le lot copié depuis ORIGEN (Ctrl+V)" style="width:100%;box-sizing:border-box;height:70px;border:1px solid #cfd8d4;border-radius:8px;padding:6px;font:12px monospace;"></textarea>'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;">'
      + '<button id="oa-demarrer" style="background:#F2B705;border:0;border-radius:8px;padding:8px 12px;font-weight:700;cursor:pointer;">Démarrer</button>'
      + '<button id="oa-pause" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Pause</button>'
      + '<button id="oa-copier" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;">Copier le résultat</button>'
      + '<button id="oa-stop" style="background:#fff;border:1px solid #cfd8d4;border-radius:8px;padding:8px 12px;cursor:pointer;color:#B3261E;">Effacer le lot</button>'
      + '</div></div>';
    document.body.appendChild(panneau);
    zoneTexte = panneau.querySelector('#oa-lot'); zoneEtat = panneau.querySelector('#oa-etat');
    btnDemarrer = panneau.querySelector('#oa-demarrer'); btnPause = panneau.querySelector('#oa-pause'); btnStop = panneau.querySelector('#oa-stop'); btnCopier = panneau.querySelector('#oa-copier');
    panneau.querySelector('#oa-ferme').onclick = () => { panneau.style.display = 'none'; };
    btnDemarrer.onclick = demarrer;
    btnPause.onclick = () => { const lot = lireLot(); if (!lot) return; lot.pause = !lot.pause; ecrireLot(lot); afficherEtat(); if (!lot.pause) boucle(); };
    btnStop.onclick = () => { if (confirm('Effacer le lot en cours sur cette page ? (Les réponses déjà envoyées à Forms restent envoyées.)')) { effacerLot(); afficherEtat(); } };
    btnCopier.onclick = copierResultat;
    afficherEtat();
  }
  function afficherEtat(msg) {
    const lot = lireLot();
    if (!zoneEtat) return;
    // Le champ de collage reste TOUJOURS visible (meme lot en cours) : avant, il se cachait des qu'un lot
    // existait, et Demarrer se contentait alors de relancer l'ancien lot sans jamais regarder ce qui avait
    // ete colle dedans -- un nouveau lot colle par-dessus un ancien etait donc silencieusement ignore.
    zoneTexte.style.display = '';
    if (!lot) { zoneEtat.textContent = msg || 'Aucun lot. Dans ORIGEN : « Copier le lot pour l\'automate », puis colle-le ci-dessous et clique Démarrer.'; zoneTexte.placeholder = 'Colle ici le lot copié depuis ORIGEN (Ctrl+V)'; return; }
    const total = lot.reponses.length, faits = lot.faits.length, erreurs = lot.erreurs.length;
    zoneEtat.textContent = (msg ? msg + '\n' : '') + 'Lot ' + lot.cooperative + ' : ' + faits + ' / ' + total + ' envoyé' + (faits > 1 ? 's' : '') + (erreurs ? ' · ' + erreurs + ' en erreur' : '') + (lot.pause ? '\n⏸ En pause' : (lot.restants.length ? '\n▶ En cours…' : '\n✓ Terminé — clique « Copier le résultat » puis colle-le dans ORIGEN.'));
    zoneTexte.placeholder = 'Colle ici un lot à jour pour remplacer celui en cours (ex. après correction dans ORIGEN)';
    btnPause.textContent = lot.pause ? 'Reprendre' : 'Pause';
  }
  function demarrer() {
    const lot = lireLot();
    const txt = zoneTexte.value.trim();
    if (txt) {
      // Quelque chose est colle dans la zone de texte : on le prend TOUJOURS en compte, meme si un lot
      // est deja en cours -- c'est justement ce qui manquait avant (voir commentaire dans afficherEtat).
      let nouveau;
      try { nouveau = JSON.parse(txt); } catch (e) { alert('Lot illisible : recopie-le depuis ORIGEN.'); return; }
      if (!nouveau || !Array.isArray(nouveau.reponses) || !nouveau.reponses.length) { alert('Lot vide.'); return; }
      if (lot) {
        const memeCooperative = lot.demande_id === nouveau.demande_id;
        const confirmation = memeCooperative
          ? 'Un lot « ' + lot.cooperative + ' » est en cours (' + lot.faits.length + '/' + lot.reponses.length + ' déjà envoyés). Le remplacer par la version à jour collée ici ? Les ' + lot.faits.length + ' déjà envoyés ne seront pas renvoyés ; les producteurs en erreur seront retentés avec les données à jour.'
          : 'Un lot « ' + lot.cooperative + ' » est en cours (' + lot.faits.length + '/' + lot.reponses.length + ' envoyés, non terminé). Le remplacer par le nouveau lot « ' + (nouveau.cooperative || '?') + ' » ? Rien de déjà envoyé à Forms n\'est annulé, mais le suivi de progression de ' + lot.cooperative + ' sera réinitialisé ici (sans perte côté ORIGEN).';
        if (!confirm(confirmation)) return;
        if (memeCooperative) {
          nouveau.faits = lot.faits.slice();
          nouveau.journal = lot.journal || [];
          nouveau.erreurs = [];                                                   // on retente les erreurs avec les donnees fraiches
          nouveau.restants = nouveau.reponses.map((r) => r.id).filter((id) => nouveau.faits.indexOf(id) === -1);
        } else {
          nouveau.restants = nouveau.reponses.map((r) => r.id); nouveau.faits = []; nouveau.erreurs = []; nouveau.journal = [];
        }
      } else {
        nouveau.restants = nouveau.reponses.map((r) => r.id); nouveau.faits = []; nouveau.erreurs = []; nouveau.journal = [];
      }
      nouveau.pause = false;
      ecrireLot(nouveau);
      zoneTexte.value = '';
      afficherEtat();
      boucle();
      return;
    }
    if (!lot) { alert('Colle d\'abord le lot copié depuis ORIGEN.'); return; }
    lot.pause = false; ecrireLot(lot);
    afficherEtat();
    boucle();
  }
  function copierResultat() {
    const lot = lireLot(); if (!lot) return;
    const res = JSON.stringify({ origen_forms_resultat: true, cooperative: lot.cooperative, demande_id: lot.demande_id, faits: lot.faits, erreurs: lot.erreurs });
    const fin = () => alert('Résultat copié. Dans ORIGEN, clique « Coller le résultat de l\'automate ».');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(res).then(fin, () => prompt('Copie ce texte puis colle-le dans ORIGEN :', res));
    else prompt('Copie ce texte puis colle-le dans ORIGEN :', res);
  }

  // ---------- lecture du formulaire ----------
  function texteTitre(bloc) {
    const t = bloc.querySelector('[data-automation-id="questionTitle"], [role="heading"], .question-title-box, h3, h2');
    let s = t ? t.textContent : bloc.textContent;
    return N(s.replace(/^\s*\d+\s*[.)]?\s*/, '').replace(/\*/g, '').replace(/obligatoire|required/gi, ''));
  }
  // Une question Forms obligatoire porte un asterisque dans son titre (ou aria-required="true" sur son
  // champ). Sert a distinguer un champ realmente facultatif (qu'on peut ignorer sans risque) d'un champ
  // qu'ORIGEN ne reconnait pas / n'a pas rempli alors qu'il bloquera l'envoi.
  function estObligatoire(bloc) {
    if (bloc.querySelector('[aria-required="true"]')) return true;
    const t = bloc.querySelector('[data-automation-id="questionTitle"], [role="heading"], .question-title-box, h3, h2');
    return /\*/.test(t ? t.textContent : bloc.textContent);
  }
  function blocsQuestions() {
    let b = Array.from(document.querySelectorAll('[data-automation-id="questionItem"]'));
    if (!b.length) b = Array.from(document.querySelectorAll('[role="group"], .office-form-question')).filter((x) => x.querySelector('input, textarea, [role="combobox"], [role="radio"]'));
    return b.filter(visible);
  }
  function trouverQuestion(titreN, questions) {
    // meilleure correspondance : libelle ORIGEN dont le debut normalise (35 car.) est contenu dans le titre Forms, ou l'inverse
    let meilleur = null, score = 0;
    for (const q of questions) {
      const l = N(q.libelle); if (!l) continue;
      const a = l.slice(0, 35), b = titreN.slice(0, 35);
      let s = 0;
      if (l === titreN) s = 1000; else if (titreN.indexOf(a) >= 0 || l.indexOf(b) >= 0) s = Math.min(l.length, titreN.length);
      if (s > score) { score = s; meilleur = q; }
    }
    return score >= 15 ? meilleur : null;
  }
  // Clic "complet" : .click() suffit d'habitude, mais certains controles de Forms (surtout role=radio
  // sans vrai <input>) n'ecoutent que des evenements souris bas niveau et ignorent un simple .click().
  function clicComplet(el) {
    try { el.click(); } catch (e) {}
    const opts = { bubbles: true, cancelable: true, view: window };
    try {
      if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      if (window.PointerEvent) el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      el.dispatchEvent(new MouseEvent('click', opts));
    } catch (e) {}
  }
  const estCoche = (el) => !!(el && (el.checked || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true'));
  // Pose .checked via le VRAI setter natif (celui que React a patché sur le prototype est ainsi contourné),
  // puis declenche les evenements -- technique standard pour les composants controles par React. UTILE EN
  // DERNIER RECOURS SEULEMENT : sur les questions EPI / proximite de l'eau, cette technique rend le DOM
  // coche sans que Forms n'enregistre reellement la reponse (son propre message de validation au moment de
  // l'envoi le confirme) -- elle cree un succes en trompe-l'oeil. `cocherEtVerifier` essaie donc toujours un
  // vrai clic en premier, et ne retombe sur `cocherReact` que si meme un clic complet (evenements souris bas
  // niveau inclus) echoue.
  function cocherReact(input) {
    if (!input || input.tagName !== 'INPUT') return false;
    try {
      const descripteur = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'checked');
      descripteur.set.call(input, true);
      input.dispatchEvent(new Event('click', { bubbles: true }));
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) { return false; }
  }
  // Clique sur une case/bouton radio et VERIFIE que ca a reellement pris -- EN INTERROGEANT LE DOM EN
  // DIRECT a chaque verification, jamais une reference mise en cache. C'est le point critique : si Forms
  // re-rend le bloc entre deux de nos actions (ce qui semble arriver ici), la reference "cible" capturee
  // au debut devient un noeud orphelin/obsolete -- la cocher et verifier SUR CETTE MEME reference donne
  // l'illusion d'un succes (on vient de modifier cette copie), alors que la vraie page, elle, n'a jamais
  // bouge. `trouverCible` refait donc la recherche en direct a chaque fois plutot que de reutiliser une
  // variable capturee, pour que la verification porte sur ce qui est reellement affiche.
  //
  // ORDRE DES TECHNIQUES -- important : sur deux questions precises (EPI, proximite de l'eau), Forms
  // confirme lui-meme (son propre message "Vous devez encore repondre...") n'avoir JAMAIS enregistre la
  // reponse, alors que NOTRE verification locale (estCoche sur le DOM) la voyait cochee a chaque fois, y
  // compris juste avant l'envoi. Cela ne peut arriver que si `cocherReact` (qui force .checked via le
  // setter natif puis simule les evenements) rend le controle visuellement/techniquement coche SANS que
  // le vrai gestionnaire de clic de Forms ne s'execute -- l'equivalent d'un succes en trompe-l'oeil qui
  // nous faisait arreter la boucle AVANT d'essayer un vrai clic. On inverse donc l'ordre : un vrai clic
  // (natif, puis avec evenements bas niveau complets) est TOUJOURS tente en premier et a chaque essai --
  // sans effet indesirable sur un bouton radio deja selectionne -- et `cocherReact` ne sert plus que de
  // dernier recours si meme ca echoue.
  async function cocherEtVerifier(trouverCible) {
    // IMPORTANT : si `trouverCible()` ne trouve rien a l'instant T (ex. Forms est en plein re-rendu de ce
    // bloc suite a la reponse precedente), on ATTEND et on retente -- on ne doit JAMAIS retomber sur une
    // reference perimee en guise de secours (c'est justement le piege qu'on corrige ici : un tel repli
    // silencieux fait croire au succes alors qu'on agit sur une copie morte que personne ne voit).
    for (let essai = 0; essai < 6; essai++) {
      let cible = trouverCible();
      if (!cible) { await dormir(250); continue; }
      if (essai === 0 && estCoche(cible)) return true;    // deja coche avant toute action -> rien a faire
      const cliquable = cible.closest('label') || cible;
      try { cliquable.click(); } catch (e) {}
      await dormir(200);
      cible = trouverCible();
      if (!(cible && estCoche(cible))) {
        clicComplet(cliquable);
        await dormir(250);
        cible = trouverCible();
      }
      if (!(cible && estCoche(cible))) {
        const base = cible || cliquable;
        const natif = base && (base.tagName === 'INPUT' ? base : base.querySelector('input[type="radio"], input[type="checkbox"]'));
        if (natif) { cocherReact(natif); await dormir(200); cible = trouverCible(); }
      }
      if (cible && estCoche(cible)) return true;
    }
    const finale = trouverCible();
    return !!(finale && estCoche(finale));
  }
  // Diagnostic detaille sur l'element cible quand meme les clics "parents" echouent -- pour comprendre
  // enfin pourquoi (element detache du document ? structure differente de ce qu'on attend ?) au lieu de
  // devoir redemander une capture d'ecran a chaque fois.
  function diagnosticElement(el) {
    if (!el) return 'élément absent';
    const attache = document.contains(el) ? 'attaché au document' : 'DÉTACHÉ du document (élément obsolète ?)';
    let html = ''; try { html = el.outerHTML.replace(/\s+/g, ' ').slice(0, 220); } catch (e) {}
    return attache + ' — ' + html;
  }
  function setValeurReact(el, valeur) {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, valeur);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  async function attendre(fn, max) {
    const debut = Date.now();
    while (Date.now() - debut < (max || ATTENTE_MAX)) { const r = fn(); if (r) return r; await dormir(200); }
    return null;
  }
  async function repondreBloc(bloc, titreBloc, q, valeur) {
    const v = String(valeur == null ? '' : valeur);
    if (!v) return 'vide';
    // Forms peut ne pas avoir fini de monter les options si le bloc n'a jamais ete visible a l'ecran.
    try { bloc.scrollIntoView({ block: 'center' }); } catch (e) {}
    await dormir(250);
    const correspond = (r) => {
      const lab = r.getAttribute('aria-label') || r.value || (r.closest('label') && r.closest('label').textContent) || (r.parentElement && r.parentElement.textContent) || '';
      return N(lab) === N(v) || N(lab).indexOf(N(v)) === 0;
    };
    // Le bloc passe en argument peut devenir obsolete si Forms re-rend entre-temps (voir cocherEtVerifier).
    // On retrouve donc le conteneur ACTUEL par son titre a chaque recherche -- et surtout, SANS repli sur
    // `bloc` quand il est introuvable a l'instant T (un tel repli silencieux reintroduirait exactement le
    // bug qu'on corrige : agir sur une copie perimee en pensant agir sur la vraie page).
    const conteneurActuel = () => blocsQuestions().find((x) => texteTitre(x) === titreBloc) || null;
    // 1. choix (boutons radio)
    const radios = Array.from(bloc.querySelectorAll('input[type="radio"], [role="radio"]')).filter(visible);
    if (radios.length) {
      const trouverCible = () => { const c = conteneurActuel(); return c ? Array.from(c.querySelectorAll('input[type="radio"], [role="radio"]')).filter(visible).find(correspond) : null; };
      if (!(await attendre(trouverCible, 3000))) return 'option « ' + v + ' » introuvable';
      const ok = await cocherEtVerifier(trouverCible);
      return ok ? 'ok' : 'clic sans effet sur l\'option « ' + v + ' » (vérifié en direct sur le DOM, essayé plusieurs fois) — ' + diagnosticElement(trouverCible());
    }
    // 1bis. certaines questions a reponse unique sont rendues par Forms avec des cases a cocher (pas des boutons radio)
    const cases = Array.from(bloc.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible);
    if (cases.length) {
      const trouverCible = () => { const c = conteneurActuel(); return c ? Array.from(c.querySelectorAll('input[type="checkbox"], [role="checkbox"]')).filter(visible).find(correspond) : null; };
      if (!(await attendre(trouverCible, 3000))) return 'option « ' + v + ' » introuvable';
      const ok = await cocherEtVerifier(trouverCible);
      return ok ? 'ok' : 'clic sans effet sur l\'option « ' + v + ' » (vérifié en direct sur le DOM, essayé plusieurs fois) — ' + diagnosticElement(trouverCible());
    }
    // 2. liste deroulante
    const combo = bloc.querySelector('select') || bloc.querySelector('[role="combobox"]') || bloc.querySelector('[data-automation-id="dropdown"] button') || bloc.querySelector('[data-automation-id="dropdown"]');
    if (combo) {
      if (combo.tagName === 'SELECT') {
        const opt = Array.from(combo.options).find((o) => N(o.textContent) === N(v) || N(o.textContent).indexOf(N(v)) === 0);
        if (!opt) return 'option « ' + v + ' » introuvable';
        combo.value = opt.value; combo.dispatchEvent(new Event('change', { bubbles: true })); return 'ok';
      }
      combo.click(); await dormir(PAUSE);
      const opt = await attendre(() => Array.from(document.querySelectorAll('[role="option"], [data-automation-id="dropdownOption"], li[role="menuitem"]')).filter(visible).find((o) => N(o.textContent) === N(v) || N(o.textContent).indexOf(N(v)) === 0), 4000);
      if (!opt) { document.body.click(); return 'option « ' + v + ' » introuvable dans la liste'; }
      opt.click(); await dormir(PAUSE);
      return 'ok';
    }
    // 2bis. "fausse" liste deroulante : ni <select>, ni role=combobox, ni data-automation-id=dropdown, juste un
    // bloc cliquable "maison" (souvent une icone svg en forme de fleche + le texte "Selectionnez votre reponse").
    // On clique l'element le plus proche de l'icone (ou, a defaut, celui qui porte ce texte), puis on cherche les
    // options qui apparaissent dans tout le document (le menu ouvert est souvent place hors du bloc).
    {
      let declencheur = null;
      const icone = bloc.querySelector('svg');
      if (icone) {
        let el = icone.parentElement;
        while (el && el !== bloc) {
          if (visible(el) && el.getBoundingClientRect().width > 20) { declencheur = el; break; }
          el = el.parentElement;
        }
      }
      if (!declencheur) {
        declencheur = Array.from(bloc.querySelectorAll('div, span')).filter(visible)
          .find((el) => el.children.length <= 3 && /selectionnez|select your|choisissez|choose/.test(N(el.textContent)));
      }
      if (declencheur) {
        declencheur.click(); await dormir(PAUSE);
        const opt = await attendre(() => Array.from(document.querySelectorAll('[role="option"], [data-automation-id="dropdownOption"], li[role="menuitem"], li')).filter(visible).find((o) => N(o.textContent) === N(v) || N(o.textContent).indexOf(N(v)) === 0), 4000);
        if (opt) { opt.click(); await dormir(PAUSE); return 'ok'; }
        document.body.click();
        return 'option « ' + v + ' » introuvable dans le menu (liste déroulante "maison")';
      }
    }
    // 3. texte
    const champ = bloc.querySelector('textarea, input[type="text"], input:not([type]), input[data-automation-id="textInput"]');
    if (champ) { champ.focus(); setValeurReact(champ, v); champ.blur(); return 'ok'; }
    // diagnostic : ce qu'il y a reellement dans ce bloc (sans filtrer les div/span cette fois), pour comprendre
    // pourquoi rien n'a ete reconnu -- soit le bloc ne contient vraiment aucun controle, soit ce n'est pas le bon bloc.
    const decrire = (el) => {
      let s = el.tagName.toLowerCase();
      const role = el.getAttribute && el.getAttribute('role'); if (role) s += '[role=' + role + ']';
      const aid = el.getAttribute && el.getAttribute('data-automation-id'); if (aid) s += '{' + aid + '}';
      if (el.type) s += ':' + el.type;
      if (el.hasAttribute && el.hasAttribute('tabindex')) s += '#tab';
      return s;
    };
    const tousLesElements = Array.from(bloc.querySelectorAll('*'));
    const distincts = tousLesElements.map(decrire).filter((v2, i, a) => a.indexOf(v2) === i).slice(0, 20);
    const texte = N(bloc.textContent).slice(0, 140);
    return 'aucun champ reconnu — bloc=' + decrire(bloc) + ' (' + tousLesElements.length + ' element' + (tousLesElements.length > 1 ? 's' : '') + ') : ' + (distincts.length ? distincts.join(', ') : 'aucun') + ' — texte du bloc : "' + texte + '"';
  }
  function boutonParTexte(regex, selecteur) {
    const direct = selecteur ? document.querySelector(selecteur) : null;
    if (direct && visible(direct)) return direct;
    return Array.from(document.querySelectorAll('button, a[role="button"], a')).filter(visible).find((b) => regex.test(N(b.textContent))) || null;
  }
  const boutonSuivant = () => boutonParTexte(/^(suivant|next)$/, 'button[data-automation-id="nextButton"]');
  const boutonEnvoyer = () => boutonParTexte(/^(envoyer|submit)$/, 'button[data-automation-id="submitButton"]');
  const lienAutre = () => boutonParTexte(/autre reponse|another response/, 'a[data-automation-id="submitAnother"]');
  // Texte RENDU (innerText) : textContent inclurait les scripts de la page.
  const pageMerci = () => !!lienAutre() || (!boutonEnvoyer() && !boutonSuivant() && /(^| )merci( |$)|thank you|votre reponse a ete envoyee|your response was submitted/.test(N(document.body.innerText).slice(0, 4000)));

  // ---------- boucle principale (reprend apres chaque rechargement) ----------
  let enCours = false;
  async function boucle() {
    if (enCours) return; enCours = true;
    try {
      let lot = lireLot();
      if (!lot || lot.pause || !lot.restants.length) { afficherEtat(); return; }
      // Page « merci » : passer a la reponse suivante (recharge la page -> le script reprend)
      if (pageMerci()) {
        const a = lienAutre();
        if (a) { afficherEtat('Réponse envoyée, passage au producteur suivant…'); await dormir(PAUSE); a.click(); await dormir(3000); if (pageMerci()) location.reload(); return; }
        // Pas de lien "repondre a nouveau" trouve sur la page de confirmation : on ne doit PAS bricoler l'URL
        // actuelle (retirer le ?id=... casse le formulaire -> "Ce formulaire n'existe pas"). On n'utilise que le
        // lien explicite renseigne dans ORIGEN ; sans lui, on met en pause plutot que de deviner.
        if (lot.lien) { location.href = lot.lien; return; }
        lot.pause = true; ecrireLot(lot);
        afficherEtat('⚠ Réponse envoyée, mais impossible de trouver le lien "Répondre à nouveau" sur cette page.\nRenseigne le lien du formulaire dans ORIGEN (champ "Lien du formulaire Microsoft Forms de CARGILL"), ouvre ce lien ici, puis clique « Reprendre ».');
        return;
      }
      const id = lot.restants[0];
      const rep = lot.reponses.find((r) => r.id === id);
      if (!rep) { lot.restants.shift(); ecrireLot(lot); enCours = false; return boucle(); }
      afficherEtat('Saisie de ' + rep.nom + '…');
      // pages successives
      for (let page = 0; page < 12; page++) {
        const blocs = await attendre(() => { const b = blocsQuestions(); return b.length ? b : null; }, 8000);
        if (!blocs) { marquerErreur(lot, id, 'aucune question visible sur la page ' + (page + 1)); return; }
        const problemes = [];
        const reponduSurCettePage = [];    // {titre,q,valeur} : pour re-verifier juste avant Envoyer (voir plus bas)
        // Passes successives : Forms fait apparaitre des questions apres certaines reponses (branchement),
        // et peut re-rendre la page ; on re-cherche donc chaque bloc par son titre, jusqu'a ce que plus
        // aucune nouvelle question n'apparaisse.
        const dejaFaits = new Set();
        for (let passe = 0; passe < 4; passe++) {
          const titres = blocsQuestions().map(texteTitre).filter((t) => t && !dejaFaits.has(t));
          if (!titres.length) break;
          for (const titre of titres) {
            dejaFaits.add(titre);
            const blocActuel = blocsQuestions().find((x) => texteTitre(x) === titre) || null;
            const requis = blocActuel ? estObligatoire(blocActuel) : false;
            const q = trouverQuestion(titre, lot.questions);
            if (!q) {
              // Avant, une question inconnue d'ORIGEN etait silencieusement laissee de cote -> si elle est
              // obligatoire sur Forms, l'envoi se bloquait plus tard sans qu'on sache pourquoi (ex. lot copie
              // depuis ORIGEN avant l'ajout d'une nouvelle question : recharge ORIGEN et recopie le lot).
              if (requis) problemes.push('Question inconnue d\'ORIGEN (lot obsolète ? recharge ORIGEN et recopie le lot) : ' + titre.slice(0, 70));
              continue;
            }
            const valeur = rep.valeurs[q.cle];
            if (valeur == null || valeur === '') {
              if (requis) problemes.push(q.libelle.slice(0, 60) + ' → aucune réponse enregistrée dans ORIGEN pour ce producteur');
              continue;                                          // pas sur le chemin suivi
            }
            const bloc = await attendre(() => blocsQuestions().find((x) => texteTitre(x) === titre) || null, 4000);
            if (!bloc) { problemes.push(q.libelle.slice(0, 60) + ' → question disparue de la page'); continue; }
            let r;
            try { r = await repondreBloc(bloc, titre, q, valeur); } catch (e) { r = 'erreur : ' + e.message; }
            await dormir(200);
            if (r === 'ok') reponduSurCettePage.push({ titre, q, valeur });
            else if (r !== 'vide') problemes.push(q.libelle.slice(0, 60) + ' → ' + r);
          }
          await dormir(300);
        }
        if (problemes.length) { marquerErreur(lot, id, problemes.join(' ; ')); return; }
        // Derniere verification juste avant de cliquer Envoyer : repondre a une question suivante peut
        // parfois faire re-rendre une question precedente et effacer silencieusement sa reponse (cas
        // observe sur EPI / proximite de l'eau -- le clic semblait reussi au moment ou on l'a fait, mais
        // Forms l'avait deja "oublie"). On repasse donc une fois sur tout ce qui a ete repondu sur cette
        // page pour s'assurer que c'est toujours bien en place, et on corrige si besoin avant d'envoyer.
        for (const r1 of reponduSurCettePage) {
          const bloc2 = blocsQuestions().find((x) => texteTitre(x) === r1.titre);
          if (!bloc2) { problemes.push(r1.q.libelle.slice(0, 60) + ' → question disparue avant l\'envoi'); continue; }
          let r2;
          try { r2 = await repondreBloc(bloc2, r1.titre, r1.q, r1.valeur); } catch (e) { r2 = 'erreur : ' + e.message; }
          if (r2 !== 'ok' && r2 !== 'vide') problemes.push(r1.q.libelle.slice(0, 60) + ' → effacée entre-temps, ' + r2);
        }
        if (problemes.length) { marquerErreur(lot, id, problemes.join(' ; ')); return; }
        await dormir(PAUSE);
        const suivant = boutonSuivant();
        if (suivant) { suivant.click(); await dormir(900); continue; }
        const envoyer = boutonEnvoyer();
        if (!envoyer) { marquerErreur(lot, id, 'bouton Envoyer introuvable sur la page ' + (page + 1)); return; }
        // A chaque correctif, le blocage se deplaçait vers la DERNIERE question repondue avant Envoyer --
        // ce schema ressemble moins a un probleme propre a chaque question qu'a une course de vitesse entre
        // nos clics et la validation interne de Forms (qui semble se mettre a jour apres un delai, pas
        // instantanement). On laisse donc le temps a Forms de "digerer" avant de cliquer Envoyer, et si la
        // confirmation ne vient pas, on reverifie/recorrige puis on retente -- jusqu'a 3 fois -- avant de
        // vraiment signaler une erreur.
        let confirme = false, derniereErreur = '';
        for (let tentative = 0; tentative < 3 && !confirme; tentative++) {
          if (tentative > 0) {
            const pb = [];
            for (const r1 of reponduSurCettePage) {
              const bloc2 = blocsQuestions().find((x) => texteTitre(x) === r1.titre);
              if (!bloc2) { pb.push(r1.q.libelle.slice(0, 60) + ' → question disparue avant l\'envoi'); continue; }
              let r2; try { r2 = await repondreBloc(bloc2, r1.titre, r1.q, r1.valeur); } catch (e) { r2 = 'erreur : ' + e.message; }
              if (r2 !== 'ok' && r2 !== 'vide') pb.push(r1.q.libelle.slice(0, 60) + ' → ' + r2);
            }
            if (pb.length) { marquerErreur(lot, id, pb.join(' ; ')); return; }
          }
          await dormir(1200);                                     // laisse Forms digerer les derniers changements
          const envoyerMaintenant = boutonEnvoyer();
          if (!envoyerMaintenant) { marquerErreur(lot, id, 'bouton Envoyer introuvable sur la page ' + (page + 1)); return; }
          envoyerMaintenant.click();
          confirme = !!(await attendre(() => pageMerci() ? true : null, 10000));
          if (!confirme) {
            const resume = (document.body.innerText.match(/Vous devez encore répondre[^\n]*|You still need to answer[^\n]*/i) || [])[0];
            derniereErreur = 'pas de confirmation après Envoyer' + (resume ? ' — ' + resume.trim() : ' (champ obligatoire manquant ?)');
          }
        }
        if (!confirme) { marquerErreur(lot, id, derniereErreur + ' (essayé 3 fois)'); return; }
        lot = lireLot(); lot.restants = lot.restants.filter((x) => x !== id); lot.faits.push(id); lot.journal.push({ id, le: new Date().toISOString() }); ecrireLot(lot);
        afficherEtat('✓ ' + rep.nom + ' envoyé.');
        await dormir(800);
        enCours = false;
        return boucle();  // page merci -> reponse suivante
      }
      marquerErreur(lot, id, 'trop de pages');
    } catch (e) { const lot2 = lireLot(); if (lot2) { lot2.pause = true; ecrireLot(lot2); } afficherEtat('⚠ Erreur inattendue : ' + e.message); }
    finally { enCours = false; }
  }
  function marquerErreur(lot, id, detail) {
    lot = lireLot(); lot.restants = lot.restants.filter((x) => x !== id); lot.erreurs.push({ id, detail }); lot.pause = true; ecrireLot(lot);
    afficherEtat('⚠ Erreur sur ce producteur : ' + detail + '\nLe formulaire est laissé tel quel pour vérification. Corrige à la main ou recharge la page puis « Reprendre » pour passer au suivant.');
  }

  // ---------- demarrage ----------
  function init() {
    creerPanneau();
    const lot = lireLot();
    if (lot && !lot.pause && lot.restants.length) { setTimeout(boucle, 1500); }
  }
  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 800); else window.addEventListener('DOMContentLoaded', () => setTimeout(init, 800));
})();
