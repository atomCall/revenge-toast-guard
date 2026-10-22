import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The root manifest is the canonical one and points at `dist/index.js`, a path
 * relative to the repository root. The copy shipped inside `dist/` must point at
 * its sibling `index.js` instead, so a loader that reads the manifest from the
 * built folder resolves correctly too.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'))

const distManifest = {
	...manifest,
	dist: { ...manifest.dist, script: manifest.dist.script.replace(/^dist\//, '') },
}

mkdirSync(join(root, 'dist'), { recursive: true })
writeFileSync(join(root, 'dist/manifest.json'), `${JSON.stringify(distManifest, null, '\t')}\n`)

console.log(`dist/manifest.json -> script: ${distManifest.dist.script}`)
