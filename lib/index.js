/**
 * dsh-plugin-filtration
 *
 * 和 dsh-plugin-masterprompt 伴生的过滤层。
 *
 * 职责只有两件,都挂在 `llm/stream` 上:
 *   1. 成稿过滤 —— 模型这一轮的最终正文,交给另一个模型按人格与语言习惯重说一遍
 *   2. 上限修正 —— Gemini 的 maxOutputTokens 上限是 65537,上游默认给 128000 会直接 400,
 *      这里遇到 gemini 就把上限压到 65536 再发
 *
 * 人设与语言习惯不自己存:直接读 masterprompt 的 state.json,和它共用一份。
 * 渲染用的是 masterprompt 的 style.js,同一条路径、同一份代码,不另写一遍。
 *
 * 只处理最终正文:带工具调用的一段不碰,空正文不碰。
 * 任何一步失败都原样放行 —— 宁可这一轮不改,也不能把回复弄丢或弄坏。
 */

import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { mergeVoice, voiceBlock, voiceOpenerBlock } from 'dsh-plugin-masterprompt/lib/style.js'

export const name = 'dsh-plugin-filtration'
export const inject = ['webServer']

const MP_STATE = path.join(homedir(), '.dsh', 'dsh-plugin-masterprompt', 'state.json')
const FLT_DIR = path.join(homedir(), '.dsh', 'dsh-plugin-filtration')
const FLT_STATE = path.join(FLT_DIR, 'state.json')

const PROTOCOL = [
  '下面是布洛妮娅要说的一段话,由另一个模型起草。按布洛妮娅的说话方式重说一遍。',
  '',
  '要求:',
  '1. 事实、数字、路径、代码块、引号里的原话原样保留。代码块一个字都不许动。',
  '2. 不增删信息,不加解释,不补结论,不改顺序。',
  '3. 只改说法:句子长短、语气、用词、下判断的方式按上面的人格与语言习惯来。',
  '4. 长度不超过原文的 1.15 倍。',
  '5. 只输出重写后的正文,不要任何说明,不要加标题。',
].join('\n')

