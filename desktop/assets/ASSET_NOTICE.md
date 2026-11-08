# WeiBiYe original desktop assets

The cat.svg, dog.svg, cloud.svg and tray.png artwork in this directory was drawn specifically for WeiBiYe P6 with geometric SVG paths and a small original pixel-rendering script. Author/source: WeiBiYe project contribution made during the P6 implementation. No third-party illustration, commercial character, logo, sprite, font file, icon library or remote media is included.

These are project-controlled original assets. This notice records their provenance; it does not select a public open-source license for the entire project or independently authorize distribution of unrelated code. The project owner must select the final distribution license before publication.

The manifest is a build-time inventory. The pet renderer has a literal asset-id whitelist and does not fetch this manifest or accept arbitrary file paths, URLs, scripts or models. A replacement asset must be reviewed and added to both the inventory and the renderer whitelist.

Live2D status: NOT_IMPLEMENTED. No Live2D SDK, Cubism Core, model, animation or associated runtime/asset license is bundled. The inert manifest capability slot is reserved for a future adapter after a separate implementation and license review.

The tray image can be reproduced with Node.js using desktop/scripts/generate-art.cjs. It uses only built-in filesystem and zlib modules and does not download or execute third-party material.

The application app.ico re-renders that same original sprout geometry at 16, 24, 32, 48, 64, 128 and 256 pixels using desktop/scripts/build-icon.cjs. It does not upscale a third-party image or replace the existing pet artwork.
