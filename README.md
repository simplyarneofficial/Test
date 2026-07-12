# Tempo45 Navi

Installierbare Progressive Web App für Fahrzeuge mit 45 km/h Höchstgeschwindigkeit.

## Funktionen

- Start- und Zielsuche in Deutschland
- Aktueller Standort
- Mobile Karte mit Routenanzeige
- Fahrzeit mit realistischer 45-km/h-Geschwindigkeit
- PWA: auf iPhone und Android zum Home-Bildschirm hinzufügbar
- GraphHopper-Custom-Model: Motorway und Trunk werden ausgeschlossen, Geschwindigkeit wird auf 45 km/h begrenzt
- Kostenloser Demo-Modus zum Ausprobieren

## Wichtiger Sicherheitshinweis

Die Anwendung ist ein technischer Prototyp und ersetzt nicht die Straßenbeschilderung. In OpenStreetMap werden deutsche Kraftfahrstraßen oft mit `motorroad=yes` markiert. Ein öffentliches Standard-Routing erkennt dieses Merkmal nicht in jedem Fall. Prüfe die Route vor der Fahrt und beachte immer Verkehrszeichen.

Für eine wirklich zuverlässige Produktivversion sollte ein eigener Routing-Server eingerichtet werden, der `motorroad=yes`, `highway=motorway`, `highway=motorway_link` und alle für die Fahrzeugklasse geltenden Zugangsregeln strikt ausschließt.

## Direkt testen

Starte lokal einen kleinen Webserver, da Standort und Service Worker über `file://` nicht funktionieren:

```bash
python -m http.server 8080
```

Dann `http://localhost:8080` öffnen.

## GraphHopper aktivieren

1. Kostenlosen GraphHopper-API-Key erstellen.
2. In der App auf `Einstellungen` gehen.
3. `GraphHopper mit 45-km/h-Regeln` auswählen.
4. API-Key eintragen.

Der Key liegt nur im Local Storage des Gerätes. Bei einer öffentlich veröffentlichten reinen Frontend-App kann ein API-Key technisch ausgelesen werden. Für eine größere öffentliche Nutzung gehört der Key deshalb hinter einen eigenen kleinen Proxy oder einen selbst gehosteten Routing-Server.

## Auf GitHub Pages veröffentlichen

1. Neues GitHub-Repository erstellen.
2. Alle Dateien aus diesem Ordner hochladen.
3. Als Hauptbranch `main` verwenden.
4. Unter `Settings > Pages > Build and deployment` die Quelle `GitHub Actions` wählen.
5. Nach dem nächsten Push wird die App automatisch veröffentlicht.

## Als App auf dem iPhone installieren

1. Die veröffentlichte Seite in Safari öffnen.
2. Teilen-Symbol drücken.
3. `Zum Home-Bildschirm` wählen.

## Als App auf Android installieren

Die Seite in Chrome öffnen und im Browsermenü `App installieren` oder `Zum Startbildschirm hinzufügen` wählen.
