# Journal des versions — ExporTopo

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
