export function textContentsEqual(left: string, right: string): boolean {
  return left.replace(/\r\n/g, '\n') === right.replace(/\r\n/g, '\n')
}
