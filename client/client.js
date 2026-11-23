// dsh-plugin-filtration — client bundle (hand-written ModuleLoader form, no
// bundler needed). Renders the「过滤」box in the composer tool row. The panel
// lists every model DSH knows; clicking one switches to it immediately.
// Talks to the host through the /dsh-flt/* routes.
window.__ModuleLoader__.load({ id: 'dsh-plugin-filtration', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  var BUILD = 'b1124'

  var CSS = [
    '.dshflt-root { position: relative; display: inline-flex; align-items: center; }',
    '.dshflt-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: var(--dsw-alias-label-primary, inherit); font-size: 12px; cursor: pointer; line-height: 1; }',
    '.dshflt-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }',
    '.dshflt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }',
    '.dshflt-dot.on { background: var(--dsw-alias-state-success-primary, #3da95c); }',
    '.dshflt-panel { position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 10px); width: 380px; max-height: 72vh; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: 0 10px 32px rgba(0,0,0,.25); font-size: 12.5px; }',
    '.dshflt-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); font-weight: 600; }',
    '.dshflt-close { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }',
    '.dshflt-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }',
    '.dshflt-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }',
    '.dshflt-status { color: var(--dsw-alias-label-secondary, inherit); line-height: 1.5; }',
    '.dshflt-group { font-size: 11.5px; color: var(--dsw-alias-label-tertiary, rgba(128,128,128,.85)); margin-top: 4px; }',
    '.dshflt-row { display: flex; align-items: center; gap: 6px; padding: 5px 8px; border: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); border-radius: 8px; }',
    '.dshflt-row.active { border-color: var(--dsw-alias-brand-primary, rgba(64,160,255,.65)); background: var(--dsw-alias-interactive-bg-active, rgba(64,128,255,.10)); }',
    '.dshflt-row .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }',
    '.dshflt-mini { padding: 3px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: inherit; cursor: pointer; font-size: 11.5px; }',
    '.dshflt-mini.primary { background: var(--dsw-alias-button-primary-fill, rgba(64,128,255,.16)); border-color: var(--dsw-alias-brand-primary, rgba(64,128,255,.6)); }',
    '.dshflt-mini:disabled { opacity: .45; cursor: default; }',
    '.dshflt-msg { color: var(--dsw-alias-label-secondary, inherit); min-height: 16px; }',
  ].join('\n')

  function getJson(url) {
    return fetch(url, { credentials: 'same-origin' }).then(function (r) { return r.json() })
  }
  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) { return r.json() })
  }

  function FilterBox() {
    var openState = React.useState(false)
    var isOpen = openState[0]
    var setOpen = openState[1]

    var dataState = React.useState(null)
    var info = dataState[0]
    var setData = dataState[1]

    var busyState = React.useState(false)
    var isBusy = busyState[0]
    var setBusy = busyState[1]

    var msgState = React.useState('')
    var msgText = msgState[0]
    var setMsg = msgState[1]

    var wrapRef = React.useRef(null)

    var settings = (info && info.settings) || {}
    var providers = (info && info.providers) || []

    function load() {
      setBusy(true)
      getJson('/dsh-flt/models').then(function (body) {
        if (body && body.ok) setData(body)
        else setMsg('读取失败')
      }).catch(function (e) {
        setMsg(String((e && e.message) || e))
      }).then(function () { setBusy(false) })
    }

    React.useEffect(function () { load() }, [])

    React.useEffect(function () {
      if (!isOpen) return
      function onDoc(ev) {
        if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false)
      }
      document.addEventListener('mousedown', onDoc)
      return function () { document.removeEventListener('mousedown', onDoc) }
    }, [isOpen])

    // 点一行就切换,没有「先选再保存」这一层。
    function pick(provider, model) {
      setBusy(true)
      setMsg('切换中……')
      postJson('/dsh-flt/settings', { provider: provider, model: model }).then(function (body) {
        if (!body || !body.ok) {
          setMsg('切换失败')
          return
        }
        return getJson('/dsh-flt/state').then(function (st) {
          var real = (st && st.settings) || {}
          setData(function (prev) {
            if (!prev) return prev
            return Object.assign({}, prev, { settings: real })
          })
          if (real.provider === provider && real.model === model) setMsg('已切到 ' + provider + ' / ' + model)
          else setMsg('服务器没接受,还是 ' + real.provider + ' / ' + real.model)
        })
      }).catch(function (e) {
        setMsg(String((e && e.message) || e))
      }).then(function () { setBusy(false) })
    }

    function toggleEnabled() {
      var next = !settings.enabled
      setBusy(true)
      postJson('/dsh-flt/settings', { enabled: next }).then(function (body) {
        if (body && body.ok) {
          setData(function (prev) { return prev ? Object.assign({}, prev, { settings: body.settings }) : prev })
          setMsg(next ? '已开启' : '已关闭')
        }
      }).catch(function () {}).then(function () { setBusy(false) })
    }

    var label = settings.model || '未选'
    var rows = []
    providers.forEach(function (p) {
      if (!p.models || !p.models.length) return
      rows.push(React.createElement('div', { key: 'h-' + p.provider, className: 'dshflt-group' }, p.label + ' (' + p.provider + ')'))
      p.models.forEach(function (m) {
        var active = settings.provider === p.provider && settings.model === m.id
        rows.push(React.createElement('div', { key: p.provider + '/' + m.id, className: 'dshflt-row' + (active ? ' active' : '') },
          React.createElement('span', { className: 'name' }, m.label || m.id),
          React.createElement('button', {
            className: 'dshflt-mini' + (active ? '' : ' primary'),
            disabled: isBusy || active,
            onClick: function () { pick(p.provider, m.id) },
          }, active ? '当前' : '用这个')))
      })
    })

    var panel = isOpen ? React.createElement('div', { className: 'dshflt-panel' },
      React.createElement('div', { className: 'dshflt-head' },
        React.createElement('span', null, '成稿过滤 · ' + BUILD),
        React.createElement('button', { className: 'dshflt-close', onClick: function () { setOpen(false) } }, '\u00d7')),
      React.createElement('div', { className: 'dshflt-body' },
        React.createElement('div', { className: 'dshflt-row' },
          React.createElement('span', { className: 'name' }, '启用'),
          React.createElement('button', { className: 'dshflt-mini' + (settings.enabled ? ' primary' : ''), disabled: isBusy, onClick: toggleEnabled },
            settings.enabled ? '开' : '关')),
        settings.model
          ? React.createElement('div', { className: 'dshflt-status' }, '当前：' + settings.provider + ' / ' + settings.model)
          : React.createElement('div', { className: 'dshflt-status' }, '当前：未选'),
        rows.length ? rows : React.createElement('div', { className: 'dshflt-status' }, '没读到模型列表，点刷新'),
        React.createElement('div', { className: 'dshflt-row' },
          React.createElement('button', { className: 'dshflt-mini', disabled: isBusy, onClick: load }, '刷新')),
        React.createElement('div', { className: 'dshflt-msg' }, msgText)))
      : null

    return React.createElement('div', { className: 'dshflt-root', ref: wrapRef },
      React.createElement('button', {
        className: 'dshflt-btn',
        title: '成稿过滤（' + BUILD + '）',
        onClick: function () {
          setOpen(!isOpen)
          if (!isOpen) load()
        },
      },
        React.createElement('span', { className: 'dshflt-dot' + (settings.enabled ? ' on' : '') }),
        '过滤 · ' + label),
      panel)
  }

  exports.apply = function apply(ctx) {
    ctx.effect(function () {
      var styleEl = document.createElement('style')
      styleEl.setAttribute('data-plugin-css', 'dsh-plugin-filtration')
      styleEl.textContent = CSS
      document.head.appendChild(styleEl)
      return function () {
        if (styleEl.parentNode) styleEl.parentNode.removeChild(styleEl)
      }
    }, 'dsh-plugin-filtration: styles')

    ctx.slots.inject('conversation.input.left', function () {
      return ctx.slots.register(
        { name: 'conversation.input.left', id: 'filtration-model', order: 6, label: '过滤' },
        function () {
          return React.createElement(FilterBox, null)
        })
    })
  }

  exports.name = 'dsh-plugin-filtration'
  exports.inject = ['slots']
  return module.exports
}})
