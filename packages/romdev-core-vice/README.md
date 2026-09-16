# romdev-core-vice

VICE (x64) - Commodore 64 emulator core (libretro), as WebAssembly.

A binary package for [romdev](https://github.com/monteslu/romdev) - it ships the
prebuilt WebAssembly + JS glue and is resolved by the main `romdev` package on
demand. You normally install `romdev`, not this package directly.

## C64 ROMs: free replacements, bundled

This core is built **without** `USE_EMBEDDED`, so it carries none of Commodore's
KERNAL, BASIC or CHARGEN ROMs. Upstream vice-libretro embeds them; VICE's own
README marks them "Copyright C by Commodore Business Machines", and the GPL
covers VICE's code rather than those ROMs.

Instead this package ships **[MEGA65 Open ROMs](https://github.com/MEGA65/open-roms)**
in `roms/` - a clean-room, dual GPL-3.0/LGPL-3.0 KERNAL+BASIC+CHARGEN written so
emulators can ship a working C64 legally. The host installs them automatically,
so **the C64 boots with zero setup**.

The files are named after Commodore's part numbers (`kernal-901227-03.bin` and
friends) because VICE resolves ROM images by those exact names. The contents are
Open ROMs; see `roms/README.md`.

### Using your own ROMs

Open ROMs is a reimplementation, not a bit-exact clone - upstream's BASIC is
notably incomplete. If you own the originals, point `ROMDEV_C64_ROM_DIR` at a
directory containing `kernal-901227-03.bin`, `basic-901226-01.bin` and
`chargen-901225-01.bin`; that overrides the bundled set.

## Upstream & license

Bundles: **VICE**.

**License:** GPL-2.0-or-later

This package redistributes the upstream binary built to WebAssembly; the source
is fetched from a pinned upstream commit at build time (see the romdev repo's
`scripts/versions.json` and `BUILDING.md`). See the romdev repo `NOTICE` for the
full third-party inventory.

**Built by:** `romdevtools/scripts/build-vice.sh` + patch(es) `vice-romdev-memory-regions.patch`. See `scripts/BUILD_MAP.md` in the romdev repo for the full recipe→package map.
