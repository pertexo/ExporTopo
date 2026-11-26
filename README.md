# ExporTopo

Outil web libre et gratuit pour préparer un **terrain naturel (TN)** d'étude VRD à partir des données publiques de l'IGN.
On choisit une zone sur la carte, on clique sur **Exporter**, et on récupère un ZIP prêt pour la CAO.

Aucun compte, aucun serveur : tout est calculé dans le navigateur à partir des services ouverts de la Géoplateforme IGN.

## Ce qu'il exporte

| Fichier | Contenu | Pour |
|---|---|---|
| `TN_<affaire ou commune>_<date>.dxf` | Points TN 3D + altitudes, courbes de niveau (polylignes 3D), MNT en faces 3D, cadastre (parcelles, numéros, bâti, bornes), BD TOPO (bâtiments, axes de voirie 3D et noms, hydrographie, voies ferrées, végétation), emprise | AutoCAD, Covadis, Mensura, BricsCAD, Autopiste, QGIS |
| `points_TN.csv` | `matricule X Y Z` séparés par un espace, sans en-tête (ex. `1 651022.000 6861978.000 120.420`) | Import de points topo |
| `MNT_TN.xml` | Surface TIN LandXML 1.2 + points | Civil 3D, Covadis, Mensura, Trimble, Leica |
| `orthophoto.jpg` + `.jgw` + `.prj` | Photo aérienne calée en Lambert-93 | Fond de plan |
| `MNT_0_5m.asc` (option) | Grille altimétrique brute | QGIS, terrassement |
| `surfaces.csv` (plan détaillé) | Bilan des surfaces : m², %, surface imperméabilisée, coefficient de ruissellement indicatif | Excel, note hydraulique |
| `geojson/*.geojson` | Toutes les couches ; `emprise.geojson` se rouvre dans ExporTopo | QGIS |
| `LISEZMOI.txt` | Paramètres, sources, précision | Traçabilité |

Coordonnées : **RGF93 / Lambert-93 (EPSG:2154)**, altitudes **NGF-IGN69**. France métropolitaine.

## Plan TN détaillé (option)

Choisir **Plan TN détaillé** au début de l'étape 2 ajoute au DXF un relevé automatique issu du MNT et du MNS LiDAR HD :

| Élément | Calques DXF |
|---|---|
| Talus : crête, pied (polylignes 3D), barbules longues et courtes, hauteur | `TN_TALUS_CRETE`, `TN_TALUS_PIED`, `TN_TALUS_BARBULES`, `TN_TALUS_TEXTE` |
| Fossés et noues : axe 3D au fil d'eau, cotes « FE », sens d'écoulement | `TN_FOSSES_NOUES`, `TN_FOSSES_FIL_EAU`, `TN_FOSSES_SENS` |
| Lignes de crête, points hauts et bas cotés | `TN_LIGNES_CRETE`, `TN_POINTS_HAUTS_BAS` |
| Arbres : bloc de houppier à l'échelle, tronc, « h hauteur Ø diamètre » ; liste `arbres.csv` | `VEG_ARBRES`, `VEG_ARBRES_TRONC`, `VEG_ARBRES_TEXTE` |
| Haies (LiDAR et BD TOPO), massifs boisés | `VEG_HAIES_LIDAR`, `VEG_HAIES_IGN`, `VEG_MASSIFS_BOISES` |
| Murs et clôtures détectés (indicatif), constructions linéaires BD TOPO | `OUV_MURS_CLOTURES_LIDAR`, `OUV_CONSTRUCTIONS_IGN` |
| Cotes des bâtiments : hauteur, faîtage, TN au pied | `BAT_COTES` |
| Cartouche « non levé sur site », légende, nord, quadrillage Lambert-93 | `CARTOUCHE`, `LEGENDE`, `NORD`, `QUADRILLAGE` |

### Surfaces d'après l'orthophoto (v1.5)

