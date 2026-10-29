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

Beide Anwendungen installieren dieses Repository als Git-Abhängigkeit. Ihre `package.json` verweist auf dieselbe vollständige Commit-SHA, beispielsweise nach diesem Schema:

```json
{
  "dependencies": {
    "@stackfriends/shared": "github:Tom-Gries/MuStackShared#<vollständige-Commit-SHA>"
  }
}
```

Der Platzhalter wird durch den konkreten getesteten Commit ersetzt. Jeder Anwendungsstand und seine eingecheckte `package-lock.json` behalten dadurch eine feste Regelversion. Ein späterer Push dieses Repositories ändert bestehende Frontend- oder API-Deployments erst, wenn deren Abhängigkeit bewusst aktualisiert wird.

Importe bleiben paketbezogen:

```js
import { createWorld, applyCommand } from '@stackfriends/shared/game.js';
import { getCatalog } from '@stackfriends/shared/catalog.js';
```

Das Paket wird ausschließlich über Git bezogen. `private: true` schützt vor versehentlichem Veröffentlichen in einer npm-Registry. Die Paketdateien umfassen die JavaScript-Module; die Tests bleiben im Quellrepository.

## Gemeinsame Regeln ändern

1. Regeln und passende Tests in diesem Repository ändern und lokal prüfen.
2. Den geprüften Stand committen und nach GitHub pushen.
3. Die vollständige Commit-SHA in den Abhängigkeiten von Frontend und API gemeinsam aktualisieren und die jeweiligen Lockdateien mit npm erneuern.
4. Beide Anwendungen testen und ihre Änderungen separat committen und pushen.

Karten und Rezepte, die während des Spiels im Editor geändert werden, gehören weiterhin zum gespeicherten Weltkatalog. Dieses Paket enthält die gemeinsamen Standarddefinitionen und die Regelausführung.

## Vercel

Für dieses Repository wird kein eigenes Vercel-Projekt angelegt. Frontend und API installieren ihre festgelegte Git-Abhängigkeit während `npm ci` und verwenden die Module in ihren jeweiligen Builds beziehungsweise Serverfunktionen. Ein daneben ausgecheckter `shared`-Ordner und Dateien außerhalb ihres Vercel-Repository-Hauptordners sind dafür nicht erforderlich.
