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

## Sprachausgabe

Die Navigation nutzt die im Gerät vorhandene deutsche Systemstimme. Ansagen erfolgen ungefähr 500 Meter, 200 Meter und unmittelbar vor dem Abbiegen. Zusätzlich werden Navigationstart, Neuberechnung, Zwischenstopps und Zielankunft angesagt. Stimme, Lautstärke und Tempo lassen sich während der Navigation über **Stimme** einstellen. Auf iPhone muss die erste Sprachausgabe gegebenenfalls durch einen direkten Fingertipp freigeschaltet werden.

## Verbesserte Abbiegehinweise (V8)

Die App erkennt Richtungsänderungen jetzt distanzbasiert entlang der gesamten Route. Dadurch werden auch kurze, direkt aufeinanderfolgende und leichte Abbiegungen deutlich zuverlässiger angezeigt und angesagt. Unter dem aktuellen Manöver wird zusätzlich das danach folgende Manöver eingeblendet. Da der öffentliche BRouter-Endpunkt in dieser Konfiguration keine vollständigen straßennamengenauen Manöver liefert, werden die Hinweise weiterhin aus der Routengeometrie berechnet. Beschilderung und Straßenverlauf vor Ort haben Vorrang.
