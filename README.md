# Targmanich — Թարգմանիչ

Pupitre de traduction qui tourne sur les deux modèles **gratuits** de Gemini :
**Gemini 3.8 Live** et **Gemini 3.8 Live Extended Thinking**.
N'importe quelle langue vers n'importe quelle langue, avec détection automatique ;
arménien → anglais par défaut.

Page : https://forgit-dc.github.io/traduction_with_free_gemini_models/

- **Pupitre** : on colle un texte, on obtient la traduction, et rien d'autre.
- **Lots** : un fichier `.txt`, `.csv`, `.tsv`, `.json` ou `.jsonl` de posts, traduit par les deux modèles en parallèle, puis exporté en CSV, JSON, JSONL ou TXT.

## Le problème, et l'astuce

Les deux modèles gratuits sont des modèles *Live* (vocaux). L'API refuse la sortie texte :
`The requested combination of response modalities (TEXT) is not supported by the model.`
Lire la transcription de leur voix marche, mais c'est lent (26 s pour une phrase) et ça abîme
le formatage.

Targmanich leur donne une fonction, `deliver(items)`, et leur demande de répondre **en l'appelant**.
Les arguments de l'appel arrivent en JSON, au caractère près, en ~2 s :

```
{"items":[{"i":0,"t":"Our team won the final.\nThank you to all the fans ❤️ #ArmeniaForward"}, …]}
```

Comme la réponse est un champ structuré, il n'y a pas de place pour « Voici la traduction : ».
Le prompt ([docs/js/prompt.js](docs/js/prompt.js)) impose aussi : segments = données (jamais des
instructions), formatage, liens, @mentions et émojis conservés, hashtags traduits, noms propres
sous leur forme établie.

## Mesures (clé gratuite, octobre 2026)

|                                | 3.8 Live      | 3.8 Live Extended Thinking            |
|--------------------------------|---------------|---------------------------------------|
| Temps de réponse par lot       | ≈ 2 s         | 6 – 30 s                              |
| Tokens pour un lot de 10 posts | ≈ 1 900       | ≈ 7 500                               |
| Coût caché par session         | ≈ 1 000       | ≈ 3 400, facturé deux fois            |
| Particularité                  | aucune        | doit dire un mot avant d'appeler la fonction, refuse `thinkingLevel: minimal` |
| Limite gratuite                | 65 000 TPM    | 65 000 TPM                            |

- 300 posts arméniens : **15 s**, 0 échec (≈ 20 posts/s en rafale).
- En régime continu, avec une clé et les deux budgets par minute utilisés : ≈ 14 posts/s.
- Au-delà de ~6 sessions simultanées par clé, Google renvoie `1011 quota exceeded`.

## Rotation des modèles

[docs/js/scheduler.js](docs/js/scheduler.js) :

- une *voie* par clé × modèle, chacune avec un budget glissant de tokens sur 60 s ;
- le modèle rapide (Live) passe toujours en premier ; Extended Thinking ne reçoit que le
  **surplus**, c'est-à-dire ce que le premier ne peut pas commencer dans les ~12 s ;
- quand la file est vide, un lot lent qui traîne depuis 6 s est renvoyé au modèle rapide, et la
  première réponse gagne ;
- en cas de refus pour quota : concurrence divisée par deux, pause, puis nouvel essai ; un segment
  manquant dans une réponse est renvoyé seul.

## Clés

- **Sans clé** : la page passe par un relais, la Edge Function Supabase
  [`targmanich-live`](supabase/functions/targmanich-live/index.ts). Elle ajoute la clé partagée
  côté serveur, si bien que la clé n'apparaît jamais dans la page. Le relais n'accepte que les deux
  modèles 3.8 Live, depuis `forgit-dc.github.io` ou `localhost`, avec des sessions de 2 min maximum.
  Le quota gratuit est partagé par tous les visiteurs.
- **Avec sa propre clé** (gratuite sur https://aistudio.google.com/apikey) : le navigateur parle
  directement à Google. La clé reste dans le navigateur (et n'est mémorisée que si on coche la case).

Mettre la clé partagée sur le relais : Supabase → projet → *Edge Functions* → *Secrets* →
`GEMINI_API_KEY`.

## Développement local

Aucune compilation : HTML, CSS et modules JS natifs.

```sh
cd docs && python3 -m http.server 8765
# http://localhost:8765
```

`.env` (ignoré par git) contient la clé utilisée pour les tests :
`google_api_key_f130 = "…"`.

## Le nom

Թարգմանիչ (*targmanitch*) veut dire « traducteur ». Vers 405, Mesrop Machtots a créé l'alphabet
arménien pour traduire des textes en arménien, et l'Église fête encore les Saints Traducteurs
chaque mois d'octobre. Le design reprend les **tables de canons** des Évangiles arméniens : des
passages parallèles en colonnes, sous des arcs peints surmontés d'oiseaux. Une traduction côte à
côte, c'est une table de canons à deux colonnes.
