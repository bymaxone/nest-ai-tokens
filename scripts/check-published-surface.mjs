/**
 * @fileoverview Published-surface gate — proves the README, the CHANGELOG and the exported
 * types describe the package that is actually about to ship.
 * @layer scripts
 *
 * Every check here exists because its absence let a defect reach npm:
 *
 * - `1.0.3` shipped a README whose "Example App" link returned 404. Nothing read
 *   the links.
 * - `1.0.4` fixed an exported type that rejected the very snippet the README
 *   shows. `test:types` compiles `src` through a `paths` mapping, so it never
 *   sees what a consumer resolving through `exports` sees, and the consumer
 *   fixture happened to use a workaround form.
 * - A pull request deleted a `## [x.y.z]` heading while adding the next one,
 *   which silently turns the release notes into the generic fallback.
 *
 * Run after `pnpm build` — the snippets compile against `dist/`.
 */

import { execFileSync } from 'node:child_process'
import { lookup } from 'node:dns/promises'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const README = readFileSync(join(ROOT, 'README.md'), 'utf8')
const CHANGELOG = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')

/** A throwaway consumer built by this script. Nothing outside it is touched, and
 * it is portable: the sibling libraries have no consumer fixture to borrow.
 *
 * The package is symlinked into its own `node_modules` so TypeScript resolves it
 * through the published `exports` map into `dist/` — exactly what a consumer
 * sees — while peers still resolve by walking up to the repository's own
 * `node_modules`. */
const GATE_DIR = join(ROOT, '.docs-gate')

/** The published type tests, compiled here against `dist/` as well. Empty when a
 * library has none — the check then covers only the README snippets. */
const TYPE_TESTS_GLOB = existsSync(join(ROOT, 'test', 'types')) ? '../test/types/**/*.ts' : '*.ts'

/** The repository's pinned compiler. */
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')

const failures = []
/** Record a failure without stopping, so one run reports every problem. */
const fail = (check, detail) => failures.push(`${check}: ${detail}`)

// ---------------------------------------------------------------------------
// 1. Every link in the README points somewhere real. A bad HTTP status fails the
//    gate; a link the machine could not reach at all is reported as a note, since
//    an offline runner is not a defect in the documentation.
// ---------------------------------------------------------------------------

/** Slug a Markdown heading the way GitHub does. Deliberately does NOT trim: the
 * space an emoji leaves behind becomes a leading hyphen, so `## 🚀 Quick Start`
 * is `#-quick-start` and not `#quick-start`. Trimming here would report every
 * correct emoji anchor in the file as broken. */
function slug(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .replace(/\s/g, '-')
}

/** README with fenced blocks removed. A `# Using pnpm` inside a ```bash fence is
 * a shell comment, not a heading, and letting it into the anchor set makes a
 * broken anchor pass. */
const README_PROSE = README.replace(/^```[\s\S]*?^```$/gm, '')

/** Classifies a bare IP address as one a documentation link must not reach, or
 * null when it is ordinary public space. Shared by the literal check and the
 * resolved-address check, so both answer with the same vocabulary. */
function privateAddressReason(ip) {
  const h = ip.toLowerCase()
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    if (a === 127) return 'a loopback address'
    // 0.0.0.0/8 is "this network" — 0.0.0.0 is the address a socket binds to
    // for "everything", and the rest of the block is not routable either.
    if (a === 0) return 'in the unspecified network (0.0.0.0/8)'
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) {
      return 'a private address'
    }
    if (a === 169 && b === 254) return 'a link-local address (cloud metadata range)'
    return null
  }
  if (h === '::1') return 'a loopback address'
  if (h === '::') return 'the unspecified address'
  if (h.startsWith('::ffff:')) return privateAddressReason(h.slice('::ffff:'.length))
  if (/^f[cd]/.test(h)) return 'a unique-local address'
  if (/^fe[89ab]/.test(h)) return 'a link-local address'
  return null
}

