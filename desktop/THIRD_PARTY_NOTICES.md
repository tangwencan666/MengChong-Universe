# WeiBiYe Windows desktop preview — third-party notices

This is an unsigned local development preview, not a public consumer release or an installer. It requires the separately running WeiBiYe API in Mock mode. The preview does not bundle PostgreSQL, Redis, the Python backend, user databases, API credentials, authentication profiles or third-party character artwork.

## Electron runtime

The package copies the exact locally installed and reviewed Electron runtime without downloading or executing installers. Electron's LICENSE and LICENSES.chromium.html remain in the package root, together with the complete runtime files. Electron is MIT-licensed; Chromium and its bundled components have their own notices in LICENSES.chromium.html. Those files must accompany any redistribution. Packaging metadata records the actual runtime version and every copied file's SHA-256.

## Built React application

The existing React frontend is bundled into the preview as compiled static files. The packager copies the actual installed license texts for React, React DOM, React Router, TanStack React Query / Query Core, Axios, Lucide React and their installed runtime dependency closure into resources/app/licenses. It also preserves Tailwind CSS and Vite license texts for generated stylesheet/helper code. The generated licenses/DEPENDENCIES.json lists installed package names, versions, declared licenses and copied notice filenames. These copied license texts are authoritative; this overview does not replace them or broaden their terms.

Current dependency metadata commonly identifies React, React DOM, React Router, TanStack Query and Axios as MIT; Lucide uses ISC terms with additional provenance notices in its actual license text. The installed text is preserved unchanged. No third-party code is relicensed by this document. Development/test packages such as Playwright are not included in resources/app, and there is no copied application node_modules directory.

## Original artwork and unavailable adapters

The three geometric pet SVGs and tray PNG were authored specifically for WeiBiYe. Their provenance and distribution boundary are recorded in resources/app/assets/ASSET_NOTICE.md. No visual asset or code from the researched desktop-pet repositories is copied into this preview. No Live2D SDK, Cubism Core, model or commercial character is bundled; the capability is explicitly NOT_IMPLEMENTED.

## Project license and distribution boundary

The WeiBiYe owner has not selected a public open-source license for the overall project. Neither this document nor the portable packaging script selects one. Third-party notices remain applicable to their respective components. Public redistribution still requires a complete dependency/asset review, a chosen WeiBiYe distribution policy, signing/installer/update design, Windows 10/11 acceptance and a separately approved backend/data deployment plan.
