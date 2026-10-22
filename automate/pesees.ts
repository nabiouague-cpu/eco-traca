// ECORIGINE — Edge Function : réception des PESÉES SAIGIC envoyées par le serveur relais (VPS en Côte d'Ivoire).
// Pour chaque pesée : on retrouve la coopérative par le n° CCC ; on enregistre sacs acceptés, poids accepté, poids net payé,
// TKM réel (F/kg) et barème de référence (bareme_tkm, PAS une commission) ; sinon on crée l'achat (« cacao déchargé »).
// v9 : on enregistre aussi les résultats d'analyse / contrôle qualité lus sur le détail SAIGIC
//      (pesee_humidite, pesee_grade, pesee_conformite, pesee_acceptation + pesee_detail = toute la page, libellé -> valeurs).
// Le type de cacao (RA / FT) vient de la nature indiquée par le SAIGIC, sinon de la certification de la coopérative :
// c'est lui qui fait apparaître le bouton de déclaration (Multitrace / Fairtrace) dès que le volume est validé.
// v11 : poids brut déclaré du connaissement (liste SAIGIC) recopié sur l'achat quand il manque.
// v12 : poids net et nombre de sacs DÉCLARÉS du connaissement (liste SAIGIC) recopiés sur l'achat quand ils manquent (quantité à 0),
//       même si le connaissement a été vu avant d'être rapproché d'une coopérative (colonnes poids_net / nb_sacs de saigic_connaissements_vus).
// Secret : en-tête x-relais-secret = RELAIS_SAIGIC_SECRET. dry_run=true : aucun écrit.
import { createClient } from 'jsr:@supabase/supabase-js@2';

