// dsh-plugin-filtration — client bundle (hand-written ModuleLoader form, no
// bundler needed). Renders the「过滤」box in the composer tool row and the panel
// that picks which model the filter layer uses. Talks to the host through the
// /dsh-flt/* routes.
window.__ModuleLoader__.load({ id: 'dsh-plugin-filtration', factory: function (require) {
  var module = { exports: {} }
  var exports = module.exports
  var React = require('react')

  var CSS = [
    '.dshflt-root { position: relative; display: inline-flex; align-items: center; }',
    '.dshflt-btn { display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 9px; border-radius: 12px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: var(--dsw-alias-label-primary, inherit); font-size: 12px; cursor: pointer; line-height: 1; }',
    '.dshflt-btn:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14)); }',
    '.dshflt-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-label-tertiary, rgba(128,128,128,.6)); }',
    '.dshflt-dot.on { background: var(--dsw-alias-state-success-primary, #3da95c); }',
    '.dshflt-panel { position: absolute; z-index: 1000; left: 0; bottom: calc(100% + 10px); width: 360px; max-height: 72vh; overflow: auto; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.4)); border-radius: 10px; background: var(--dsw-alias-bg-overlay, #ffffff); color: var(--dsw-alias-label-primary, #1a1a1a); box-shadow: 0 10px 32px rgba(0,0,0,.25); font-size: 12.5px; }',
    '.dshflt-head { display: flex; align-items: center; justify-content: space-between; padding: 9px 12px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(128,128,128,.25)); font-weight: 600; }',
    '.dshflt-close { border: none; background: transparent; color: inherit; cursor: pointer; font-size: 14px; padding: 2px 6px; border-radius: 6px; }',
    '.dshflt-close:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.18)); }',
    '.dshflt-body { padding: 10px 12px; display: flex; flex-direction: column; gap: 9px; }',
    '.dshflt-status { color: var(--dsw-alias-label-secondary, inherit); line-height: 1.5; }',
    '.dshflt-row { display: flex; align-items: center; gap: 6px; }',
    '.dshflt-row label { flex: 1; }',
    '.dshflt-select { width: 100%; padding: 5px 6px; border-radius: 8px; border: 1px solid var(--dsw-alias-border-l2, rgba(128,128,128,.45)); background: transparent; color: inherit; font-size: 12.5px; }',
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

  function FilterBox(props) {
    var open = React.useState(false)
    var data = React.useState(null)
    var busy = React.useState(false)
    var msg = React.useState('')
    var picked = React.useState('')
    var wrapRef = React.useRef(null)

    function refresh() {
      setBusy(true)
      setMsg('')
      getJson('/dsh-flt/models').then(function (body) {
        if (!body || !body.ok) { setMsg('读取失败'); return }
        setData(body)
        var s = body.settings || {}
        setPicked((s.provider || '') + '\u0000' + (s.model || ''))
      }).catch(function (e) {
        setMsg(String(e && e.message ? e.message : e))
      }).then(function () { setBusy(false) })
    }

    React.useEffect(function () {
      if (!open[0]) return
      function onDoc(ev) {
        if (wrapRef.current && !wrapRef.current.contains(ev.target)) setOpen(false)
      }
      document.addEventListener('mousedown', onDoc)
      return function () { document.removeEventListener('mousedown', onDoc) }
    }, [open[0]])

    function save() {
      var parts = String(picked[0] || '').split('\u0000')
      if (!parts[0] || !parts[1]) { setMsg('先选一个模型'); return }
      setBusy(true)
      postJson('/dsh-flt/settings', { provider: parts[0], model: parts[1] }).then(function (body) {
        if (body && body.ok) {
          setData(function (prev) { return prev ? Object.assign({}, prev, { settings: body.settings }) : prev })
          setMsg('已保存')
        } else {
          setMsg('保存失败')
        }
      }).catch(function (e) {
        setMsg(String(e && e.message ? e.message : e))
      }).then(function () { setBusy(false) })
    }

    function toggleEnabled() {
      var s = (data[0] && data[0].settings) || {}
      setBusy(true)
      postJson('/dsh-flt/settings', { enabled: !s.enabled }).then(function (body) {
        if (body && body.ok) {
          setData(function (prev) { return prev ? Object.assign({}, prev, { settings: body.settings }) : prev })
          setMsg(body.settings.enabled ? '已开启' : '已关闭')
        }
      }).catch(function () {}).then(function () { setBusy(false) })
    }

    var settings = (data[0] && data[0].settings) || {}
    var providers = (data[0] && data[0].providers) || []
    var label = settings.model ? settings.model : '未选'

    var options = []
    providers.forEach(function (p) {
      if (!p.models || !p.models.length) return
      options.push(React.createElement('optgroup', { key: 'g-' + p.provider, label: p.label + ' (' + p.provider + ')' },
        p.models.map(function (m) {
          return React.createElement('option', { key: p.provider + '/' + m.id, value: p.provider + '\u0000' + m.id },
            m.label || m.id)
        })))
    })

    var panel = open[0] ? React.createElement('div', { className: 'dshflt-panel' },
      React.createElement('div', { className: 'dshflt-head' },
        React.createElement('span', null, '成稿过滤'),
        React.createElement('button', { className: 'dshflt-close', onClick: function () { setOpen(false) } }, '\u00d7')),
      React.createElement('div', { className: 'dshflt-body' },
        React.createElement('div', { className: 'dshflt-row' },
          React.createElement('label', null, '启用'),
          React.createElement('button', { className: 'dshflt-mini' + (settings.enabled ? ' primary' : ''), disabled: busy[0], onClick: toggleEnabled },
            settings.enabled ? '开' : '关')),
        React.createElement('div', { className: 'dshflt-row' },
          React.createElement('label', null, '用哪个模型')),
        React.createElement('select', {
          className: 'dshflt-select',
          value: picked[0],
          onChange: function (e) { setPicked(e.target.value) },
        },
          React.createElement('option', { value: '' }, options.length ? '选一个模型' : '没有可用模型'),
          options),
        React.createElement('div', { className: 'dshflt-row' },
          React.createElement('button', { className: 'dshflt-mini primary', disabled: busy[0], onClick: save }, '保存'),
          React.createElement('button', { className: 'dshflt-mini', disabled: busy[0], onClick: refresh }, '刷新')),
        React.createElement('div', { className: 'dshflt-status' },
          '当前：' + (settings.provider || '?') + ' / ' + label),
        React.createElement('div', { className: 'dshflt-msg' }, msg[0]))) : null

    return React.createElement('div', { className: 'dshflt-root', ref: wrapRef },
      React.createElement('button', {
        className: 'dshflt-btn',
        title: '选择成稿过滤用的模型',
        onClick: function () { setOpen(!open[0]); if (!open[0]) refresh() },
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
        function (props) {
          return React.createElement(FilterBox, { sessionId: props.sessionId })
        })
    })
  }

  exports.name = 'dsh-plugin-filtration'
  exports.inject = ['slots']
  return module.exports
}})
