export const raise = (msg: string) => {
  throw new Error(msg)
}

export function generateKey(): string {
  return 'key_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
}

// 获取字符串 UTF-8 字节大小
export function getStringSize(str: string): number {
  return new TextEncoder().encode(str).length
}

// 判断是否超过 1MB
export function isBiggerThan1MB(str: string): boolean {
  return getStringSize(str) > 1024 * 1024 * 0.9
}