/** Hosts a documentation link must never point at. This check runs on
 * `pull_request`, so without it a fork could put `https://169.254.169.254/…` or a
 * loopback address in the README and have the CI runner probe it — the runner
 * reaching an endpoint the author cannot reach themselves. Rejected before the
 * request, not after, and reported as a finding rather than skipped: a published
 * README has no business linking to a private address either way.
 *
 * Every bare IP literal is refused, not just the private ranges. Enumerating
 * ranges means enumerating them again for IPv6, and again for whatever notation
 * is missed next; a documentation link points at a hostname, so the whole class
 * can go. The private ranges keep their own message because naming the range is
 * the more useful diagnosis when a link does hit one.
 *
 * A hostname is resolved before it is fetched, because a name pointed at
 * 169.254.169.254 reaches the same endpoint an IP literal would. This narrows
 * the hole rather than closing it: the fetch resolves the name a second time, so
 * a record that changes between the two calls still gets through. Closing that
 * needs the resolved address pinned into the connection, which is more machinery
 * than a documentation gate warrants — a static private record is the case worth
 * stopping, and this stops it. A name that does not resolve at all is left to the
 * fetch, which reports an unreachable host as a note. */
async function unroutableReason(url) {
  let u
  try {
    u = new URL(url)
  } catch {
    return 'is not a valid URL'
  }
  if (u.protocol !== 'https:') return `uses ${u.protocol.replace(':', '')}, not https`
  // A fully-qualified name keeps its trailing dot through the URL parser, and
  // `localhost.` resolves exactly like `localhost` — so the dot has to go
  // before the name is compared, or it is a one-character bypass.
  const h = u.hostname.toLowerCase().replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return 'is a loopback name'
  if (h.endsWith('.local')) return 'is an mDNS name, resolvable only on the local link'
  // A URL parser brackets every IPv6 literal, so the brackets are the test —
  // no need to recognise the address notation itself.
  if (h.startsWith('[')) {
    const reason = privateAddressReason(h.slice(1, -1))
    return reason ? `is ${reason}` : 'is an IPv6 literal, not a hostname'
  }
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) {
    const reason = privateAddressReason(h)
    return reason ? `is ${reason}` : 'is an IPv4 literal, not a hostname'
  }
  let addresses
  try {
    // Bounded like the fetch below is. A resolver that hangs would otherwise
    // stall Promise.all indefinitely and take CI with it, and a lookup that
    // cannot answer in five seconds tells us nothing anyway. `unref` so a
    // pending timer never holds the process open.
    addresses = await Promise.race([
      // The losing promise keeps running after the race resolves, so a lookup
      // that rejects late would surface as an unhandled rejection. Swallowed
      // here into the same "could not resolve" answer the catch below gives.
      lookup(h, { all: true }).catch(() => null),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve(null)
        }, 5_000).unref()
      }),
    ])
  } catch {
    return null
  }
  // Unresolvable, or slower than the bound: left to the fetch, which reports an
  // unreachable host as a note rather than failing the gate.
  if (!addresses) return null
  for (const { address } of addresses) {
    const reason = privateAddressReason(address)
    if (reason) return `resolves to ${address}, which is ${reason}`
  }
  return null
}

/** Thrown when a hop in a redirect chain points somewhere the guard refuses.
 * Distinguished from a transport error so it fails the gate instead of
 * degrading to a note — a redirect into private space is a finding, not an
 * outage. */
class UnroutableRedirect extends Error {}

