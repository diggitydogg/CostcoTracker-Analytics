// Generates an owner access key (256-bit, base64url) and the SHA-256 digest the
// server stores. Store the key in a password manager; only the digest goes to
// Cloudflare (`wrangler pages secret put OWNER_ACCESS_KEY_SHA256`) or .dev.vars.
import { createHash, randomBytes } from 'node:crypto'

const key = randomBytes(32).toString('base64url')
const digest = createHash('sha256').update(key).digest('hex')
console.log(`Access key (keep secret, shown once): ${key}`)
console.log(`OWNER_ACCESS_KEY_SHA256=${digest}`)
