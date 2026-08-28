export interface MpyAbiInfo {
  bytecodeVersion?: number;
  architectureCode?: number;
}

/** Decode the ABI bit-field exposed by `sys.implementation._mpy`. */
export function decodeMpyAbi(rawValue: number): MpyAbiInfo {
  if (!Number.isInteger(rawValue) || rawValue <= 0) {
    return {};
  }
  const major = rawValue & 0xff;
  const subVersion = (rawValue >> 8) & 0x03;
  const architectureCode = (rawValue >> 10) & 0x0f;
  return {
    bytecodeVersion: subVersion === 0 ? major : Number(`${major}.${subVersion}`),
    architectureCode
  };
}
