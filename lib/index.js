/**
 * dsh-plugin-filtration
 *
 * 和 dsh-plugin-masterprompt 伴生的过滤层。
 *
 * 职责两件,都挂在 `llm/stream` 上:
 *   1. 成稿过滤 —— 模型这一轮的最终正文,交给另一个模型按人格与语言习惯重说一遍,逐字流式推出
 *   2. 上限修正 —— Gemini 的 maxOutputTokens 上限是 65537,上游默认给 128000 会直接 400,
 *      这里遇到 gemini 就把上限压到 65536 再发
 *
 * 人设与语言习惯不自己存:直接读 masterprompt 的 state.json,渲染用它自己的 style.js。
 *
 * 只处理最终正文:带工具调用的一段不碰,空正文不碰。
 * 改写没起来就原样放行;改写中途断了,已经推出去的收不回来,只记日志。
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

const PROTOCOL = '下面是布洛妮娅要说的一段话,按布洛妮娅的说话方式重说一遍。数字、路径、代码块、引号里的原话原样保留:'

/** 代码块、路径、数字、引号原话。整段检查用;流式时只记日志。 */
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
      if (cached && st.mtimeMs === stamp) return cached
      cached = JSON.parse(readFileSync(MP_STATE, 'utf8'))
      stamp = st.mtimeMs
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

/** 这个模型声明过的最低推理等级。没声明推理能力就返回 null(不传)。 */
const effortCache = new Map()
const EFFORT_ORDER = ['off', 'none', 'disabled', 'minimal', 'low', 'light', 'fast', 'medium']

