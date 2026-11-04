# StackFriends – gemeinsame Spielregeln

Dieses Repository enthält das gemeinsame JavaScript-Paket `@stackfriends/shared` für [MuStack](https://github.com/Tom-Gries/MuStack) und [MuStackAPI](https://github.com/Tom-Gries/MuStackAPI).

Hier werden Karten, Pakete und Rezepte, Spielaktionen, Weltzeit, Kreaturen und Kampfregeln gepflegt. Die Module benötigen weder eine Datenbank noch zusätzliche npm-Pakete.

## Lokal prüfen

Node.js ab Version 22. Im Repository-Hauptordner:

```sh
npm ci
npm test
npm run check
```

Die Tests prüfen die Regeln direkt mit isolierten Weltzuständen. Sie verbinden sich nicht mit der gemeinsamen Datenbank und ändern keine lokalen Spielstände. GitHub Actions führt diese Prüfungen bei Pushes und Pull Requests ebenfalls mit Node.js 22 aus.

## In Frontend und API verwenden

Beide Anwendungen installieren ein öffentliches HTTPS-Archiv dieses Repositories. Ihre `package.json` verweist auf dieselbe vollständige Commit-SHA mit 40 Zeichen:

```json
{
  "dependencies": {
    "@stackfriends/shared": "https://codeload.github.com/Tom-Gries/MuStackShared/tar.gz/<commit-sha>"
  }
}
```

Der Platzhalter wird durch den konkreten getesteten Commit ersetzt. Jeder Anwendungsstand und seine eingecheckte `package-lock.json` behalten dadurch eine feste Regelversion. Ein späterer Push dieses Repositories ändert bestehende Frontend- oder API-Deployments erst, wenn deren Abhängigkeit bewusst aktualisiert wird.

Importe bleiben paketbezogen:

```js
import { createWorld, applyCommand } from '@stackfriends/shared/game.js';
import { getCatalog } from '@stackfriends/shared/catalog.js';
```

Das Archiv wird per HTTPS ohne SSH-Schlüssel oder Zugangstoken geladen. `package-lock.json` hält zusätzlich die Integritätsprüfung des Archivs fest. `private: true` schützt vor versehentlichem Veröffentlichen in einer npm-Registry.

## Gemeinsame Regeln ändern

1. Regeln und passende Tests in diesem Repository ändern und lokal prüfen.
2. Den geprüften Stand committen und nach GitHub pushen.
3. In Frontend und API denselben Commit installieren und damit die jeweiligen Lockdateien erneuern:

   ```sh
   npm install '@stackfriends/shared@https://codeload.github.com/Tom-Gries/MuStackShared/tar.gz/<commit-sha>'
   ```

4. Beide Anwendungen testen und ihre Änderungen separat committen und pushen.

Karten, Pakete und Rezepte aus dem Editor gehören zum zentralen Katalog. Die API übernimmt diesen Katalog in die persönlichen Welten; deren Fortschritt bleibt pro Spieler getrennt.

## Persönliche Welten und Geschenke

`personal-world.js` ergänzt die Spielregeln um reine Funktionen ohne Datenbankzugriffe:

- `createPersonalWorld(player, catalog, now)` erstellt genau einen Menschen für `player.id` sowie das Startgold für drei Basicpakete. Die Welt-ID ist die Spieler-ID.
- `summarizeMaterials(world)` zählt die Karten für die Spielerübersicht, einschließlich eingelagerten Ressourcen und Essens. Menschen und Leichen werden ausgelassen; Gold im Sparschwein zählt zum Goldbestand.
- `takeGiftCards(world, selection, now)` entfernt eine Drag-Auswahl atomar und liefert übertragbare Karten. Standardmäßig werden die gewählte Karte und alle darüberliegenden Karten genommen. Menschen, Leichen, angreifende Lebewesen, ausgerüstete Werkzeuge und Teilnehmer laufender Arbeiten oder Kämpfe sind gesperrt.
- `receiveGiftCards(world, cards, now)` liefert Geschenke atomar mit neuen Karten- und Stapel-IDs in eine persönliche Welt. Karteninhalt, verbleibende Quellen-Nutzungen, Paketinhalt, Leben und Erntefrist bleiben erhalten. Bewegungsbahnen und Verweise in die Absenderwelt werden verworfen.
- `ensurePersonalCatalog(catalog)` ergänzt in älteren zentralen Katalogen die Rathauskarte und das Rezept aus 100 Stein, ohne angepasste Definitionen zu ersetzen. Ein Mensch baut das Rathaus nach 60 Sekunden Spielzeit fertig.

Die API verwaltet Identität, Berechtigungen, Transaktionen, Revisionen und den Geschenk-Posteingang. Die Funktionen eröffnen selbst keine Verbindung und starten keinen Timer.

## Kisten

Zehn Holz ergeben nach zehn Sekunden ohne Menschen eine Kiste. Ressourcen und Essen werden per `move` auf die Kiste oder per `{ type: 'store', cardId: kistenId, itemId, split, takeAbove }` eingelagert. Die vollständigen Karten bleiben mit ihrer ID und ihrem Zustand in `chest.contents` erhalten und liegen währenddessen nicht auf dem Tisch. Gelagerte Karten nehmen nicht an Rezepten oder laufenden Arbeiten teil.

`{ type: 'retrieve', cardId: kistenId, itemId, x?, y?, allOfType? }` legt eine Karte wieder auf den Tisch; `allOfType: true` entnimmt alle Karten desselben Typs als Stapel. Ohne Position findet die Engine einen freien Platz neben der Kiste. Gefüllte Kisten lassen sich weder verkaufen, verschenken noch als Zutat verbrauchen. Ihre Inhalte werden bei globalen Katalogänderungen geschützt. Kisten können nicht ineinander gelagert werden.

## Arbeit während der Abwesenheit

`advancePersonalWorld(world, now, { activeUntil, rng })` berechnet zuerst die aktive Spielzeit mit `advanceWorld` und holt anschließend die Arbeit während der Abwesenheit nach. Abbau, Quellenwarteschlangen, Werkzeuge und Bau verwenden die tatsächlich vergangenen Zeitabschnitte. Quellen werden vollständig verbraucht; Menschen bleiben nach einem Bau erhalten. Erntefristen beginnen beim historischen Herstellungszeitpunkt.

Kämpfe und Kreaturbewegungen pausieren außerhalb der aktiven Spielzeit. Ihre verbleibenden Angriffs- und Bewegungszeiten bleiben nach der Rückkehr erhalten. Feldwachstum wird weiterhin nach Echtzeit berechnet und sammelt höchstens eine ungeerntete Ernte an.

Es gibt dafür keine Server-Timer oder laufenden Netzwerkanfragen. Die aufrufende API persistiert den neuen Stand atomar. Wie beim bestehenden Weltvorschub werden außergewöhnliche Rückstände über 100.000 Ereignisse mit einem Fehler abgebrochen; Zeit wird dabei nicht stillschweigend abgeschnitten. Diese Grenze betrifft insbesondere unbegrenzt wiederholende eigene Editorrezepte.

## Lokale Simulation und gebündeltes Speichern

`local-simulation.js` stellt dieselbe Simulation für Browser und Speicherprüfung bereit. `initializeLocalSimulation(world)` ergänzt bei älteren Welten einen aus der Welt-ID abgeleiteten Zufallszustand. Bereits gespeicherte Zufallsergebnisse werden nicht verändert.

`applySimulationOperation(world, operation, { playerId })` verarbeitet eine lokale Aktion sofort und atomar. Jede Operation enthält `kind` (`advance` oder `command`), `at`, `activeUntil` und gegebenenfalls `command`. Abbau, Kampf, Paketergebnisse und erzeugte IDs verwenden einen gespeicherten Zufallsstrom. Ein Fehler verwirft auch den Zeitvorschub und verbrauchte Zufallswerte dieser Aktion. Globale Katalogänderungen gehören weiterhin in den gesonderten API-Ablauf.

Beim Speichern prüft `replaySimulationBatch(world, operations, { playerId, maxTime })` höchstens 500 aufgezeichnete Engine-Aufrufe in derselben Reihenfolge. Die Anwendung zeichnet Ereignisse und Checkpoints auf, keine Animationsbilder. Der Batch ergänzt keinen weiteren Zeitvorschub; alle Zeiten sind ausdrücklich enthalten. Bei einer ungültigen Aktion bleibt der gesamte Ausgangsstand erhalten. Versionsprüfung, Wiederholschutz und Geschenke verwaltet die API.

## Vercel

Für dieses Repository wird kein eigenes Vercel-Projekt angelegt. Frontend und API installieren ihr festgelegtes HTTPS-Archiv während `npm ci` und verwenden die Module in ihren jeweiligen Builds beziehungsweise Serverfunktionen. Ein daneben ausgecheckter `shared`-Ordner und Dateien außerhalb ihres Vercel-Repository-Hauptordners sind dafür nicht erforderlich.
