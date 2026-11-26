# Journal des versions — ExporTopo

## v1.5 — 26/11/2026
- **Emprises récentes** : menu déroulant en tête de l'étape 1 pour rappeler les 20 dernières emprises (géométrie, parcelles, réglages, nom de l'affaire), enregistrées à chaque prévisualisation et export, dans le navigateur. Bouton « Retirer ».
- **Fichier d'emprise** : « Enregistrer l'emprise (.geojson) » pour la partager, « Ouvrir un fichier d'emprise » pour la relire (Lambert-93 ou WGS84, dont le `emprise.geojson` d'un ancien ZIP, qui garde désormais l'affaire et les réglages).
- **Nom de l'affaire** (facultatif) : repris dans le cartouche, le nom du ZIP et du DXF, le LISEZMOI.
- **Surfaces d'après l'orthophoto** (plan détaillé) : espaces verts, chaussées, enrobés et trottoirs, parkings, stabilisé et gravier, cultures, eau et piscines, en polylignes fermées avec leur surface en m² (`SURF_*`). Sources : CoSIA IGN, orthophoto infrarouge, sursol LiDAR, BD TOPO, parkings OpenStreetMap.
- **Bilan des surfaces** dans la prévisualisation et `surfaces.csv` : m², %, surface imperméabilisée, coefficient de ruissellement indicatif.
- **Indice de confiance** vert / orange / rouge par objet (surfaces, arbres, haies, massifs, murs, cotes de bâtiment) ; objets à vérifier entourés avec le motif (`CTRL_A_VERIFIER`, `CTRL_CONFIANCE_MOYENNE`).
- **Changements probables** entre le vol LiDAR et l'orthophoto (`CTRL_CHANGEMENTS`) : bâtiment démoli ou construit, bâti absent de la BD TOPO, arbre abattu.
- Cartouche : affaire, date de l'orthophoto, millésime CoSIA, mention OpenStreetMap si utilisée. Légende complétée.
- **Fin du cache gênant** : les scripts sont appelés avec `?v=1.5` et la page vérifie `version.json` ; si une version plus récente est en ligne, un bandeau propose « Recharger ».
- Correction : la commune d'une zone précédente n'est plus reprise quand on trace une nouvelle zone ailleurs.

## v1.4 — 26/11/2026
- Nouveau type d'export **Plan TN détaillé**, au choix en tête de l'étape 2, avec son chapitre et ses réglages (sensibilité, hauteur minimale des arbres).
- Détection automatique sur le MNT et le MNS LiDAR HD : talus (crête, pied, barbules, hauteur), fossés et noues (fil d'eau coté, sens d'écoulement), lignes de crête, points hauts et bas, arbres (position, hauteur, houppier), haies, massifs boisés, murs et clôtures, cotes des bâtiments (hauteur, faîtage, TN au pied).
- Ajout des haies et constructions linéaires (murs, clôtures) de la BD TOPO.
- Mise en page du DXF : cartouche « non levé sur site » avec sources et dates, légende, flèche du nord, quadrillage Lambert-93.
- Prévisualisation : calques du plan détaillé en 2D et en 3D (arbres en volume), suppression d'un élément mal détecté par un clic, bouton « Rétablir ».
- Export : liste des arbres `arbres.csv` (n° X Y Z hauteur diamètre) et GeoJSON de chaque élément détecté.

## v1.3 — 11/11/2026
- Onglets en haut du panneau pour passer d'ExporTopo (terrain naturel) à ExporPaysage (insertion paysagère 3D) et inversement.

## v1.2 — 23/10/2026
- Logo agrandi à côté du titre (64 px au lieu de 40 px).
- Mention « By CHB » à côté du nom ExporTopo.

## v1.1 — 23/10/2026
- Nouveau nom : **ExporTopo** (fichier à ouvrir : `ExporTopo.html`), logo à côté du titre, orange RVB 220/110/45.
- Sous-titre : « Export des données publiques IGN en Lambert-93 / NGF-IGN69 ».
- Zone d'étude et parcelles sélectionnées en bleu #00B4FF ; sommets et poignées en rouge.
- Case « tout cocher / tout décocher » pour chaque chapitre du contenu de l'export et de la prévisualisation.
- Progression de la préparation en pourcentage, avec l'étape en cours.
- Aperçu allégé automatiquement quand la précision demandée est lourde (bandeau d'avertissement) ; l'export final est calculé à la précision demandée. Fichiers écrits par morceaux pour éviter les plantages.
- Échelle du plan jusqu'au 1/50 (1/50 et 1/75 ajoutés).
- Taille des repères de points du DXF selon le pas du semis : texte ≈ 20 % du pas (plafonné par l'échelle), croix ≈ 15 % du pas, décalage proportionnel.
- Export des points : `matricule X Y Z` séparés par un espace, sans en-tête ni code.
- Dates des données IGN dans l'aperçu et le LISEZMOI : vol et édition LiDAR HD, prise de vue de l'orthophoto, dernière mise à jour BD TOPO, date de consultation du cadastre.
- Grille d'altitudes calée sur la grille native IGN (centres de mailles sur les multiples de 0,50 m).

## v1.0 — 23/10/2026
- Première version : sélection de zone (rectangle, polygone, parcelles, emprise Lambert-93), poignées d'édition, prévisualisation 2D/3D, export DXF, CSV, LandXML, GeoJSON, ASC et orthophoto.
