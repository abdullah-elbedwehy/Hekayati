# Phase 0 Font Fixtures

The G3 probe uses static, locally bundled fonts so browser, PDF, and raster results do not depend on host fonts or a CDN. Both families are licensed under the SIL Open Font License 1.1; the exact license texts are stored beside the binaries.

| File | Upstream version pin | SHA-256 |
|---|---|---|
| `Lemonada-SemiBold.ttf` | Google Fonts commit `0a305919137700d960d61643f1a926d861694c76` (Lemonada v4.005) | `7a51391cbecb60a7b6dac8b2b45ef72109e93568ae78016e246027ce09af9d4a` |
| `LICENSE-Lemonada-OFL.txt` | Same immutable commit | `d8a8801a55cbc8eeaab7dc9396c4491d60cc7e4ecb2501c6f8282754d743fc2a` |
| `IBMPlexSansArabic-Regular.ttf` | IBM Plex tag `@ibm/plex-sans-arabic@1.1.0`, peeled commit `1da12f02587b630c07e92692d21492d722f53614` | `8e0f1046c736bf939d4939ee3ae0116acf61cbcd6592deae7656761627080981` |
| `LICENSE-IBM-Plex-OFL.txt` | Same immutable commit | `7e6b2818edbd8f6a01ae80641cc8f16a51080d08fb4e532be3a0b6f74adb07da` |

The acquisition script uses only the following immutable raw URLs and rejects any content whose SHA-256 differs:

- <https://raw.githubusercontent.com/google/fonts/0a305919137700d960d61643f1a926d861694c76/ofl/lemonada/static/Lemonada-SemiBold.ttf>
- <https://raw.githubusercontent.com/google/fonts/0a305919137700d960d61643f1a926d861694c76/ofl/lemonada/OFL.txt>
- <https://raw.githubusercontent.com/IBM/plex/1da12f02587b630c07e92692d21492d722f53614/packages/plex-sans-arabic/fonts/complete/ttf/IBMPlexSansArabic-Regular.ttf>
- <https://raw.githubusercontent.com/IBM/plex/1da12f02587b630c07e92692d21492d722f53614/packages/plex-sans-arabic/LICENSE.txt>

Reproduce with `npm run fetch:fonts`. Runtime product code must never fetch these files from the network.
