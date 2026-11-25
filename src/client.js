window.__ModuleLoader__.load({
  id: 'dsh-session-delete-menu',
  factory: () => {
    const prefix = '/api/session-delete'
    const entryPattern = /^\d{8}-\d{6}-[A-Za-z0-9._~-]{1,224}$/
    const errors = {
      RUNNING: '会话仍在运行，等它结束后再删除。',
      NOT_FOUND: '会话已经不存在。可在回收站查看。',
      INVALID_ID: '此会话标识不可安全删除。',
    }

    function makeDialog(title, onClose) {
      const dialog = document.createElement('dialog')
      dialog.setAttribute('aria-labelledby', 'dsh-delete-menu-title')
      dialog.setAttribute('aria-describedby', 'dsh-delete-menu-description')
      const heading = document.createElement('h2')
      heading.id = 'dsh-delete-menu-title'
      heading.textContent = '永久删除会话？'
      const description = document.createElement('p')
      description.id = 'dsh-delete-menu-description'
      description.textContent = '「' + title + '」及其关联子会话将被永久删除，无法恢复。'
      const buttons = document.createElement('div')
      const cancel = document.createElement('button')
      cancel.type = 'button'
      cancel.autofocus = true
      cancel.textContent = '取消'
      const confirm = document.createElement('button')
      confirm.type = 'button'
      confirm.textContent = '永久删除'
      dialog.style.cssText = 'box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:20px;border:1px solid var(--dsw-alias-border-l2,#787878);border-radius:12px;background:var(--dsw-alias-bg-layer-2,Canvas);color:var(--dsw-alias-label-primary,CanvasText);font:inherit;box-shadow:0 12px 48px #0006;'
      heading.style.cssText = 'font-size:17px;font-weight:650;margin:0 0 10px;'
      description.style.cssText = 'margin:0 0 18px;line-height:1.55;overflow-wrap:anywhere;'
      buttons.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap;'
      for (const button of [cancel, confirm]) {
        button.style.cssText = 'font:inherit;padding:6px 12px;border:1px solid var(--dsw-alias-border-l2,#787878);border-radius:6px;background:transparent;color:inherit;cursor:pointer;'
      }
      confirm.style.color = 'var(--dsw-alias-state-error-primary,#e4484d)'
      cancel.addEventListener('click', () => dialog.close('cancel'))
      confirm.addEventListener('click', () => dialog.close('permanent-delete'))
      dialog.addEventListener('close', () => onClose(dialog.returnValue === 'permanent-delete'), { once: true })
      buttons.append(cancel, confirm)
      dialog.append(heading, description, buttons)
      return dialog
    }

    function apply(ctx) {
      // Desktop-local only: do not extend the menus of a remotely served Web UI.
      if (window.location.protocol !== 'dsh-app:') return
      ctx.effect(() => {
        let disposed = false
        let inFlight = false
        let cancelDialog
        const menus = ctx.contextMenus

        function confirmPermanentDelete(title) {
          return new Promise((resolve) => {
            let dialog
            let settled = false
            const settle = (accepted) => {
              if (settled) return
              settled = true
              cancelDialog = undefined
              dialog?.remove()
              resolve(accepted)
            }
            dialog = makeDialog(title, settle)
            cancelDialog = () => settle(false)
            try {
              document.body.appendChild(dialog)
              dialog.showModal()
            } catch {
              settle(false)
              if (!disposed) menus.notify('无法显示删除确认框，请从设置的会话管理页重试。', false)
            }
          })
        }

        function refreshSessions() {
          try {
            Promise.resolve(ctx.sessions?.refresh?.()).catch(() => {})
          } catch {
            // The Host also broadcasts removal; this refresh is opportunistic.
          }
        }

        async function post(action, body) {
          const res = await fetch(prefix + '/' + action, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'session-delete' },
            credentials: 'same-origin',
            redirect: 'error',
            body: JSON.stringify(body),
          })
          const data = await res.json().catch(() => null)
          return { ok: res.ok && data?.ok === true, data }
        }

        async function erase(id, title) {
          if (disposed || inFlight) return
          inFlight = true
          try {
            if (!await confirmPermanentDelete(title) || disposed) return
            const { ok, data } = await post('delete', { id })
            if (!ok || data.id !== id) {
              const code = data?.error?.code
              const message = Object.hasOwn(errors, code) ? errors[code] : null
              if (!disposed) menus.notify(message ?? '未确认删除成功。请检查会话和回收站，再决定是否重试。', false)
              return
            }

            // Purge only the entries returned by this exact operation; never
            // purge all. A failed purge leaves a recoverable entry and must
            // never be reported as a completed permanent deletion.
            const children = Array.isArray(data.cascade?.deleted) ? data.cascade.deleted : []
            const skipped = Array.isArray(data.cascade?.skippedRunning) ? data.cascade.skippedRunning.length : 0
            const failed = Array.isArray(data.cascade?.failed) ? data.cascade.failed.length : 0
            const staged = new Set()
            let notPurged = 0
            for (const candidate of [data, ...children]) {
              const entry = candidate?.entry
              if (typeof entry === 'string' && entryPattern.test(entry)) staged.add(entry)
              else if (candidate?.note !== 'dir-missing'
                       && !(children.includes(candidate) && entry === null)) notPurged++
            }
            for (const entry of staged) {
              try {
                const result = await post('purge', { entry })
                if (!result.ok || result.data.count !== 1) notPurged++
              } catch {
                notPurged++
              }
            }

            if (disposed) return
            refreshSessions()
            if (notPurged) {
              menus.notify('永久删除未全部完成：请到“设置 → 归档会话 → 回收站”检查剩余条目。', false)
              return
            }
            const result = data.note === 'dir-missing' ? '已移除会话；本地无可清除的会话记录。'
              : children.length ? '会话及 ' + children.length + ' 个子会话已永久删除。'
              : '会话已永久删除。'
            const detail = (skipped ? ' ' + skipped + ' 个仍在运行的子会话已跳过。' : '')
              + (failed ? ' ' + failed + ' 个子会话未能删除。' : '')
            menus.notify(result + detail, skipped + failed === 0)
          } catch {
            if (!disposed) menus.notify('未确认永久删除成功。请先检查会话和回收站，再决定是否重试。', false)
          } finally {
            inFlight = false
          }
        }

        const unregister = menus.register({
          id: 'session.permanent-delete',
          target: 'session',
          order: 700,
          resolve({ sessionId, displayTitle }) {
            if (typeof sessionId !== 'string' || !sessionId ||
                ctx.sessions?.list?.getSnapshot()?.byId?.[sessionId]?.blank === true) return []
            return [{
              id: 'permanent-delete',
              label: '删除',
              icon: { key: 'workspace.delete' },
              danger: true,
              separatorBefore: true,
              afterContent: true,
              run: () => erase(sessionId, displayTitle || '未命名会话'),
            }]
          },
        })
        return () => {
          disposed = true
          cancelDialog?.()
          unregister()
        }
      }, 'session-delete-menu: desktop session action')
    }

    return { apply, inject: ['contextMenus', 'sessions'] }
  },
})
