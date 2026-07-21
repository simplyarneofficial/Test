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
- beliebig viele Zwischenstopps mit Sortieren und Löschen
- Start und Ziel tauschen
- Routenübersicht während der Navigation
- Sprachansagen ein- und ausschalten
- letzte Ziele lokal auf dem Gerät speichern

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

## Live-Navigationsansicht

Nach dem Start der Navigation zeigt die App einen GPS-Positionspfeil, der sich nach der Fahrtrichtung dreht. Die Karte folgt dem aktuellen Standort. Oben stehen der nächste Abbiegeschritt und die Entfernung bis dorthin. Unten stehen Restzeit, voraussichtliche Ankunft, Reststrecke und aktuelle GPS-Geschwindigkeit. Beim Verschieben der Karte kann sie mit "Zentrieren" wieder an den Standort gekoppelt werden. Verlässt man die Route deutlich, wird sie automatisch neu berechnet.


## Querformat

Während der Navigation wird im Querformat die Abbiegeanzeige links als schmale Seitenleiste dargestellt. Restzeit, Ankunft, Reststrecke und Geschwindigkeit liegen kompakt unten rechts. Die Kartenposition wird leicht versetzt, damit der vorausliegende Routenabschnitt besser sichtbar bleibt.


## Version 4

Während der Live-Navigation wird die Karte automatisch nach der aktuellen Fahrtrichtung gedreht. Die Route verläuft dadurch immer nach oben, senkrecht zum unteren Bildschirmrand. Der Fahrzeugpfeil bleibt aufrecht und auf der Route eingerastet.


## Version 5

Zwischenstopps können vor der Berechnung hinzugefügt, entfernt und in ihrer Reihenfolge verschoben werden. BRouter erhält Start, alle Zwischenstopps und Ziel in einer gemeinsamen Anfrage. Bei einer automatischen Neuberechnung werden nur noch die Stopps verwendet, die auf der restlichen Route vor dem Fahrzeug liegen. Zusätzlich gibt es eine Routenübersicht, eine Stummschaltung für Sprachansagen, eine Tauschen-Funktion für Start und Ziel sowie lokal gespeicherte letzte Ziele.

## Version 6 - Redesign und realistischere Fahrzeit

- Vollständig neues responsives Design für Hoch- und Querformat
- Sichere Abstände für iPhone-Notch, Dynamic Island und Home-Indikator
- Aufgeräumte Navigationselemente ohne überlaufende Buttons
- Bestätigungsdialog zum Beenden der Navigation
- Fahrzeitmodell speziell für 45-km/h-Fahrzeuge
- Fahrzeiten berücksichtigen Ortschaften, Ampeln, Abbiegungen und Zwischenstopps
- Modernere Routenübersicht, Navigationskarten und Bedienelemente

Die ETA ist eine Schätzung. Verkehr, Baustellen und längere Stopps sind nicht live enthalten.