| Surface | Calque DXF |
|---|---|
| Espaces verts : pelouses, massifs, boisements | `SURF_ESPACES_VERTS` |
| Chaussées (largeur de la BD TOPO), enrobés, bétons, trottoirs | `SURF_CHAUSSEE`, `SURF_ENROBE` |
| Parkings (contours BD TOPO et OpenStreetMap recoupés avec l'orthophoto) | `SURF_PARKING` |
| Stabilisé, gravier, terre | `SURF_PERMEABLE` |
| Cultures et vignes ; eau et piscines | `SURF_CULTURES`, `SURF_EAU` |
| Surface en m² de chaque polygone | `SURF_TEXTE` |

Polylignes fermées (les îlots, bâtiments compris, sont des polylignes séparées : la commande Hachures les reconnaît). Le classement vient de **CoSIA** (occupation du sol calculée par l'IGN sur l'orthophoto), recoupé avec l'orthophoto infrarouge (NDVI), la hauteur du sursol LiDAR et la BD TOPO. Sans CoSIA sur la zone, l'infrarouge et la couleur prennent le relais. Le bilan (prévisualisation et `surfaces.csv`) donne la surface imperméabilisée et un coefficient de ruissellement indicatif.

### Contrôle de cohérence (v1.5)

- **Indice de confiance** vert / orange / rouge pour chaque surface, arbre, haie, massif et mur : accord entre LiDAR, infrarouge et CoSIA. Les objets douteux sont entourés en rouge avec le motif (`CTRL_A_VERIFIER`), les moyens en orange (`CTRL_CONFIANCE_MOYENNE`). Champ `confiance` dans les GeoJSON.
- **Changements probables** entre la date du vol LiDAR et celle de l'orthophoto (`CTRL_CHANGEMENTS`) : bâtiment de la BD TOPO absent du LiDAR (démoli ou récent), bâti visible absent de la BD TOPO et du cadastre, volume LiDAR disparu de l'orthophoto. Un bâtiment démoli ne fait plus de trou dans les surfaces.

Réglages : sensibilité des talus et fossés (faible, moyenne, forte), hauteur minimale d'un arbre. Dans la prévisualisation 2D, un clic sur un élément détecté le retire de l'export (« Rétablir » pour annuler).

Limites : détection automatique à contrôler. Les talus et fossés sous couvert boisé dense, les clôtures légères, bordures, regards et réseaux ne sont pas fiables ou pas visibles dans le LiDAR.

## Utilisation

**Sur ton ordinateur :** décompresse le dossier et ouvre `ExporTopo.html` dans Chrome, Edge ou Firefox. Une connexion internet suffit.

**En ligne (gratuit) :** crée un dépôt GitHub avec ces fichiers, puis *Settings → Pages → Deploy from branch → main*. Le logiciel est servi sur `https://<ton-compte>.github.io/<depot>/ExporTopo.html`. Toute l'équipe utilise ce lien et a toujours la dernière version.

1. Recherche une adresse, ou rappelle une emprise déjà utilisée dans **Emprises récentes** (les 20 dernières, avec leurs réglages et le nom de l'affaire, gardées dans ce navigateur). **Ouvrir un fichier d'emprise** relit un `.geojson` (Lambert-93 ou WGS84), dont le `geojson/emprise.geojson` d'un ancien ZIP ; **Enregistrer l'emprise** en fait un fichier à partager avec l'équipe.
2. Trace un **rectangle** (2 clics), un **polygone** ou clique des **parcelles**. L'emprise peut aussi se saisir en coordonnées Lambert-93.
   - Polygone : un clic par sommet. Le premier sommet devient un rond orange qui pulse à partir du 3ᵉ point : clique dessus (ou Entrée, ou « Fermer le polygone ») pour fermer. Retour arrière annule le dernier point, Échap abandonne.
3. Ajuste la zone avec les poignées bleues, comme en CAO :
   - **carré** à chaque sommet : glisser pour déplacer, clic droit pour supprimer ;
   - **petit rectangle** au milieu de chaque côté : glisser pour étirer le côté (il reste parallèle, Maj pour le libérer) ou pour ajouter un sommet (bouton « Ajouter un sommet », ou Ctrl pendant le glisser).
4. Donne un **nom d'affaire** (facultatif) : il est repris dans le cartouche et le nom des fichiers. Coche les couches, règle le pas du semis, l'équidistance et l'échelle du plan (hauteur des textes = 2 mm à l'échelle).
5. **Prévisualiser la zone** : les données sont récupérées puis affichées
   - en **plan 2D** (molette pour zoomer, glisser pour déplacer, double-clic pour recadrer, coordonnées X Y Z sous la souris) ;
   - en **terrain 3D** (clic gauche tourner, clic droit déplacer, molette zoom, curseur d'exagération du relief).
6. Décoche dans la liste ce qui ne doit pas partir, puis **Exporter la version finale** : le ZIP se télécharge avec seulement les calques retenus.

Limites : 4 km² d'emprise, 400 000 points. Au-delà de ~2 km² le MNT passe automatiquement au pas de 1 m.

## Sources (Géoplateforme IGN, Licence Ouverte Etalab 2.0)

| Donnée | Service | Couche |
|---|---|---|
| MNT LiDAR HD 0,50 m (Float32) | WMS-R `https://data.geopf.fr/wms-r/wms` | `IGNF_LIDAR-HD_MNT_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` |
| RGE ALTI 1 m (bouche-trous) | WMS-R | `ELEVATION.ELEVATIONGRIDCOVERAGE.HIGHRES` |
| MNS LiDAR HD 0,50 m (sursol : arbres, bâti) | WMS-R | `IGNF_LIDAR-HD_MNS_ELEVATION.ELEVATIONGRIDCOVERAGE.LAMB93` |
| Cadastre | WFS `https://data.geopf.fr/wfs/ows` | `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle`, `:batiment`, `:borne_limite_propriete` |
| BD TOPO | WFS | `BDTOPO_V3:batiment`, `troncon_de_route`, `troncon_hydrographique`, `surface_hydrographique`, `troncon_de_voie_ferree`, `zone_de_vegetation` |
| Orthophoto | WMS-R | `HR.ORTHOIMAGERY.ORTHOPHOTOS` |
| Orthophoto infrarouge (NDVI) | WMS-R | `ORTHOIMAGERY.ORTHOPHOTOS.IRC` |
| Occupation du sol CoSIA | WMS-R | `IGNF_COSIA_2024-2026`, `IGNF_COSIA_2021-2023`, `IGNF_COSIA_2017-2020` |
| Parkings, haies, murs | WFS | `BDTOPO_V3:equipement_de_transport`, `haie`, `construction_lineaire` |
| Parkings (complément) | Overpass API OpenStreetMap | `amenity=parking` (© contributeurs OpenStreetMap, ODbL) |
| Recherche d'adresse | `https://data.geopf.fr/geocodage/search` | |

Mention à porter sur les plans : **« Source : IGN »**.

## Précision

Le MNT LiDAR HD est précis à ~10 cm en terrain dégagé, moins sous végétation dense, sur talus raides, bordures et murets, ou si des travaux ont eu lieu après le vol. Le cadastre (PCI) est un document fiscal qui ne vaut pas bornage. Ces données servent la faisabilité, l'esquisse et l'APS ; un levé de géomètre reste nécessaire pour le PRO et l'exécution. Les réseaux enterrés ne sont pas des données publiques (DT/DICT obligatoires).

## Code

- `ExporTopo.html` : interface (logo et icône dans `assets/`).
- `js/core.js` : calculs sans dépendance (semis de points, interpolation bilinéaire, courbes par marching squares, TIN, écrivains DXF R12 / CSV / LandXML / ASC / GeoJSON). Testable sous Node : `node -e "const T=require('./js/core.js')"`.
- `js/app.js` : carte Leaflet, tracé et poignées d'édition, appels aux services IGN, assemblage du ZIP.
- `js/preview.js` : fenêtre de prévisualisation (plan 2D sur canvas, terrain 3D avec three.js).
- `js/plan.js` : plan TN détaillé (détection des talus, fossés, arbres, haies, murs, cotes ; calques DXF et mise en page). Testable sous Node.
- `js/surfaces.js` : surfaces d'après l'orthophoto (décodage CoSIA, NDVI, vectorisation, m²), indice de confiance, changements. Testable sous Node.
- `version.json` : numéro de la version publiée. La page le relit sans cache et propose « Recharger » quand une nouvelle version est en ligne.

Bibliothèques chargées depuis un CDN : Leaflet, proj4js, JSZip, geotiff.js, three.js.

## Versions

Le numéro de version est affiché sous le titre et écrit dans chaque `LISEZMOI.txt` exporté. Le détail des changements est dans `CHANGELOG.md`.

À chaque publication : changer `VERSION` dans `js/core.js`, les `?v=` des scripts dans `ExporTopo.html` et `version.json`. Les postes qui ont encore l'ancienne version en cache voient un bandeau « Nouvelle version disponible — Recharger ».

## Licence

MIT — voir `LICENSE`.
