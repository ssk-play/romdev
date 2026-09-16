# Open ROMs - free C64 KERNAL / BASIC / CHARGEN

These are **not** Commodore's ROMs. They are the clean-room, freely-licensed
replacements from [MEGA65/open-roms](https://github.com/MEGA65/open-roms),
written specifically so emulators can ship a working C64 without redistributing
Commodore's copyrighted code.

| file | upstream name | size | sha256 (first 16) |
|---|---|---|---|
| `kernal-901227-03.bin` | `bin/kernal_generic.rom` | 8192 | `88e86ed3d0c710ed` |
| `basic-901226-01.bin` | `bin/basic_generic.rom` | 8192 | `54a1464b4b27c9dc` |
| `chargen-901225-01.bin` | `bin/chargen_openroms.rom` | 4096 | `5e3451466841b93d` |

Fetched from `master` on 2026-09-16 via
`https://raw.githubusercontent.com/MEGA65/open-roms/master/bin/<name>`.

**The filenames are Commodore's part numbers on purpose.** VICE resolves its ROM
images by those exact names, so the files are renamed to match. The *contents*
are Open ROMs. Do not read the filename as a claim about origin.

`kernal_generic` and `basic_generic` are a matched pair; upstream is explicit
that ROM sets must not be mixed across builds or platforms. CHARGEN is
interchangeable. If you update one, update the pair together.

## License

Dual **GPL-3.0** / **LGPL-3.0** - see `COPYING` and `COPYING.LESSER` here.
That is why these can ship at all.

## Using Commodore's ROMs instead

Open ROMs is a reimplementation, not a bit-exact clone; BASIC in particular is
incomplete upstream (most BASIC commands, integer/float variables and arrays,
and expression handling are unimplemented per their `STATUS.md`). Software that
depends on original KERNAL/BASIC internals may behave differently.

To use the genuine ROMs you already own, put `kernal-901227-03.bin`,
`basic-901226-01.bin` and `chargen-901225-01.bin` in a directory and point
`ROMDEV_C64_ROM_DIR` at it. Those override the bundled set.
