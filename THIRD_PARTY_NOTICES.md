# Third-party components

Airalogy BD's Apache-2.0 license applies to its original code and documentation. Third-party components remain under their own licenses and copyrights; they are not relicensed by this repository's LICENSE or NOTICE.

The declared dependency inventory is recorded in [docs/dependency-licenses.json](docs/dependency-licenses.json), with lockfile hashes and the inspection scope. Preserve each dependency's LICENSE, NOTICE, copyright and other attribution files when redistributing that dependency, including notices generated in JavaScript bundles. This inventory is not a replacement for those files or for required source-code access.

## Components requiring particular attention

| Component | Declared license | Distribution notes |
| --- | --- | --- |
| `jszip` | MIT OR GPL-3.0-or-later | This project uses the MIT option; preserve its MIT notice. |
| `@img/sharp-libvips-*` | LGPL-3.0-or-later | Prebuilt libraries and their embedded components retain their own licenses. Preserve notices, provide the required corresponding source and build information, and satisfy applicable replacement/relinking requirements for the actual binary distribution. |
| `@img/sharp-*` WASM variants | Apache-2.0 AND LGPL-3.0-or-later, sometimes also MIT | These are combined requirements, not alternatives; inspect the exact platform package before distribution. |
| `lightningcss` and platform packages; `axe-core`; Python `certifi` | MPL-2.0 | Preserve notices and provide access to the corresponding covered source when distributing executable forms; modifications to covered files stay subject to MPL. |
| Next.js bundled `@vercel/og` | MPL-2.0 | Embedded framework components are separate from the top-level npm license; retain upstream bundled notices and inspect the actual build before distributing it. |
| `caniuse-lite` | CC-BY-4.0 | Retain the data attribution and license notice; identify modifications as required. |
| `language-subtag-registry` | ODC-By-1.0 | Retain the database attribution and applicable notices. |
| Other dependencies | MIT, Apache-2.0, BSD, ISC, Python/PSF, BlueOak and other licenses listed in the inventory | Retain the exact upstream terms and notices, including multiple-license requirements such as pako's MIT AND Zlib. |

## Inventory coverage

The inventory covers metadata for 602 locked npm package/version pairs (549 installed manifests and 53 official registry manifests for optional/platform packages), plus 17 locked Python package/version pairs. Its inspection date and lockfile hashes are recorded in the inventory. Each entry includes a declared license. Most dependencies use permissive licenses; the exceptions above must not be treated as Apache-2.0.

The source repository does not vendor the installed dependencies. Package metadata does not exhaustively describe every library, font or dataset embedded inside a native binary or framework bundle. The inventory is therefore not a completed binary/image distribution compliance report. Before distributing an installer, browser bundle or container, inspect the exact artifact, include its required notices and source access, and account for Node.js, Python, uv, Git, system libraries and the base image's terms. Artifact publication requires a separate distribution review.

Upstream references: [Apache license](https://www.apache.org/licenses/LICENSE-2.0), [Mozilla MPL FAQ](https://www.mozilla.org/en-US/MPL/2.0/FAQ/), [sharp installation and prebuilt libraries](https://sharp.pixelplumbing.com/install/), [sharp-libvips packaging and source](https://github.com/lovell/sharp-libvips), [GNU LGPL 3.0](https://www.gnu.org/licenses/lgpl-3.0.html).
