# ExporTopo

Outil web libre et gratuit pour préparer un **terrain naturel (TN)** d'étude VRD à partir des données publiques de l'IGN.
On choisit une zone sur la carte, on clique sur **Exporter**, et on récupère un ZIP prêt pour la CAO.

Aucun compte, aucun serveur : tout est calculé dans le navigateur à partir des services ouverts de la Géoplateforme IGN.

## Ce qu'il exporte

| Fichier | Contenu | Pour |
|---|---|---|
| `TN_<commune>_<date>.dxf` | Points TN 3D + altitudes, courbes de niveau (polylignes 3D), MNT en faces 3D, cadastre (parcelles, numéros, bâti, bornes), BD TOPO (bâtiments, axes de voirie 3D et noms, hydrographie, voies ferrées, végétation), emprise | AutoCAD, Covadis, Mensura, BricsCAD, Autopiste, QGIS |
| `points_TN.csv` | `matricule X Y Z` séparés par un espace, sans en-tête (ex. `1 651022.000 6861978.000 120.420`) | Import de points topo |
| `MNT_TN.xml` | Surface TIN LandXML 1.2 + points | Civil 3D, Covadis, Mensura, Trimble, Leica |
| `orthophoto.jpg` + `.jgw` + `.prj` | Photo aérienne calée en Lambert-93 | Fond de plan |
| `MNT_0_5m.asc` (option) | Grille altimétrique brute | QGIS, terrassement |
| `geojson/*.geojson` | Toutes les couches | QGIS |
| `LISEZMOI.txt` | Paramètres, sources, précision | Traçabilité |

Coordonnées : **RGF93 / Lambert-93 (EPSG:2154)**, altitudes **NGF-IGN69**. France métropolitaine.

## Utilisation

**Sur ton ordinateur :** décompresse le dossier et ouvre `ExporTopo.html` dans Chrome, Edge ou Firefox. Une connexion internet suffit.

**En ligne (gratuit) :** crée un dépôt GitHub avec ces fichiers, puis *Settings → Pages → Deploy from branch → main*. Le logiciel est servi sur `https://<ton-compte>.github.io/<depot>/ExporTopo.html`. Toute l'équipe utilise ce lien et a toujours la dernière version.

1. Recherche une adresse.
2. Trace un **rectangle** (2 clics), un **polygone** ou clique des **parcelles**. L'emprise peut aussi se saisir en coordonnées Lambert-93.
   - Polygone : un clic par sommet. Le premier sommet devient un rond orange qui pulse à partir du 3ᵉ point : clique dessus (ou Entrée, ou « Fermer le polygone ») pour fermer. Retour arrière annule le dernier point, Échap abandonne.
3. Ajuste la zone avec les poignées bleues, comme en CAO :
   - **carré** à chaque sommet : glisser pour déplacer, clic droit pour supprimer ;
   - **petit rectangle** au milieu de chaque côté : glisser pour étirer le côté (il reste parallèle, Maj pour le libérer) ou pour ajouter un sommet (bouton « Ajouter un sommet », ou Ctrl pendant le glisser).
4. Coche les couches, règle le pas du semis, l'équidistance et l'échelle du plan (hauteur des textes = 2 mm à l'échelle).
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
| Cadastre | WFS `https://data.geopf.fr/wfs/ows` | `CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle`, `:batiment`, `:borne_limite_propriete` |
| BD TOPO | WFS | `BDTOPO_V3:batiment`, `troncon_de_route`, `troncon_hydrographique`, `surface_hydrographique`, `troncon_de_voie_ferree`, `zone_de_vegetation` |
| Orthophoto | WMS-R | `HR.ORTHOIMAGERY.ORTHOPHOTOS` |
| Recherche d'adresse | `https://data.geopf.fr/geocodage/search` | |

Mention à porter sur les plans : **« Source : IGN »**.

## Précision

Le MNT LiDAR HD est précis à ~10 cm en terrain dégagé, moins sous végétation dense, sur talus raides, bordures et murets, ou si des travaux ont eu lieu après le vol. Le cadastre (PCI) est un document fiscal qui ne vaut pas bornage. Ces données servent la faisabilité, l'esquisse et l'APS ; un levé de géomètre reste nécessaire pour le PRO et l'exécution. Les réseaux enterrés ne sont pas des données publiques (DT/DICT obligatoires).

## Code

- `ExporTopo.html` : interface (logo et icône dans `assets/`).
- `js/core.js` : calculs sans dépendance (semis de points, interpolation bilinéaire, courbes par marching squares, TIN, écrivains DXF R12 / CSV / LandXML / ASC / GeoJSON). Testable sous Node : `node -e "const T=require('./js/core.js')"`.
- `js/app.js` : carte Leaflet, tracé et poignées d'édition, appels aux services IGN, assemblage du ZIP.
- `js/preview.js` : fenêtre de prévisualisation (plan 2D sur canvas, terrain 3D avec three.js).

Bibliothèques chargées depuis un CDN : Leaflet, proj4js, JSZip, geotiff.js, three.js.

## Versions

Le numéro de version est affiché sous le titre et écrit dans chaque `LISEZMOI.txt` exporté. Le détail des changements est dans `CHANGELOG.md`.

## Licence

MIT — voir `LICENSE`.
