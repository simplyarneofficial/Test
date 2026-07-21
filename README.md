# Moped Navigator

Eine installierbare Moped-Navigation als statische PWA. Das gesamte Repository kann mit GitHub Pages veröffentlicht werden. Es ist kein Node.js-, Docker- oder eigener Routingserver notwendig.

## Funktionen

- Kartenansicht mit OpenStreetMap
- Adresssuche in Deutschland
- aktueller Standort als Start
- öffentliches BRouter-Mopedprofil
- drei Routenalternativen
- Entfernung und geschätzte Fahrzeit
- Live-GPS-Navigation
- einfache Abbiegehinweise und deutsche Sprachansagen
- automatische Neuberechnung beim Verlassen der Route
- Installation auf dem Startbildschirm
- automatische Veröffentlichung mit GitHub Actions

## Auf GitHub hochladen

1. Erstelle ein neues leeres GitHub-Repository.
2. Lade den Inhalt dieses Hauptordners direkt in das Repository hoch. `index.html` muss oben im Repository liegen.
3. Öffne im Repository `Settings` und danach `Pages`.
4. Stelle unter `Build and deployment` die Quelle auf `GitHub Actions`.
5. Öffne den Tab `Actions` und warte, bis `GitHub Pages veröffentlichen` erfolgreich abgeschlossen ist.
6. Die Adresse steht danach unter `Settings` > `Pages`.

## Installation auf dem iPhone

1. Öffne die GitHub-Pages-Adresse in Safari.
2. Tippe auf Teilen.
3. Wähle `Zum Home-Bildschirm`.

Standort funktioniert nur über HTTPS. GitHub Pages verwendet automatisch HTTPS.

## Wichtige Grenzen

BRouter ist ein externer öffentlicher Routingdienst. Die Anwendung selbst liegt vollständig auf GitHub, die eigentliche Routenberechnung findet jedoch bei BRouter statt. Ein GitHub-Pages-Server kann selbst keine Routingengine ausführen.

Das öffentliche BRouter-Profil `moped` ist experimentell. OpenStreetMap-Einträge können fehlen oder falsch sein. Autobahnen, Kraftfahrtstraßen und andere Verbote können deshalb nicht mit rechtlicher Garantie ausgeschlossen werden. Die Beschilderung vor Ort hat immer Vorrang.

Die Schaltfläche `Bis 50` verwendet derzeit die dritte vom Server berechnete Moped-Alternative. Eine harte Sperre aller Straßen mit einem Tempolimit über 50 km/h ist mit dem öffentlichen Profil nicht garantiert. Dafür wäre später ein eigener BRouter-Server mit einem speziell angepassten Profil nötig.

Die automatisch erzeugten Abbiegehinweise werden geometrisch aus dem Routenverlauf berechnet. Straßennamen und komplexe Kreuzungen können daher ungenau sein.

## Verwendete Dienste

- OpenStreetMap-Kartenkacheln
- Nominatim-Adresssuche
- öffentlicher BRouter-Dienst
- Leaflet

Bitte die öffentlichen Dienste nicht für sehr viele automatisierte Anfragen oder eine große öffentliche Nutzerzahl verwenden.
