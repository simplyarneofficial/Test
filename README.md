# Moped Navigator

Komplett neu aufgebaute, installierbare Web-App für Mopeds, Roller und Fahrzeuge mit niedriger Höchstgeschwindigkeit.

## Funktionen

- neue responsive Benutzeroberfläche
- Routenplanung mit Start und Ziel
- drei Routenprofile
- Live-GPS-Navigation
- geglätteter Fahrzeugmarker und Geschwindigkeitsanzeige
- Abbiegungen, scharfe und leichte Kurven sowie Kreisverkehre
- Sprachansagen bei 5 km, 1 km, 500 m, 250 m, 100 m, 50 m und 10 m
- nur das nächste Manöver wird auf der Karte hervorgehoben
- Restzeit, Ankunftszeit und Reststrecke
- installierbar als Progressive Web App

## GitHub Pages

Alle Dateien in ein GitHub-Repository hochladen. Danach unter `Settings` → `Pages` den Branch `main` und `/root` auswählen.

Die Anwendung muss über HTTPS geöffnet werden, damit GPS und PWA-Funktionen zuverlässig verfügbar sind.

## Verwendete Dienste

- OpenStreetMap für die Karte
- Nominatim für die Adresssuche
- öffentlicher OSRM-Demodienst für die Route

Öffentliche Demodienste können zeitweise langsam sein. Für einen dauerhaften öffentlichen Betrieb sollte später ein eigener Routingdienst eingesetzt werden.

## Wichtiger Hinweis

Die App kann Kraftfahrstraßen und lokale Zufahrtsbeschränkungen nicht garantiert vollständig erkennen. Verkehrszeichen und die tatsächliche Beschilderung vor Ort haben immer Vorrang.
