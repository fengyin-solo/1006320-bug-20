#!/usr/bin/env node
// 链路验证：用仓库内 esbuild 打包 test/e2e-check.ts 后执行，无需额外依赖。
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const root = join(here, '..')
const esbuild = join(root, 'node_modules', '@esbuild', 'linux-arm64', 'bin', 'esbuild')
const out = join(here, '.e2e-bundle.mjs')

try {
  execFileSync(
    esbuild,
    [join(here, 'e2e-check.ts'), '--bundle', '--platform=node', '--format=esm', `--outfile=${out}`, '--log-level=warning'],
    { stdio: 'inherit', cwd: root },
  )
  execFileSync(process.execPath, [out], { stdio: 'inherit', cwd: root })
} catch {
  process.exitCode = 1
}
