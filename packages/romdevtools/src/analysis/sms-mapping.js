// Static ROM windows, not emulator configuration. Semantics follow bundled
// Genesis Plus GX cart_hw/sms_cart.c: mapper_16k_w and write_mapper_*.
export const SMS_MAPPERS = ["sega", "codemasters", "korean", "korean-16k-v2"];

export function smsWindow(size, addr, { mapper = "sega", bank, mapperState } = {}) {
  if (!SMS_MAPPERS.includes(mapper)) throw new Error(`Unsupported SMS mapper '${mapper}'; supported: ${SMS_MAPPERS.join(", ")}. 'korean' means A000 16KB paging, not every Korean board.`);
  if (!Number.isInteger(addr) || addr < 0 || addr >= 0xc000) throw new Error("SMS CPU address is outside ROM ($0000-$BFFF); use fileOffset or allOffsets for physical ROM bytes");
  const slot = Math.floor(addr / 0x4000), local = addr % 0x4000;
  const pages = mapperState?.pages ?? [0, 1, 2];
  const control = mapperState?.control ?? 0;
  let selected = bank ?? pages[slot];
  const banks = Math.ceil(size / 0x4000);
  if (!Number.isInteger(selected) || selected < 0 || selected >= banks) throw new Error(`SMS bank ${selected} out of range (ROM has ${banks} x 16KB banks)`);
  if (mapper === "korean" && slot < 2 && selected !== slot || mapper === "korean-16k-v2" && slot === 0 && selected !== 0) {
    throw new Error(`${mapper} cannot page bank ${selected} into fixed slot ${slot}`);
  }
  if (mapper === "sega" && slot === 2 && control & 8) throw new Error("Sega mapper maps cartridge RAM here, not ROM");
  if (mapper === "codemasters" && mapperState?.ramEnabled && addr >= 0xa000) throw new Error("Codemasters mapper maps cartridge RAM at $A000-$BFFF");
  if (mapper === "sega" && control & 3) selected = (selected + ((4 - (control & 3)) << 3)) % banks;
  let end = (slot + 1) * 0x4000;
  if (mapper === "sega" && addr < 0x400) { selected = 0; end = 0x400; }
  if (mapper === "codemasters" && mapperState?.ramEnabled && slot === 2) end = 0xa000;
  const off = selected * 0x4000 + local;
  if (off >= size) throw new Error("SMS CPU window exceeds ROM size");
  return { off, addr, bank: selected, slot, length: Math.min(end - addr, size - off), mapper };
}

export function smsWindows(size, addr, length, options = {}) {
  if (!Number.isInteger(length) || length < 1 || addr + length > 0xc000) throw new Error("SMS CPU window crosses into RAM; use allOffsets:true for the whole cartridge");
  const result = [];
  for (let cursor = addr; cursor < addr + length;) {
    const w = smsWindow(size, cursor, options);
    w.length = Math.min(w.length, addr + length - cursor);
    const previous = result.at(-1);
    if (previous && previous.bank === w.bank && previous.slot === w.slot && previous.off + previous.length === w.off) previous.length += w.length;
    else result.push(w);
    cursor += w.length;
  }
  return result;
}
