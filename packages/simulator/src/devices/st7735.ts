// ST7735 TFT controller model (128×160, RGB565/RGB666). Fed with real SPI bytes from the MCU's SPI
// peripheral plus the D/C line level sampled at the moment each byte is shifted out.
// PlugAI panel convention: MADCTL 0x00 = portrait, upright, pins at the bottom.

export const LCD_W = 128;
export const LCD_H = 160;

export interface St7735Stats {
  bytes: number;
  commands: number;
  pixels: number;
  unknown: number[];
  lastCommand: number | null;
}

export class St7735 {
  readonly fb = new Uint16Array(LCD_W * LCD_H);
  sleep = true;
  displayOn = false;
  inverted = false;
  colmod = 0x06;
  madctl = 0x00;
  private cmd: number | null = null;
  private args: number[] = [];
  private xs = 0;
  private xe = LCD_W - 1;
  private ys = 0;
  private ye = LCD_H - 1;
  private cx = 0;
  private cy = 0;
  private pix: number[] = [];
  dirty = true;
  seq = 0;
  stats: St7735Stats = { bytes: 0, commands: 0, pixels: 0, unknown: [], lastCommand: null };

  constructor() {
    this.powerOn();
  }

  /** Power-on / hardware reset: frame memory holds random content, panel asleep. */
  powerOn() {
    let s = 0x2545f491;
    for (let i = 0; i < this.fb.length; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      this.fb[i] = s & 0xffff;
    }
    this.softReset();
  }

  softReset() {
    this.sleep = true;
    this.displayOn = false;
    this.inverted = false;
    this.colmod = 0x06;
    this.madctl = 0x00;
    this.cmd = null;
    this.args = [];
    this.pix = [];
    this.xs = 0;
    this.xe = LCD_W - 1;
    this.ys = 0;
    this.ye = LCD_H - 1;
    this.markDirty();
  }

  private markDirty() {
    this.dirty = true;
    this.seq++;
  }

  /** One SPI byte with D/C level (0 = command, 1 = data). */
  write(byte: number, dc: 0 | 1) {
    this.stats.bytes++;
    if (dc === 0) {
      this.command(byte);
      return;
    }
    if (this.cmd === 0x2c) this.pixelByte(byte);
    else if (this.cmd !== null) {
      this.args.push(byte);
      this.argsUpdated();
    }
  }

  private command(c: number) {
    this.stats.commands++;
    this.stats.lastCommand = c;
    this.cmd = c;
    this.args = [];
    this.pix = [];
    switch (c) {
      case 0x00: // NOP
        break;
      case 0x01: // SWRESET
        this.softReset();
        break;
      case 0x10: // SLPIN
        this.sleep = true;
        this.markDirty();
        break;
      case 0x11: // SLPOUT
        this.sleep = false;
        this.markDirty();
        break;
      case 0x20:
        this.inverted = false;
        this.markDirty();
        break;
      case 0x21:
        this.inverted = true;
        this.markDirty();
        break;
      case 0x28:
        this.displayOn = false;
        this.markDirty();
        break;
      case 0x29:
        this.displayOn = true;
        this.markDirty();
        break;
      case 0x2c: // RAMWR
        this.cx = this.xs;
        this.cy = this.ys;
        break;
      case 0x2a:
      case 0x2b:
      case 0x36:
      case 0x3a:
      case 0x12:
      case 0x13:
      case 0x26:
      case 0xb1:
      case 0xb2:
      case 0xb3:
      case 0xb4:
      case 0xb6:
      case 0xc0:
      case 0xc1:
      case 0xc2:
      case 0xc3:
      case 0xc4:
      case 0xc5:
      case 0xe0:
      case 0xe1:
      case 0xf0:
      case 0xf6:
      case 0xfc:
        break; // argument-taking or power/gamma commands (accepted; electrical effects not modelled)
      default:
        if (this.stats.unknown.length < 32 && !this.stats.unknown.includes(c)) this.stats.unknown.push(c);
    }
  }

  private argsUpdated() {
    const a = this.args;
    if (this.cmd === 0x2a && a.length === 4) {
      this.xs = (a[0] << 8) | a[1];
      this.xe = (a[2] << 8) | a[3];
    } else if (this.cmd === 0x2b && a.length === 4) {
      this.ys = (a[0] << 8) | a[1];
      this.ye = (a[2] << 8) | a[3];
    } else if (this.cmd === 0x36 && a.length === 1) {
      this.madctl = a[0];
      this.markDirty();
    } else if (this.cmd === 0x3a && a.length === 1) this.colmod = a[0] & 0x07;
  }

  private pixelByte(b: number) {
    this.pix.push(b);
    let rgb565: number;
    if ((this.colmod & 0x07) === 0x05) {
      if (this.pix.length < 2) return;
      rgb565 = (this.pix[0] << 8) | this.pix[1];
    } else if ((this.colmod & 0x07) === 0x06) {
      if (this.pix.length < 3) return;
      rgb565 = ((this.pix[0] & 0xf8) << 8) | ((this.pix[1] & 0xfc) << 3) | (this.pix[2] >> 3);
    } else {
      // 12-bit (0x03) packing is not modelled: treat as 16-bit so output is visibly wrong rather than silently right
      if (this.pix.length < 2) return;
      rgb565 = (this.pix[0] << 8) | this.pix[1];
    }
    this.pix = [];
    this.plot(this.cx, this.cy, rgb565);
    this.stats.pixels++;
    this.cx++;
    if (this.cx > this.xe) {
      this.cx = this.xs;
      this.cy++;
      if (this.cy > this.ye) this.cy = this.ys;
    }
  }

  private plot(lx: number, ly: number, c: number) {
    const mv = !!(this.madctl & 0x20);
    let x = mv ? ly : lx;
    let y = mv ? lx : ly;
    if (this.madctl & 0x40) x = LCD_W - 1 - x;
    if (this.madctl & 0x80) y = LCD_H - 1 - y;
    if (x < 0 || y < 0 || x >= LCD_W || y >= LCD_H) return;
    if (this.madctl & 0x08) c = ((c & 0x1f) << 11) | (c & 0x07e0) | (c >> 11); // BGR panel order
    const i = y * LCD_W + x;
    if (this.fb[i] !== c) {
      this.fb[i] = c;
      if (!this.dirty) this.markDirty();
      else this.seq++;
    }
  }

  /** What the glass shows (black when asleep / display off). */
  visible(): Uint16Array {
    if (this.sleep || !this.displayOn) return new Uint16Array(this.fb.length);
    if (!this.inverted) return this.fb;
    const out = new Uint16Array(this.fb.length);
    for (let i = 0; i < out.length; i++) out[i] = ~this.fb[i] & 0xffff;
    return out;
  }
}

export function rgb565ToRgb(c: number): [number, number, number] {
  return [((c >> 11) & 0x1f) * 255 / 31, ((c >> 5) & 0x3f) * 255 / 63, (c & 0x1f) * 255 / 31].map(Math.round) as [number, number, number];
}
