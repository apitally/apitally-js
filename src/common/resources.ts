let lastCpuUsage: { user: number; system: number } | null = null;
let lastCpuTime: number | null = null;

export function getCpuMemoryUsage() {
  const currentCpuUsage = process.cpuUsage();
  const currentTime = performance.now();
  const memoryRss = process.memoryUsage().rss;

  let cpuPercent = null;

  if (lastCpuUsage !== null && lastCpuTime !== null) {
    // Calculate elapsed time in microseconds
    const elapsedTime = (currentTime - lastCpuTime) * 1000;

    // Calculate CPU time used (user + system) in microseconds
    const cpuTime =
      currentCpuUsage.user -
      lastCpuUsage.user +
      (currentCpuUsage.system - lastCpuUsage.system);

    // Calculate percentage
    cpuPercent = (cpuTime / elapsedTime) * 100;
  }

  // Update last values for next call
  lastCpuUsage = currentCpuUsage;
  lastCpuTime = currentTime;

  return cpuPercent !== null
    ? {
        cpu_percent: cpuPercent,
        memory_rss: memoryRss,
      }
    : null;
}