/** `fetch` with the redirect chain followed by hand, because `redirect:
 * 'follow'` would check only the URL written in the README. A public host is
 * free to answer 302 with `Location: http://169.254.169.254/…`, and the runner
 * would follow it — the very thing `unroutableReason` exists to stop. Every hop
 * is validated before it is requested, and the chain is bounded: a redirect loop
 * must not spin inside a release gate. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

async function fetchChecked(url, init, hops = 0) {
  if (hops > 5) throw new UnroutableRedirect('follows more than 5 redirects')
  const res = await fetch(url, { ...init, redirect: 'manual' })
  // The statuses the Fetch standard actually redirects on. `3xx` is wider than
  // that — a 304 or a 300 is a response to return, not a hop to follow.
  if (!REDIRECT_STATUSES.has(res.status)) return res
  const location = res.headers.get('location')
  if (!location) return res
  // Release the socket before the next hop: undici holds the connection until
  // the body is read or cancelled, and this runs across every README link at
  // once.
  await res.body?.cancel().catch(() => undefined)
  let next
  try {
    next = new URL(location, url).href
  } catch {
    // A Location that does not parse is a defect in the chain, not an outage,
    // so it must not fall through to the transport-error note below.
    throw new UnroutableRedirect(`redirects to an unparsable location: ${location}`)
  }
  const reason = await unroutableReason(next)
  if (reason) throw new UnroutableRedirect(`redirects to ${next}, which ${reason}`)
  return fetchChecked(next, init, hops + 1)
}

async function checkLinks() {
  const anchors = new Set(
    [...README_PROSE.matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => `#${slug(m[1])}`),
  )
  // Only follow links a reader clicks. A badge is `[![alt](image)](target)`, and
  // a naive link regex captures the IMAGE — probing shields.io on every run and
  // failing the build when it rate-limits, for a reason that is not ours. The
  // image is stripped first so only the target remains.
  //
  // Collection starts from the prose for the same reason the anchor set does: an
  // `<a href="${url}">` inside a fence is a string an example builds at runtime,
  // not a link a reader can click, and the checker cannot resolve a placeholder.
  const clickable = README_PROSE.replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  const links = new Set([
    ...[...clickable.matchAll(/\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g)].map((m) => m[1]),
    ...[...clickable.matchAll(/<a\s+href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]),
  ])
  // Both spellings: the section links are Markdown, but the header navigation is
  // raw HTML. Collecting only the first left this README's nav bar unchecked.
  const internal = new Set([
    ...[...README_PROSE.matchAll(/\[[^\]]*\]\((#[^)\s]+)\)/g)].map((m) => m[1].toLowerCase()),
    ...[...README_PROSE.matchAll(/<a\s+href="(#[^"]+)"/g)].map((m) => m[1].toLowerCase()),
  ])

  // Relative links are the ones most likely to rot — a file gets renamed and
  // nothing outside the README notices. They cost no network to verify, and the
  // section above claims to check every link, so it has to mean every link.
  const relative = new Set(
    [
      ...[...clickable.matchAll(/\[[^\]]*\]\((?!https?:|#|mailto:)([^)\s]+)\)/g)].map((m) => m[1]),
      ...[...clickable.matchAll(/<a\s+href="(?!https?:|#|mailto:)([^"]+)"/g)].map((m) => m[1]),
    ]
      .map((target) => target.split('#')[0])
      .filter(Boolean),
  )

  for (const a of internal) {
    if (!anchors.has(a)) fail('links', `anchor ${a} matches no heading`)
  }
  for (const r of relative) {
    // Resolve and confine before touching the filesystem. `..` segments would
    // otherwise walk out of the repository and have the runner stat arbitrary
    // paths, and a link that escapes the repository is broken documentation
    // regardless — the file it names is not in the package.
    const target = resolve(ROOT, r.replace(/^\/+/, ''))
    if (target !== ROOT && !target.startsWith(ROOT + sep)) {
      fail('links', `${r} resolves outside the repository`)
    } else if (!existsSync(target)) {
      fail('links', `${r} does not exist in the repository`)
    }
  }

  const results = await Promise.all(
    [...links].map(async (url) => {
      const unroutable = await unroutableReason(url)
      if (unroutable) return `${url} → ${unroutable}`

      // npmjs.com serves 403 to any datacenter IP, browser User-Agent included,
      // so asking it whether a package page exists measures Cloudflare rather
      // than the package. The registry is the authoritative source for the same
      // question and answers honestly — this redirects the check, it does not
      // suppress it: a package that truly does not exist still fails here.
      const probe = url.replace(
        /^https:\/\/www\.npmjs\.com\/package\/(.+)$/,
        (_, name) => `https://registry.npmjs.org/${encodeURIComponent(name)}`,
      )
      // The rewrite above changes what is actually requested, so the invariant —
      // nothing is requested before it is validated — has to be re-established
      // for the rewritten target too. Today it is a fixed registry host, but the
      // guard must not depend on that staying true.
      if (probe !== url) {
        const rewritten = await unroutableReason(probe)
        if (rewritten) return `${url} → rewritten to ${probe}, which ${rewritten}`
      }
      const headers = { 'user-agent': 'Mozilla/5.0 (compatible; bymax-docs-gate)' }
      try {
        // HEAD first; some hosts answer it with 405, so fall back to GET.
        // Bounded per LINK, not per request: one signal covers the HEAD, the GET
        // fallback and every redirect hop together. That is the useful bound —
        // what must not stall a publish is the check of one link, however many
        // requests it takes.
        //
        // It covers the REQUESTS only. Each hop's `unroutableReason` runs a DNS
        // lookup with its own 5s bound, outside this signal, so a chain's worst
        // case is this timeout plus one lookup per hop. Both are bounded, which
        // is what matters here; they are not one budget.
        const opts = { headers, signal: AbortSignal.timeout(10_000) }
        let res = await fetchChecked(probe, { method: 'HEAD', ...opts })
        if (res.status === 405 || res.status === 403 || res.status === 429) {
          await res.body?.cancel().catch(() => undefined)
          res = await fetchChecked(probe, { method: 'GET', ...opts })
        }
        // Only the status is ever read. undici holds the connection until the
        // body is read or cancelled, and this runs across every link at once.
        await res.body?.cancel().catch(() => undefined)
        if (res.ok) return null
        // A package page 404s until the first publish. Reported, never fatal:
        // failing here would block the very release that makes the link true.
        if (res.status === 404 && probe !== url) {
          console.log(`  note: ${url} is not live yet — expected until the first publish`)
          return null
        }
        return `${url} → HTTP ${res.status}`
      } catch (err) {
        // A refused redirect is a finding about the link itself, not someone
        // else's outage, so it fails rather than degrading to a note.
        if (err instanceof UnroutableRedirect) return `${url} → ${err.message}`
        // A transport error cannot tell "this link is dead" from "that host is
        // down right now". Reported, never fatal — this gate also guards
        // `prepublishOnly`, and someone else's outage must not block a release.
        console.log(
          `  note: ${url} could not be reached (${err instanceof Error ? err.message : String(err)})`,
        )
        return null
      }
    }),
  )
  for (const r of results) if (r) fail('links', r)
  console.log(
    `  links: ${links.size} external, ${internal.size} internal, ${relative.size} relative`,
  )
}

// ---------------------------------------------------------------------------
// 2. The release notes for this version are extractable.
// ---------------------------------------------------------------------------

/** Mirrors the awk in `release.yml`: everything between this version's heading
 * and the next one. Kept deliberately identical — a check that reads the file
 * differently from the workflow proves nothing about the workflow. */
