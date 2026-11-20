export function refundCheckDelaySeconds(attempt: number, random = Math.random): number {
  const base=Math.min(3600,60*2**Math.min(8,Math.max(0,attempt-1)))
  return Math.min(3600,Math.ceil(base*(0.8+0.4*random())))
}
