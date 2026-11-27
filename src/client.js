window.__ModuleLoader__.load({
  id: 'dsh-session-delete-menu',
  factory: () => {
    const endpoint = '/api/dsh-session-delete-menu'
    const errors = {
      RUNNING: '会话仍在运行，等它结束后再删除。',
      NOT_FOUND: '会话已经不存在。请刷新会话列表。',
      UNSUPPORTED: '当前会话存储格式不支持永久删除。',
      UNSAFE_PATH: '无法安全定位会话文件，未删除。',
      CHANGED: '会话正在变化，未完成删除。请稍后重试。',
      BUSY: '另一项删除正在进行，请稍后重试。',
      INCOMPLETE: '未确认永久删除完成，请检查会话后再决定是否重试。',
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
        const sessions = ctx.sessions
        const removed = new Set()

        async function request(input) {
          const res = await fetch(endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'session-delete-menu' },
            credentials: 'same-origin',
            redirect: 'error',
            cache: 'no-store',
            body: JSON.stringify(input),
          })
          return { ok: res.ok, data: await res.json().catch(() => null) }
        }

        // A successful delete can leave an idle Session in the Host's memory
        // until its owning Agent releases it. Baseline reloads must not put
        // that removed item back in the sidebar or the archive view.
        let queued = false
        function hideRemoved() {
          if (queued || disposed || !removed.size) return
          queued = true
          queueMicrotask(() => {
            queued = false
            if (disposed) return
            const byId = sessions.list.getSnapshot()?.byId
            for (const id of removed) {
              if (byId?.[id] && byId[id].origin !== 'subagent') sessions.handleSessionRemoved?.(id)
            }
          })
        }
        async function synchronizeRemoved() {
          try {
            const { ok, data } = await request({ status: true })
            if (!ok || disposed || !Array.isArray(data?.removed)) return
            for (const id of data.removed) if (typeof id === 'string') removed.add(id)
            hideRemoved()
          } catch {}
        }
        const unsubscribe = sessions.list.subscribe?.(hideRemoved)
        const disconnect = ctx.on?.('connection/reset', synchronizeRemoved)
        void synchronizeRemoved()

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
              if (!disposed) menus.notify('无法显示删除确认框，请重新打开会话菜单。', false)
            }
          })
        }

        function refreshSessions() {
          try {
            Promise.resolve(sessions.refresh?.()).catch(() => {})
          } catch {
            // The Host also broadcasts removal; this refresh is opportunistic.
          }
        }

        async function erase(id, title) {
          if (disposed || inFlight) return
          inFlight = true
          try {
            if (!await confirmPermanentDelete(title) || disposed) return
            const { ok, data } = await request({ id })
            if (disposed) return
            if (!ok || data?.ok !== true || data.id !== id) {
              if (data?.code === 'NOT_FOUND') refreshSessions()
              const message = Object.hasOwn(errors, data?.code) ? errors[data.code] : null
              menus.notify(message ?? '未确认永久删除成功。请检查会话后再决定是否重试。', false)
              return
            }
            removed.add(id)
            hideRemoved()
            const { deletedChildren, runningChildren, failedChildren } = data
            const result = deletedChildren ? '会话及 ' + deletedChildren + ' 个子会话已永久删除。'
              : '会话已永久删除。'
            const detail = (runningChildren ? ' ' + runningChildren + ' 个仍在运行的子会话已跳过。' : '')
              + (failedChildren ? ' ' + failedChildren + ' 个子会话未能删除。' : '')
            menus.notify(result + detail, !runningChildren && !failedChildren)
          } catch {
            if (!disposed) menus.notify('未确认永久删除成功。请检查会话后再决定是否重试。', false)
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
          unsubscribe?.()
          disconnect?.()
          unregister()
        }
      }, 'session-delete-menu: desktop session action')
    }

    return { apply, inject: ['contextMenus', 'sessions'] }
  },
})