async function lowestEffort(llm, provider, model) {
  const key = provider + '/' + model
  if (effortCache.has(key)) return effortCache.get(key)
  let picked = null
  try {
    if (typeof llm.resolveModelInfo === 'function') {
      const info = await llm.resolveModelInfo(provider, model)
      const efforts = info && info.reasoning && Array.isArray(info.reasoning.efforts) ? info.reasoning.efforts : []
      const ids = efforts.map((e) => String(e && e.id ? e.id : e)).filter(Boolean)
      if (ids.length) {
        for (const want of EFFORT_ORDER) {
          const hit = ids.find((id) => id.toLowerCase() === want)
          if (hit) {
            picked = hit
            break
          }
        }
        if (!picked) {
          for (const want of EFFORT_ORDER) {
            const hit = ids.find((id) => id.toLowerCase().includes(want))
            if (hit) {
              picked = hit
              break
            }
          }
        }
        if (!picked) picked = ids[0]
      }
    }
  } catch {
    picked = null
  }
  effortCache.set(key, picked)
  return picked
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

  function getLlm() {
    try {
      const llm = ctx.get('llm')
      return llm && typeof llm.stream === 'function' ? llm : undefined
    } catch {
      return undefined
    }
  }

  function buildRequest(input, llm, effort, signal) {
    return llm.stream({
      provider: input.provider,
      model: input.model,
      messages: [
        { role: 'system', content: [{ type: 'text', text: String(input.system || '') }] },
        { role: 'user', content: [{ type: 'text', text: PROTOCOL + '\n\n' + String(input.text || '') }] },
      ],
      maxTokens: 8192,
      ...(effort ? { reasoningEffort: effort } : {}),
      purpose: 'filtration-polish',
      signal,
    })
  }

  /** 逐字吐。改写没起来就一块都不吐,调用方据此退回原文。 */
  async function* rewriteDeltas(input) {
    const original = String(input?.text ?? '')
    if (!original.trim() || !input?.provider || !input?.model) return
    const llm = getLlm()
    if (!llm) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 45000)
    try {
      const effort = await lowestEffort(llm, input.provider, input.model)
      const stream = buildRequest(input, llm, effort, controller.signal)
      for await (const chunk of stream) {
        if (chunk && chunk.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text) {
          yield chunk.text
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  /** 一次性拿整段。给自测口用。 */
  async function rewrite(input) {
    const original = String(input?.text ?? '')
    if (!original.trim()) return { ok: false, reason: 'empty-input' }
    if (!input?.provider || !input?.model) {
      note('no-route')
      return { ok: false, reason: 'no-route' }
    }
    let out = ''
    try {
      for await (const delta of rewriteDeltas(input)) out += delta
    } catch (e) {
      note('error:' + String((e && e.message) || e))
      return { ok: false, reason: String((e && e.message) || e) }
    }
    const check = checkRewrite(original, out.trim())
    if (!check.ok) {
      note(check.reason, check.missing ? { missing: check.missing } : {})
      return { ok: false, reason: check.reason, missing: check.missing }
    }
    note('ok')
    return { ok: true, text: out.trim() }
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

    const started = Date.now()
    const iterator = rewriteDeltas({ text, system: info.system, provider: info.provider, model: info.model })[Symbol.asyncIterator]()
    let first
    try {
      first = await iterator.next()
    } catch (e) {
      ctx.logger.warn('dsh-plugin-filtration: 改写没起来: ' + String((e && e.message) || e))
      first = { done: true }
    }
    if (first.done || !first.value) {
      for (const c of chunks) yield c
      return
    }

    let index = 0
    if (reasoning) {
      yield { type: 'block-start', index, blockType: 'reasoning' }
      yield { type: 'reasoning-delta', index, text: reasoning }
      yield { type: 'block-end', index, block: { type: 'reasoning', text: reasoning } }
      index++
    }
    const textIndex = index
    yield { type: 'block-start', index: textIndex, blockType: 'text' }
    let full = String(first.value)
    yield { type: 'text-delta', index: textIndex, text: full }
    try {
      for await (const delta of { [Symbol.asyncIterator]: () => iterator }) {
        if (!delta) continue
        full += delta
        yield { type: 'text-delta', index: textIndex, text: delta }
      }
    } catch (e) {
      ctx.logger.warn('dsh-plugin-filtration: 改写中途断了: ' + String((e && e.message) || e))
    }

    const check = checkRewrite(text, full)
    if (!check.ok) {
      ctx.logger.warn('dsh-plugin-filtration: 整段保真检查没过（' + check.reason + '）,内容已经推出去了,不撤回')
    }
    ctx.logger.info?.('dsh-plugin-filtration: 成稿过了一遍 ' + info.provider + '/' + info.model + ',用了 ' + (Date.now() - started) + 'ms')
    yield { type: 'block-end', index: textIndex, block: { type: 'text', text: full } }
    if (usage !== undefined) yield { type: 'usage', usage }
    yield finish || { type: 'finish', reason: { kind: 'stop' } }
  }

  ctx.on('llm/stream', (options, next) => {
    if (!options) return next()
    if (String(options.purpose || '').startsWith('filtration-')) return next()

    let stream
    const cap = Number(settings.maxTokens) || 65536
    if (looksGemini(options) && Number(options.maxTokens || 0) > cap) {
      const llm = getLlm()
      stream = llm ? llm.stream({ ...options, maxTokens: cap, purpose: 'filtration-clamp' }) : next()
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
    const parts = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > maxBytes) throw new Error('body too large')
      parts.push(chunk)
    }
    if (!parts.length) return {}
    try {
      return JSON.parse(Buffer.concat(parts).toString('utf8'))
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

  route('GET', '/dsh-flt/state', async (req, res) => {
    let sid = ''
    try {
      sid = new URL(req.url || '/', 'http://x').searchParams.get('sid') || ''
    } catch {
      /* ignore */
    }
    let effort = null
    try {
      const llm = getLlm()
      if (llm) effort = await lowestEffort(llm, settings.provider, settings.model)
    } catch {
      effort = null
    }
    sendJson(res, 200, {
      ok: true,
      settings,
      reasoningEffort: effort,
      personaChars: reader.render(sid).length,
      stats,
      last,
      masterpromptState: MP_STATE,
    })
  })

  route('GET', '/dsh-flt/models', async (req, res) => {
    const llm = getLlm()
    const providers = []
    if (llm) {
      let routes = []
      try {
        routes = typeof llm.listProviders === 'function' ? llm.listProviders() : []
      } catch {
        routes = []
      }
      for (const p of Array.isArray(routes) ? routes : []) {
        const id = p && (p.id || p.provider)
        if (!id) continue
        let models = []
        try {
          models = typeof llm.listModels === 'function' ? await llm.listModels(id) : []
        } catch {
          models = []
        }
        providers.push({
          provider: id,
          label: (p && (p.label || p.name || p.title)) || id,
          models: (Array.isArray(models) ? models : []).map((m) => ({
            id: String(m && m.id ? m.id : ''),
            label: String((m && (m.name || m.label)) || (m && m.id) || ''),
          })).filter((m) => m.id),
        })
      }
    }
    sendJson(res, 200, { ok: true, settings, providers })
  })

  route(['GET', 'POST'], '/dsh-flt/settings', async (req, res) => {
    if (req.method === 'POST') {
      const args = await readJsonBody(req)
      if (typeof args?.enabled === 'boolean') settings.enabled = args.enabled
      if (typeof args?.provider === 'string' && args.provider.trim()) settings.provider = args.provider.trim()
      if (typeof args?.model === 'string' && args.model.trim()) settings.model = args.model.trim()
      if (Number.isSafeInteger(args?.maxTokens) && args.maxTokens > 0) settings.maxTokens = args.maxTokens
      settings = normalizeSettings(settings)
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
      missing: out.missing ?? null,
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
