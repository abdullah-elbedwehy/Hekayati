# Product UI font sources

All product fonts are committed locally and verified by `npm run check:fonts`; runtime never fetches a font or uses a CDN.

| Family / files                                 | Immutable upstream pin                                                                            | License     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------- | ----------- |
| Lemonada SemiBold + Bold                       | Google Fonts commit `0a305919137700d960d61643f1a926d861694c76`, v4.005                            | SIL OFL 1.1 |
| Source Sans 3 upright variable                 | Adobe Source Sans tag `3.052R`, peeled commit `ed1808970eb3c7301c9a523bee26473ba0bb62fa`          | SIL OFL 1.1 |
| IBM Plex Sans Arabic Regular + SemiBold + Bold | IBM Plex package `@ibm/plex-sans-arabic@1.1.0`, commit `1da12f02587b630c07e92692d21492d722f53614` | SIL OFL 1.1 |

Exact URLs and SHA-256 hashes are executable data in [`../../../scripts/ui-font-manifest.mjs`](../../../scripts/ui-font-manifest.mjs). Re-acquire with `node scripts/fetch-ui-fonts.mjs`; the command rejects any byte mismatch.
