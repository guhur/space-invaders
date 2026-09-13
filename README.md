# space-invaders

Carte perso des space invaders : ce que j'ai flashé aujourd'hui (ou un autre jour), ce qu'il reste à flasher autour de moi, avec un bouton pour rafraîchir les scans.

- **Front** : Vite + TypeScript + Leaflet (`src/`), tuiles OpenStreetMap.
- **API** : un Worker Cloudflare (`worker/index.ts`) qui sert les fichiers statiques et deux routes :
  - `GET /api/gallery` interroge l'API FlashInvaders avec l'UID du compte, gardé en secret côté Worker. L'UID et l'email ne sont jamais envoyés au navigateur.
  - `GET /api/positions` renvoie les positions (volontairement approximatives) et statuts des invaders depuis [pnote.eu](https://pnote.eu/projects/invaders/), mis en cache 6 h.

## Développement

```sh
pnpm install
echo "FLASH_UID=<ton uid>" > .dev.vars   # ignoré par git
pnpm build && pnpm dev:api               # http://localhost:8787
# ou, avec rechargement du front : pnpm dev:api dans un terminal et pnpm dev dans un autre
```

## Déploiement

Chaque push sur `main` est typé, compilé puis déployé par GitHub Actions (`.github/workflows/ci.yml`) ; les pull requests sont seulement compilées. Secrets du dépôt : `CLOUDFLARE_API_TOKEN` (modèle « Edit Cloudflare Workers ») et `CLOUDFLARE_ACCOUNT_ID`.

À la main :

```sh
npx wrangler login
npx wrangler secret put FLASH_UID
pnpm deploy
```

L'UID se trouve dans la sauvegarde iPhone de l'app FlashInvaders (`Library/Preferences/com.space-invaders.FlashInvaders.plist`, clé `uid`).