/** 代码块、路径、数字、引号原话。改完必须都还在。 */
export function mustKeep(text) {
  const s = String(text || '')
  const out = []
  for (const m of s.matchAll(/```[\s\S]*?```/g)) out.push(m[0])
  for (const m of s.matchAll(/`[^`\n]{1,80}`/g)) out.push(m[0])
  for (const m of s.matchAll(/「([^」]{1,60})」/g)) out.push(m[1])
  for (const m of s.matchAll(/"[^"\n]{1,60}"/g)) out.push(m[0].slice(1, -1))
  for (const m of s.matchAll(/[A-Za-z]:\\[^\s，。；、）)"]+/g)) out.push(m[0])
  for (const m of s.matchAll(/(?:[\w.-]+\/)+[\w.-]+\.\w+/g)) out.push(m[0])
  for (const m of s.matchAll(/https?:\/\/[^\s，。；、）)"]+/g)) out.push(m[0])
  for (const m of s.matchAll(/\d+(?:[.,]\d+)?/g)) out.push(m[0])
  return [...new Set(out.filter((x) => x && x.trim()))]
}

export function checkRewrite(original, rewritten) {
  const out = String(rewritten || '').trim()
  if (!out) return { ok: false, reason: 'empty' }
  const missing = mustKeep(original).filter((piece) => !out.includes(piece))
  if (missing.length) return { ok: false, reason: 'missing', missing: missing.slice(0, 5) }
  const limit = Math.ceil(String(original).length * 1.15) + 40
  if (out.length > limit) return { ok: false, reason: 'too-long' }
  return { ok: true }
}

/** masterprompt 的 state.json:按 mtime 缓存,它一改这边就跟着改。 */
function createPersonaReader() {
  let cached = null
  let stamp = -1
  function load() {
    try {
      const st = statSync(MP_STATE)
      const key = st.mtimeMs
      if (cached && key === stamp) return cached
      cached = JSON.parse(readFileSync(MP_STATE, 'utf8'))
      stamp = key
      return cached
    } catch {
      return cached || null
    }
  }
  function templatesOf(sid) {
    const state = load()
    if (!state || !Array.isArray(state.templates)) return []
    const pick = (id) => state.templates.find((t) => t && t.id === id)
    if (sid) {
      const chosen = state.selection ? state.selection[sid] : undefined
      if (Array.isArray(chosen)) {
        const list = chosen.map(pick).filter(Boolean)
        if (list.length) return list
      } else if (typeof chosen === 'string') {
        const one = pick(chosen)
        if (one) return [one]
      }
    }
    const fallback = pick(state.defaultPersonaId)
    if (fallback) return [fallback]
    return state.templates.filter((t) => t && typeof t.text === 'string' && t.text.trim())
  }
  /** 人格正文 + 两节语言习惯 + 首句模板。不带插件自己的包装规则。 */
  function render(sid) {
    const templates = templatesOf(sid)
    if (!templates.length) return ''
    const parts = []
    for (const t of templates) {
      if (typeof t.text === 'string' && t.text.trim()) parts.push(t.text.trim())
    }
    const voice = mergeVoice(templates)
    const block = voiceBlock(voice)
    if (block) parts.push(block)
    const opener = voiceOpenerBlock(voice)
    if (opener) parts.push(opener)
    return parts.join('\n\n')
  }
  return { render, templatesOf, load }
}

function normalizeSettings(raw) {
  const out = { enabled: true, provider: 'dku0', model: 'gemini-3.8-flash', maxTokens: 65536 }
  if (raw && typeof raw === 'object') {
    if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled
    if (typeof raw.provider === 'string' && raw.provider.trim()) out.provider = raw.provider.trim()
    if (typeof raw.model === 'string' && raw.model.trim()) out.model = raw.model.trim()
    if (Number.isSafeInteger(raw.maxTokens) && raw.maxTokens > 0) out.maxTokens = raw.maxTokens
  }
  return out
}

function loadSettings() {
  try {
    return normalizeSettings(JSON.parse(readFileSync(FLT_STATE, 'utf8')))
  } catch {
    return normalizeSettings(null)
  }
}

function saveSettings(next) {
  try {
    mkdirSync(FLT_DIR, { recursive: true })
    writeFileSync(FLT_STATE, JSON.stringify(next, null, 2), 'utf8')
  } catch {
    /* 存不下去就只在内存里生效 */
  }
}

export function apply(ctx) {
  const reader = createPersonaReader()
  let settings = loadSettings()
  const stats = { attempts: 0, ok: 0, failed: 0, byReason: {} }
  let last = null

  function note(reason, extra = {}) {
    stats.attempts += 1
    if (reason === 'ok') stats.ok += 1
    else {
      stats.failed += 1
      const key = String(reason).split(':')[0]
      stats.byReason[key] = (stats.byReason[key] || 0) + 1
    }
    last = { at: Date.now(), reason: String(reason), ...extra }
  }

  async function rewrite(input) {
    const original = String(input?.text ?? '')
    if (!original.trim()) return { ok: false, reason: 'empty-input' }
    if (!input?.provider || !input?.model) return { ok: false, reason: 'no-route' }
    let llm
    try {
      llm = ctx.get('llm')
    } catch {
      llm = undefined
    }
    if (!llm || typeof llm.stream !== 'function') return { ok: false, reason: 'no-llm' }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const stream = llm.stream({
        provider: input.provider,
        model: input.model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: String(input.system || '') }] },
          { role: 'user', content: [{ type: 'text', text: PROTOCOL + '\n\n原文:\n' + original }] },
        ],
        maxTokens: 8192,
        purpose: 'filtration-polish',
        signal: controller.signal,
      })
      let out = ''
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      }
      const text = out.trim()
      const check = checkRewrite(original, text)
      if (!check.ok) {
        note(check.reason, check.missing ? { missing: check.missing } : {})
        return { ok: false, reason: check.reason }
      }
      note('ok')
      return { ok: true, text }
    } catch (e) {
      note('error:' + String((e && e.message) || e))
      return { ok: false, reason: String((e && e.message) || e) }
    } finally {
      clearTimeout(timer)
    }
  }

  function looksGemini(options) {
    const provider = String(options?.provider || '')
    const adapter = String(options?.adapter || '')
    const model = String(options?.model || '')
    return /gemini|dku0|google/i.test(provider) || /gemini|google/i.test(adapter) || /gemini/i.test(model)
  }

  async function* wrap(stream, info) {
    const chunks = []
    for await (const c of stream) chunks.push(c)

    let text = ''
    let reasoning = ''
    let hasTool = false
    let usage
    let finish
    for (const c of chunks) {
      if (!c) continue
      if (c.type === 'text-delta') text += String(c.text || '')
      else if (c.type === 'reasoning-delta') reasoning += String(c.text || '')
      else if (c.type === 'tool-call-delta') hasTool = true
      else if (c.type === 'block-end' && c.block && c.block.type === 'text' && !text) text = String(c.block.text || '')
      else if (c.type === 'usage') usage = c.usage
      else if (c.type === 'finish') finish = c
    }

    if (hasTool || !text.trim()) {
      for (const c of chunks) yield c
      return
    }

    const done = await rewrite({ text, system: info.system, provider: info.provider, model: info.model })
    if (!done.ok || !done.text || done.text === text) {
      ctx.logger.info?.('dsh-plugin-filtration: 成稿没改（' + String(done.reason || 'same') + '）')
      for (const c of chunks) yield c
      return
    }

    ctx.logger.info?.('dsh-plugin-filtration: 成稿过了一遍 ' + info.provider + '/' + info.model)
    let index = 0
    if (reasoning) {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: reasoning }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
      index++
    }
    const textIndex = index
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    yield { type: 'text-delta', index: textIndex, text: done.text }
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: done.text } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield finish || { type: 'finish', reason: { kind: 'stop' } }
  }

  ctx.on('llm/stream', (options, next) => {
    if (!options) return next()
    if (String(options.purpose || '').startsWith('filtration-')) return next()

    // 上限修正:越界就压到 65536 再发,否则 Gemini 直接 400。
    let stream
    const cap = Number(settings.maxTokens) || 65536
    if (looksGemini(options) && Number(options.maxTokens || 0) > cap) {
      const llm = ctx.get('llm')
      stream = llm && typeof llm.stream === 'function'
        ? llm.stream({ ...options, maxTokens: cap, purpose: 'filtration-clamp' })
        : next()
    } else {
      stream = next()
    }

    if (!settings.enabled) return stream
    if (options.toolHistory === undefined) return stream
    const sid = typeof options.sessionId === 'string' ? options.sessionId : ''
    if (!sid) return stream
    const system = reader.render(sid)
    if (!system) return stream

    return wrap(stream, { system, provider: settings.provider, model: settings.model })
  })

  // ---------- HTTP ----------
  const disposers = []
  function sendJson(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(JSON.stringify(data))
  }
  function sameOrigin(req) {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const host = req.headers.host
    if (typeof origin !== 'string' || typeof host !== 'string') return false
    try {
      return new URL(origin).host === host
    } catch {
      return false
    }
  }
  async function readJsonBody(req, maxBytes = 65536) {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) throw new Error('body too large')
      chunks.push(chunk)
    }
    if (!chunks.length) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }
  function route(method, routePath, handler) {
    const methods = Array.isArray(method) ? method : [method]
    try {
      disposers.push(ctx.webServer.register({
        kind: 'exact',
        path: routePath,
        handler: async (req, res) => {
          try {
            if (methods.indexOf('POST') >= 0 && req.method === 'POST') {
              if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, error: 'untrusted origin' })
            } else if (methods.indexOf(req.method) < 0) {
              res.writeHead(405)
              res.end()
              return
            }
            await handler(req, res)
          } catch (e) {
            sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
          }
        },
      }))
    } catch (e) {
      ctx.logger.warn('dsh-plugin-filtration: 路由 ' + routePath + ' 没能注册: ' + String((e && e.message) || e))
    }
  }

  route('GET', '/dsh-flt/state', (req, res) => {
    let sid = ''
    try {
      sid = new URL(req.url || '/', 'http://x').searchParams.get('sid') || ''
    } catch {
      /* ignore */
    }
    const system = reader.render(sid)
    sendJson(res, 200, {
      ok: true,
      settings,
      personaChars: system.length,
      stats,
      last,
      masterpromptState: MP_STATE,
    })
  })

  route(['GET', 'POST'], '/dsh-flt/settings', async (req, res) => {
    if (req.method === 'POST') {
      const args = await readJsonBody(req)
      if (typeof args?.enabled === 'boolean') settings.enabled = args.enabled
      if (typeof args?.provider === 'string' && args.provider.trim()) settings.provider = args.provider.trim()
      if (typeof args?.model === 'string' && args.model.trim()) settings.model = args.model.trim()
      if (Number.isSafeInteger(args?.maxTokens) && args.maxTokens > 0) settings.maxTokens = args.maxTokens
      saveSettings(settings)
    }
    sendJson(res, 200, { ok: true, settings })
  })

  route('POST', '/dsh-flt/test', async (req, res) => {
    const args = await readJsonBody(req)
    const text = typeof args?.text === 'string' ? args.text : ''
    if (!text.trim()) return sendJson(res, 400, { ok: false, error: 'text required' })
    const sid = typeof args?.sessionId === 'string' ? args.sessionId : ''
    const out = await rewrite({
      text,
      system: reader.render(sid),
      provider: typeof args?.provider === 'string' ? args.provider : settings.provider,
      model: typeof args?.model === 'string' ? args.model : settings.model,
    })
    sendJson(res, 200, {
      ok: true,
      original: text,
      polished: out.text ?? null,
      changed: !!out.ok,
      reason: out.reason ?? null,
      provider: settings.provider,
      model: settings.model,
      stats,
      last,
    })
  })

  return () => {
    for (const off of disposers) {
      try {
        off()
      } catch {
        /* ignore */
      }
    }
  }
}
