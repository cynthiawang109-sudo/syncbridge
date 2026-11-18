export function attemptDelay(attemptCount: number) {
  return attemptCount
    ? 1500 * 2 ** (attemptCount - 1) + Math.floor(Math.random() * 150)
    : 0;
}
