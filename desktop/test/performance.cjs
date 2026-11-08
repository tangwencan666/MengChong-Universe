'use strict'

const { setTimeout: delay } = require('node:timers/promises')

/** Electron's own process metrics only. Working sets can count shared pages twice. */
async function samplePerformance(app, label, durationMs = 11000, intervalMs = 1000, readPetStates = async () => []) {
  if (durationMs < 10000) throw new Error('Performance samples must span at least 10 seconds')
  const startedAt = Date.now()
  const samples = []
  while (Date.now() - startedAt <= durationMs) {
    const metrics = await app.evaluate(({ app: electronApp }) => electronApp.getAppMetrics())
    samples.push({ at: new Date().toISOString(), elapsedMs: Date.now() - startedAt, processes: metrics, petStates: await readPetStates(),
      aggregate: { processCount: metrics.length,
        cpuPercent: metrics.reduce((total, value) => total + value.cpu.percentCPUUsage, 0),
        workingSetKiB: metrics.reduce((total, value) => total + value.memory.workingSetSize, 0),
        privateBytesKiB: metrics.reduce((total, value) => total + (value.memory.privateBytes ?? 0), 0) } })
    await delay(intervalMs)
  }
  if (samples.length < 10 || samples.at(-1).elapsedMs < 10000) throw new Error('Insufficient measured performance duration')
  const aggregates = samples.map((value) => value.aggregate)
  const average = (field) => aggregates.reduce((total, value) => total + value[field], 0) / aggregates.length
  return { label, durationMs: samples.at(-1).elapsedMs, sampleCount: samples.length,
    scope: 'Electron app.getAppMetrics() process tree, not system-wide utilization',
    caveat: 'Summing working sets may count shared memory pages more than once; CPU percentages follow Electron process metrics.',
    averageCpuPercent: average('cpuPercent'), averageWorkingSetKiB: average('workingSetKiB'),
    peakWorkingSetKiB: Math.max(...aggregates.map((value) => value.workingSetKiB)), samples }
}

module.exports = { samplePerformance }