function releaseNotes(version) {
  const lines = CHANGELOG.split('\n')
  const start = lines.findIndex((l) => /^## \[/.test(l) && l.includes(`[${version}]`))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((l) => /^## \[/.test(l))
  // `.replace(/\s+$/, '')` and not `.trim()`: the awk prints each line verbatim
  // and only command substitution drops the trailing newline. Trimming the left
  // side too would report a different body from the one the release publishes.
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').replace(/\s+$/, '')
}

function checkChangelog() {
  const notes = releaseNotes(PKG.version)
  if (notes === null) {
    fail(
      'changelog',
      `no "## [${PKG.version}]" heading — the release would publish the generic fallback`,
    )
    return
  }
  if (notes.length < 40) {
    fail(
      'changelog',
      `the "${PKG.version}" section is ${notes.length} characters — almost certainly an empty heading`,
    )
  }
  const headings = [...CHANGELOG.matchAll(/^## \[([^\]]+)\]/gm)].map((m) => m[1])
  const documented = new Set(headings.filter((h) => /^\d+\.\d+\.\d+$/.test(h)))
  for (const v of documented) {
    const n = releaseNotes(v)
    if (!n || n.length < 40) fail('changelog', `the "${v}" section is empty or missing`)
  }

  // Every version heading is reference-link syntax, so it renders as plain text
  // unless a `[x.y.z]: url` definition exists. Three headings had one and three
  // did not, which is invisible until someone reads the rendered file.
  const defined = new Set([...CHANGELOG.matchAll(/^\[(\d+\.\d+\.\d+)\]: /gm)].map((m) => m[1]))
  for (const v of documented) {
    if (!defined.has(v)) {
      fail(
        'changelog',
        `the "${v}" heading is a reference link with no \`[${v}]: …\` definition, so it renders as plain text`,
      )
    }
  }

  // Checking only the versions the file happens to list cannot notice one that
  // is ABSENT — and a heading deleted while adding the next one is exactly how
  // the 1.0.3 entry was swallowed by 1.0.4. The tags are the outside source of
  // truth for what was released, so they are what the file is measured against.
  // `actions/checkout` clones with depth 1 and no tags, so `git tag --list`
  // returns an empty set with exit code 0 — the cross-check would pass by
  // finding nothing to check. Fetch them first, and if they still are not there
  // while the changelog claims released versions, say so instead of passing:
  // a silent no-op is the failure mode this whole gate exists to prevent.
  try {
    // Bounded: an unreachable remote must not hang a publish. On timeout the
    // local tags below are all there is, and the shallow guard still fires.
    execFileSync('git', ['fetch', '--tags', '--quiet'], {
      cwd: ROOT,
      stdio: 'ignore',
      timeout: 20_000,
    })
  } catch {
    // No network or no remote — the local tags below are then all there is.
  }
  let released = []
  try {
    released = execFileSync('git', ['tag', '--list', 'v*.*.*'], { cwd: ROOT, encoding: 'utf8' })
      .split('\n')
      .map((t) => t.trim().replace(/^v/, ''))
      .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
  } catch {
    fail('changelog', 'could not list git tags, so no version could be cross-checked')
    return
  }
  // No tags is the normal state of a package that has never been released, so
  // the absence alone proves nothing. What must not pass quietly is a SHALLOW
  // checkout, where the tags exist but were not fetched — there the check would
  // find nothing and report success.
  let shallow = false
  try {
    shallow =
      execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim() === 'true'
  } catch {
    // Not a git repository at all; the tag list below is simply empty.
  }
  if (released.length === 0 && shallow) {
    fail(
      'changelog',
      'the checkout is shallow and carries no tags, so the cross-check cannot run. ' +
        'In CI, check out with `fetch-depth: 0` or `fetch-tags: true`.',
    )
    return
  }
  const missing = released.filter((v) => !documented.has(v))
  for (const v of missing) {
    fail(
      'changelog',
      `v${v} is tagged but has no "## [${v}]" section — its release notes would be the generic fallback`,
    )
  }
  console.log(
    `  changelog: ${documented.size} sections, cross-checked against ${released.length} tag(s)`,
  )
}

// ---------------------------------------------------------------------------
// A throwaway consumer, so everything below resolves through `exports` → dist/.
// ---------------------------------------------------------------------------

/** Create `.docs-gate/` with the package symlinked into its own `node_modules`.
 * `paths` is emptied: the repository tsconfig maps the package name to `./src`,
 * which is precisely the mapping that has to be out of the way here. */
function scaffoldConsumer() {
  rmSync(GATE_DIR, { recursive: true, force: true })
  const scope = join(GATE_DIR, 'node_modules', ...PKG.name.split('/').slice(0, -1))
  mkdirSync(scope, { recursive: true })
  // 'junction' rather than 'dir': a directory symlink needs elevation or Developer
  // Mode on Windows, where a junction does not. Node ignores the type on POSIX.
  symlinkSync(ROOT, join(GATE_DIR, 'node_modules', PKG.name), 'junction')
  writeFileSync(
    join(GATE_DIR, 'tsconfig.json'),
    `${JSON.stringify(
      {
        extends: '../tsconfig.json',
        compilerOptions: {
          noEmit: true,
          rootDir: '..',
          baseUrl: '.',
          paths: {},
          noUnusedLocals: false,
          // A README snippet may name a handler parameter it does not use; that is
          // prose, not an API defect.
          noUnusedParameters: false,
          // A React snippet is JSX; without this it fails to parse for a reason
          // that says nothing about the published API. Inert when there is none.
          jsx: 'react-jsx',
        },
        include: ['*.ts', '*.tsx', TYPE_TESTS_GLOB],
      },
      null,
      2,
    )}\n`,
  )
}

// ---------------------------------------------------------------------------
// 3. The README's own snippets compile against the built package.
// ---------------------------------------------------------------------------

function checkSnippets() {
  // `tsx` too, and the fence language is kept: a React example has to be written
  // to a .tsx file or it does not parse, and a package with a React subpath
  // documents its surface in exactly those blocks.
  const blocks = [...README.matchAll(/^```(ts|typescript|tsx)\n([\s\S]*?)^```$/gm)].map((m) => ({
    ext: m[1] === 'tsx' ? 'tsx' : 'ts',
    code: m[2],
  }))
  // Only snippets that IMPORT the package: those are the ones making a claim
  // about the public API. Merely naming it in a comment is not a claim.
  const subjects = blocks.filter((b) => new RegExp(`from ['"]${PKG.name}`).test(b.code))
  if (subjects.length === 0) {
    fail('snippets', 'no README snippet imports the package — the gate would be vacuous')
    return
  }

  scaffoldConsumer()
  /** file name → its source, so a diagnostic can be traced back to the snippet. */
  const sources = new Map()
  subjects.forEach(({ ext, code }, i) => {
    const name = `snippet-${String(i + 1).padStart(2, '0')}.${ext}`
    sources.set(name, code)
    writeFileSync(join(GATE_DIR, name), code)
  })

  // A README snippet is written for a reader, not for a compiler: it may use a
  // variable introduced by the paragraph above it. Those diagnostics say nothing
  // about the published API, so they are counted and reported rather than
  // failing the build — and never dropped silently.
  const CONTEXT_ONLY = new Set([
    'TS2304',
    'TS2552',
    'TS7006',
    'TS18004',
    'TS2531',
    'TS2532',
    // Parse-level: a snippet that elides code with `…` or shows a bare `return`
    // is prose, not a program.
    'TS1108',
    'TS1109',
  ])
  /** `Property 'x' does not exist on type 'Y'` is an API defect when `Y` comes
   * from the package, and snippet noise when `Y` is a class the snippet declares
   * itself and abbreviates — a README example routinely writes `this.repo`
   * without spelling out the constructor that injects it. Decided by looking for
   * the declaration in the same snippet rather than by guessing from the code. */
  const isAbbreviatedLocalType = (line, sources) => {
    const m = /Property '[^']+' does not exist on type '([^']+)'/.exec(line)
    if (!m) return false
    const file = /^([^(]+)\(/.exec(line)?.[1]
    // `tsc` emits backslashes on Windows, so the basename is taken on either.
    const own = sources.get(file?.split(/[\\/]/).pop() ?? '') ?? ''
    return new RegExp(`\\b(class|interface|type)\\s+${m[1]}\\b`).test(own)
  }
  /** An import of some OTHER package the fixture does not install — a documented
   * optional integration. Reported as uncovered, not as a failure. */
  const isForeignModule = (line) => /error TS2307/.test(line) && !line.includes(PKG.name)

  try {
    // The repository's own TypeScript, not `npx tsc`: npx may fetch a different
    // version, and a gate that compiles against a compiler the project does not
    // use is measuring the wrong thing.
    execFileSync(process.execPath, [TSC, '-p', GATE_DIR], { cwd: ROOT, stdio: 'pipe' })
    console.log(`  snippets: ${subjects.length} README snippets compile against dist/`)
  } catch (err) {
    const lines = `${err.stdout ?? ''}${err.stderr ?? ''}`
      .trim()
      .split('\n')
      .filter((l) => /error TS\d+/.test(l))
    const real = lines.filter(
      (l) =>
        !CONTEXT_ONLY.has((/error (TS\d+)/.exec(l) ?? [])[1]) &&
        !isForeignModule(l) &&
        !isAbbreviatedLocalType(l, sources),
    )
    const context = lines.length - real.length
    if (real.length > 0) {
      fail(
        'snippets',
        `${real.length} README snippet error(s) about the published API:\n${real.map((l) => `      ${l}`).join('\n')}`,
      )
    }
    console.log(
      `  snippets: ${subjects.length} compiled against dist/` +
        (context > 0
          ? ` (${context} diagnostic(s) ignored: undeclared context or a peer the fixture does not install)`
          : ''),
    )
  } finally {
    rmSync(GATE_DIR, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------

console.log(`Published-surface gate — ${PKG.name}@${PKG.version}`)
await checkLinks()
checkChangelog()
checkSnippets()

if (failures.length > 0) {
  console.error(`\n✖ ${failures.length} problem(s):\n`)
  for (const f of failures) console.error(`  - ${f}`)
  process.exit(1)
}
console.log('\n✔ The documentation and the exported types match the built package.')