const rep = (c: unknown, s = 200) => new Response(JSON.stringify(c), { status: s, headers: { 'Content-Type': 'application/json' } });
async function egaux(a: string, b: string) {
  const e = new TextEncoder();
  const ha = new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(a)));
  const hb = new Uint8Array(await crypto.subtle.digest('SHA-256', e.encode(b)));
  let d = 0; for (let i = 0; i < ha.length; i++) d |= ha[i] ^ hb[i]; return d === 0;
}
const cle = (s: unknown) => String(s ?? '').toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9]/g, '');
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : null;
};
// Comparaison stable (l'ordre des clés d'un jsonb relu en base peut différer de celui envoyé).
const stable = (v: unknown): string => JSON.stringify(v ?? null, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)) ? Object.keys(x).sort().reduce((o: any, k) => { o[k] = (x as any)[k]; return o; }, {}) : x);
function dateIso(v: unknown): string {
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
type Coop = { id: string; nom: string | null; nom_complet: string | null; ccc_num: string | null; fiche_a_completer?: boolean; departement?: string | null; certifications?: string | null };
function trouverCoop(code: string, codeFourn: string, fournisseur: string, coops: Coop[]): Coop | null {
  const cf = String(codeFourn || '').trim().toUpperCase();
  let best: Coop | null = null, len = 0;
  for (const c of coops) {
    const ccc = String(c.ccc_num ?? '').trim().toUpperCase();
    if (!ccc) continue;
    if ((cf && ccc === cf) || code.startsWith(ccc + '-')) { if (ccc.length > len) { best = c; len = ccc.length; } }
  }
  if (best) return best;
  const k = cle(fournisseur);
  if (k.length >= 3) {
    const cands = coops.filter((c) => cle(c.nom) === k || cle(c.nom_complet) === k);
    if (cands.length === 1) return cands[0];
  }
  return null;
}
// Type de cacao d'une livraison : nature SAIGIC d'abord, sinon certification de la coopérative ; '' = ordinaire.
function typeCacao(nature: unknown, coop: Coop | null): string {
  const n = String(nature || '').toUpperCase();
  if (n.includes('RAINFOREST')) return 'RA';
  if (n.includes('FAIRTRADE')) return 'FT';
  const c = String(coop?.certifications || '').toUpperCase();
  if (c.includes('RAINFOREST') || c === 'RA') return 'RA';
  if (c.includes('FAIRTRADE') || c === 'FT') return 'FT';
  return '';
}

async function creerCoop(sb: any, coops: Coop[], p: any, dry: boolean, bilan: any): Promise<Coop | null> {
  const nom = String(p.fournisseur || '').trim(); const ccc = String(p.code_fourn || '').trim().toUpperCase();
  if (!nom || !ccc) return null;
  const nature = String(p.nature || '').toUpperCase();
  // Nom complet de la certification (comme dans le reste d'ORIGEN), jamais le sigle seul.
  const cert = nature.includes('RAINFOREST') ? 'Rainforest Alliance' : nature.includes('FAIRTRADE') ? 'Fairtrade' : '';
  const c: any = { id: 'coop_saigic_' + ccc, nom, nom_complet: nom, ccc_num: ccc, type: 'cooperative',
    statut: cert ? 'Certifiée' : 'Non certifiée', certifications: cert, ville: String(p.localite || '').trim() || null,
    departement: String(p.departement || '').trim() || null, fiche_a_completer: true, verifiee: false };
  bilan.coops_creees.push(`${nom} (${ccc})`);
  if (!dry) {
    const { error } = await sb.from('cooperatives').upsert(c, { onConflict: 'id', ignoreDuplicates: true });
    if (error) { bilan.erreurs.push('création de ' + nom + ' : ' + error.message); return null; }
  }
  const nc: Coop = { id: c.id, nom, nom_complet: nom, ccc_num: ccc, fiche_a_completer: true, departement: c.departement, certifications: cert }; coops.push(nc); return nc;
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return rep({ error: 'POST uniquement' }, 405);
  const secret = Deno.env.get('RELAIS_SAIGIC_SECRET');
  if (!secret) return rep({ error: "RELAIS_SAIGIC_SECRET n'est pas configuré." }, 500);
  if (!(await egaux(req.headers.get('x-relais-secret') || '', secret))) return rep({ error: 'Non autorisé' }, 401);
  try {
    const corps = await req.json();
    const pesees = Array.isArray(corps?.pesees) ? corps.pesees : null;
    if (!pesees) return rep({ error: 'Champ « pesees » manquant.' }, 400);
    if (pesees.length > 500) return rep({ error: 'Trop de pesées.' }, 413);
    const dry = corps?.dry_run === true;
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);

    const { data: cb, error: e1 } = await sb.from('cooperatives').select('id, nom, nom_complet, ccc_num, fiche_a_completer, departement, certifications');
    if (e1) throw new Error('coopératives : ' + e1.message);
    const coops = (cb || []) as Coop[];
    const { data: camps } = await sb.from('campagnes').select('id, nom, date_debut, date_fin');

    const bilan = { lues: pesees.length, mises_a_jour: 0, creees: 0, inchangees: 0, verrouillees: 0, analyses_seules: 0, sans_connaissement: 0, coop_inconnue: [] as string[], coops_creees: [] as string[], rattachees: 0, erreurs: [] as string[], plan: [] as unknown[] };
    const vus = new Set<string>();

    for (const p of pesees) {
      const code = String(p?.connaissement ?? '').trim().toUpperCase();
      if (!code) { bilan.sans_connaissement++; continue; }
      if (vus.has(code)) continue; vus.add(code);
      let coop = trouverCoop(code, p.code_fourn, p.fournisseur, coops);
      if (!coop) { coop = await creerCoop(sb, coops, p, dry, bilan); }
      const type = typeCacao(p.nature, coop);
      const sacs = num(p.sacs_acceptes), brut = num(p.poids_net), netPaye = num(p.poids_net_acc);
      const maj: Record<string, unknown> = {
        nombre_sacs_accepte: sacs, poids_brut_accepte: brut, poids_net_produit: netPaye,
        code_pesee: String(p.code_pesee || '').trim() || null,
      };
      const tkm = num(p.tkm), bareme = num(p.bareme), coutTr = num(p.montant_transport);
      if (tkm !== null) maj.tkm = tkm;
      // Le barème (15 F/kg) est le TKM moyen de référence du Conseil, PAS une commission : stocké à part, jamais ajouté au montant payé.
      if (bareme !== null) maj.bareme_tkm = bareme;
      if (coutTr !== null) maj.cout_transport_theorique = coutTr;

      // Résultats d'analyse / contrôle qualité (détail SAIGIC) : jamais écrasés par du vide.
      const analyse: Record<string, unknown> = {};
      const hum = num(p.humidite); if (hum !== null) analyse.pesee_humidite = hum;
      for (const [src, col] of [['grade', 'pesee_grade'], ['conformite', 'pesee_conformite'], ['acceptation', 'pesee_acceptation']] as const) {
        const t = String(p[src] || '').trim(); if (t) analyse[col] = t;
      }
      if (p.detail && typeof p.detail === 'object' && !Array.isArray(p.detail) && Object.keys(p.detail).length) analyse.pesee_detail = p.detail;
      const analyseChange = (a: any) => Object.entries(analyse).some(([k, v]) => stable(a[k]) !== stable(v));

      const dep = String(p.departement || '').trim();
      // Origine du cacao : localité de la pesée (sinon sous-préfecture, sinon département) — même règle que la page détail du connaissement ;
      // ne remplit que si l'achat n'a pas encore d'origine (une saisie à la main n'est jamais écrasée).
      const origine = String(p.localite || '').trim() || String((p.detail || {})['Sous-Préfecture']?.[0] || '').trim() || dep;
      if (coop && coop.fiche_a_completer && dep && !/^\d+$/.test(dep) && coop.departement !== dep) {
        if (!dry) await sb.from('cooperatives').update({ departement: dep }).eq('id', coop.id);
        coop.departement = dep;
      }

      const { data: ex, error: e2 } = await sb.from('achats').select('*').eq('connaissement', code);
      if (e2) { bilan.erreurs.push(code + ' : ' + e2.message); continue; }
      const lignes = (ex || []).filter((a: any) => !a.producteur_id);
      // Poids brut DÉCLARÉ du connaissement (lu sur la liste SAIGIC par le robot des connaissements) : OBC le demande sur les données de livraison.
      let brutDeclare: number | null = null, netDeclare: number | null = null, sacsDeclares: number | null = null;
      if (!lignes.length || lignes.some((a: any) => !(Number(a.poids_brut) > 0) || !(Number(a.quantite_kg) > 0) || !(Number(a.nombre_sacs) > 0))) {
        const { data: vu } = await sb.from('saigic_connaissements_vus').select('donnees, poids_net, nb_sacs').eq('code_connaissement', code).maybeSingle();
        brutDeclare = num((vu as any)?.donnees?.poids_brut_charg);
        netDeclare = num((vu as any)?.donnees?.poids_net_charg) ?? num((vu as any)?.poids_net);
        sacsDeclares = num((vu as any)?.donnees?.Nbre_sac_charg) ?? num((vu as any)?.nb_sacs);
      }

      if (lignes.length) {
        for (const a of lignes as any[]) {
          if (a.refoulee || a.declaration_ra_le || a.declaration_ft_le) {
            // Livraison verrouillée (déclarée / refoulée) : les poids ne bougent pas, seule l'analyse est enregistrée.
            bilan.verrouillees++;
            if (Object.keys(analyse).length && analyseChange(a)) {
              bilan.plan.push({ code, action: 'analyse', cooperative: coop?.nom || null });
              if (!dry) {
                const { error } = await sb.from('achats').update(analyse).eq('id', a.id);
                if (error) bilan.erreurs.push(code + ' : ' + error.message); else bilan.analyses_seules++;
              }
            }
            continue;
          }
          const typeAManquer = !String(a.type_cacao || '').trim() && !!type;
          const change = Number(a.nombre_sacs_accepte || 0) !== (sacs || 0) || Number(a.poids_brut_accepte || 0) !== (brut || 0)
            || Number(a.poids_net_produit || 0) !== (netPaye || 0) || (a.code_pesee || null) !== maj.code_pesee
            || (tkm !== null && Number(a.tkm || 0) !== tkm) || (bareme !== null && Number(a.bareme_tkm || 0) !== bareme)
            || (coutTr !== null && Number(a.cout_transport_theorique || 0) !== coutTr) || typeAManquer || analyseChange(a);
          const patch: Record<string, unknown> = { ...maj, ...analyse };
          if (typeAManquer) patch.type_cacao = type;
          const origineAManquer = !String(a.lieu_origine || '').trim() && !!origine;
          if (origineAManquer) patch.lieu_origine = origine;
          const brutAManquer = !(Number(a.poids_brut) > 0) && brutDeclare !== null && brutDeclare > 0;
          if (brutAManquer) patch.poids_brut = brutDeclare;
          const netAManquer = !(Number(a.quantite_kg) > 0) && netDeclare !== null && netDeclare > 0;
          if (netAManquer) patch.quantite_kg = Math.round(netDeclare as number);
          const sacsAManquer = !(Number(a.nombre_sacs) > 0) && sacsDeclares !== null && sacsDeclares > 0;
          if (sacsAManquer) patch.nombre_sacs = Math.round(sacsDeclares as number);
          if (coop && !a.cooperative_id) patch.cooperative_id = coop.id;
          if (!a.code_fourn && p.code_fourn) patch.code_fourn = String(p.code_fourn).trim();
          if (!change && !origineAManquer && !brutAManquer && !netAManquer && !sacsAManquer && !(coop && !a.cooperative_id)) { bilan.inchangees++; continue; }
          bilan.plan.push({ code, action: 'maj', cooperative: coop?.nom || null });
          if (!dry) {
            const { error } = await sb.from('achats').update(patch).eq('id', a.id);
            if (error) { bilan.erreurs.push(code + ' : ' + error.message); continue; }
          }
          bilan.mises_a_jour++;
        }
        continue;
      }

      const d = dateIso(p.date_p2) || new Date().toISOString().slice(0, 10);
      const camp = (camps || []).find((c: any) => c.date_debut && c.date_fin && String(c.date_debut) <= d && d <= String(c.date_fin));
      const mois = Number(d.slice(5, 7));
      const nouvel = {
        id: 'a_saigic_' + code, cooperative_id: coop ? coop.id : null, producteur_id: null, date: d,
        quantite_kg: netDeclare && netDeclare > 0 ? Math.round(netDeclare) : 0, poids_brut: brutDeclare && brutDeclare > 0 ? brutDeclare : 0, nombre_sacs: sacsDeclares && sacsDeclares > 0 ? Math.round(sacsDeclares) : 0, connaissement: code, type_cacao: type,
        campagne_id: camp ? camp.id : null, periode: (mois >= 9 || mois <= 2) ? 'principale' : 'intermediaire',
        nom_transporteur: String(p.transporteur || '').trim() || null, immat_vehicule: String(p.immatriculation || '').trim() || null,
        usine_dechargement: String(p.magasin || '').trim() || null, lieu_origine: origine || null,
        fournisseur_saigic: String(p.fournisseur || '').trim() || null, code_fourn: String(p.code_fourn || '').trim() || null,
        declare_par_coop: false, genere_auto: false,
        ...maj, ...analyse,
      };
      bilan.plan.push({ code, action: 'creer', cooperative: coop?.nom || null });
      if (!coop) bilan.coop_inconnue.push(`${p.fournisseur || '?'} (${p.code_fourn || code.split('-')[0]})`);
      if (!dry) {
        const { error } = await sb.from('achats').upsert(nouvel, { onConflict: 'id', ignoreDuplicates: true });
        if (error) { bilan.erreurs.push(code + ' : ' + error.message); continue; }
      }
      bilan.creees++;
    }

    const { data: orph } = await sb.from('achats').select('id, code_fourn, connaissement, fournisseur_saigic').or('cooperative_id.is.null,cooperative_id.eq.').not('code_fourn', 'is', null);
    for (const o of (orph || []) as any[]) {
      let c = trouverCoop(String(o.connaissement || '').toUpperCase(), o.code_fourn, '', coops);
      if (!c) c = await creerCoop(sb, coops, { fournisseur: o.fournisseur_saigic, code_fourn: o.code_fourn }, dry, bilan);
      if (!c) continue;
      if (!dry) await sb.from('achats').update({ cooperative_id: c.id }).eq('id', o.id);
      bilan.rattachees++;
    }
    bilan.coop_inconnue = [...new Set(bilan.coop_inconnue)];
    return rep({ ok: true, dry_run: dry, ...bilan });
  } catch (e) {
    return rep({ error: String(e) }, 500);
  }
});
