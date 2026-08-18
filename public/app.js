import { createIcons, icons } from '/vendor/lucide.js'

const sessionToken = document.querySelector('meta[name="git-tool-token"]').content
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]))
const state = {
  config: undefined,
  snapshot: undefined,
  currentPath: '',
  busy: false,
  directoryPath: '',
  directoryParent: '',
  directoryHome: '',
  directoryResolver: undefined,
  recents: loadRecents()
}

createIcons({ icons })
bindEvents()
await loadConfig()
renderRecents()
restoreLastRepository()

function bindEvents() {
  elements['open-repo'].addEventListener('click', () => void openRepository(elements['repo-path'].value))
  elements['pick-repo'].addEventListener('click', () => void chooseRepositoryDirectory())
  elements['empty-pick'].addEventListener('click', () => void chooseRepositoryDirectory())
  elements['repo-path'].addEventListener('keydown', event => { if (event.key === 'Enter') void openRepository(event.currentTarget.value) })
  elements['init-repo'].addEventListener('click', () => void runAction('init', { path: elements['repo-path'].value }))
  elements['notice-init'].addEventListener('click', () => void runAction('init'))
  elements['refresh-repo'].addEventListener('click', () => void refreshRepository())
  elements['open-folder'].addEventListener('click', () => void runAction('openFolder'))
  elements['stage-all'].addEventListener('click', () => void runAction('stageAll'))
  elements['unstage-all'].addEventListener('click', () => void runAction('unstage'))
  elements['save-remote'].addEventListener('click', () => void runAction('remote', { remoteUrl: elements['remote-url'].value }))
  elements['save-identity'].addEventListener('click', () => void runAction('identity', { name: elements['git-name'].value, email: elements['git-email'].value }))
  elements['commit-button'].addEventListener('click', () => void runAction('commit', { message: elements['commit-message'].value, acknowledgeRisks: elements['risk-confirm'].checked }))
  elements['fetch-button'].addEventListener('click', () => void runAction('fetch'))
  elements['completion-refresh'].addEventListener('click', () => void runAction('fetch'))
  elements['completion-open-folder'].addEventListener('click', () => void runAction('openFolder'))
  elements['pull-button'].addEventListener('click', () => void runAction('pullRebase'))
  elements['continue-rebase'].addEventListener('click', () => void runAction('continueRebase'))
  elements['push-button'].addEventListener('click', () => void runAction('push', { acknowledgeRisks: elements['risk-confirm'].checked }))
  elements['open-force'].addEventListener('click', openForceDialog)
  elements['force-submit'].addEventListener('click', event => { event.preventDefault(); void forcePush() })
  elements['open-clone'].addEventListener('click', openCloneDialog)
  elements['empty-clone'].addEventListener('click', openCloneDialog)
  elements['clone-submit'].addEventListener('click', event => { event.preventDefault(); void cloneRepository() })
  elements['pick-clone-root'].addEventListener('click', () => void chooseCloneDirectory())
  elements['directory-go'].addEventListener('click', () => void loadDirectory(elements['directory-current'].value))
  elements['directory-current'].addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); void loadDirectory(event.currentTarget.value) } })
  elements['directory-home'].addEventListener('click', () => void loadDirectory(state.directoryHome))
  elements['directory-up'].addEventListener('click', () => void loadDirectory(state.directoryParent))
  elements['directory-refresh'].addEventListener('click', () => void loadDirectory(state.directoryPath))
  elements['directory-select'].addEventListener('click', () => elements['directory-dialog'].close('select'))
  elements['directory-dialog'].addEventListener('close', finishDirectorySelection)
  elements['clone-url'].addEventListener('input', suggestCloneFolder)
  elements['open-diff'].addEventListener('click', openDiffWindow)
  elements['open-conflict-diff'].addEventListener('click', openDiffWindow)
  elements['open-message-presets'].addEventListener('click', () => elements['commit-presets-dialog'].showModal())
  document.querySelectorAll('.commit-preset').forEach(button => button.addEventListener('click', () => applyCommitPreset(button.dataset.prefix)))
  elements['workflow-next'].addEventListener('click', handleWorkflowNext)
  elements['clear-recents'].addEventListener('click', clearRecents)
  elements['toggle-console'].addEventListener('click', toggleConsole)
}

async function loadConfig() {
  try {
    state.config = await api('/api/config')
    elements['git-version'].textContent = state.config.gitVersion
  } catch (error) {
    showError(error, '加载运行环境')
  }
}

function restoreLastRepository() {
  const lastPath = localStorage.getItem('git-publish:last-path')
  if (lastPath) {
    elements['repo-path'].value = lastPath
    void openRepository(lastPath, false)
  }
}

async function openRepository(repositoryPath, announce = true) {
  if (!repositoryPath?.trim()) return toast('请输入项目目录', true)
  setBusy(true, elements['open-repo'])
  try {
    const snapshot = await api(`/api/repo?path=${encodeURIComponent(repositoryPath.trim())}`)
    acceptSnapshot(snapshot)
    rememberRepository(snapshot.path)
    if (announce) toast('项目已打开')
  } catch (error) {
    showError(error, '打开项目')
  } finally {
    setBusy(false, elements['open-repo'])
  }
}

async function refreshRepository() {
  if (!state.currentPath) return
  await openRepository(state.currentPath, false)
}

async function runAction(action, extra = {}) {
  if (state.busy) return toast('请等待当前操作完成')
  const repositoryPath = extra.path || state.currentPath
  if (!repositoryPath?.trim()) return toast('请先输入或打开项目目录', true)
  const button = actionButton(action)
  setBusy(true, button)
  appendConsole(`> ${actionTitle(action)}\n`)
  try {
    const result = await api('/api/action', {
      method: 'POST',
      body: JSON.stringify({ action, path: repositoryPath, ...extra })
    })
    appendConsole(`${result.output}\n`)
    if (result.notice) showNotification(result.notice, actionTitle(action), result.output)
    acceptSnapshot(result.snapshot)
    rememberRepository(result.snapshot.path)
    if (action === 'commit') elements['commit-message'].value = ''
    toast(`${actionTitle(action)}完成`)
  } catch (error) {
    appendConsole(`${error.detail || error.message}\n`)
    showError(error, actionTitle(action))
    openConsole()
  } finally {
    setBusy(false, button)
  }
}

async function cloneRepository() {
  if (state.busy) return toast('请等待当前操作完成')
  setBusy(true, elements['clone-submit'])
  appendConsole('> 克隆远程仓库\n')
  try {
    const result = await api('/api/clone', {
      method: 'POST',
      body: JSON.stringify({
        remoteUrl: elements['clone-url'].value,
        root: elements['clone-root'].value,
        folderName: elements['clone-folder'].value
      })
    })
    appendConsole(`${result.output}\n`)
    if (result.notice) showNotification(result.notice, '克隆远程仓库', result.output)
    elements['clone-dialog'].close()
    elements['repo-path'].value = result.snapshot.path
    acceptSnapshot(result.snapshot)
    rememberRepository(result.snapshot.path)
    toast('仓库克隆完成')
  } catch (error) {
    appendConsole(`${error.detail || error.message}\n`)
    showError(error, '克隆远程仓库')
    openConsole()
  } finally {
    setBusy(false, elements['clone-submit'])
  }
}

async function chooseRepositoryDirectory() {
  const selectedPath = await pickDirectory(elements['repo-path'].value || state.currentPath)
  if (!selectedPath) return
  elements['repo-path'].value = selectedPath
  await openRepository(selectedPath)
}

async function chooseCloneDirectory() {
  const selectedPath = await pickDirectory(elements['clone-root'].value)
  if (!selectedPath) return
  elements['clone-root'].value = selectedPath
  localStorage.setItem('git-publish:clone-root', selectedPath)
}

async function pickDirectory(initialPath) {
  if (state.busy) {
    toast('请等待当前操作完成')
    return null
  }
  if (state.directoryResolver) return null
  const selection = new Promise(resolve => { state.directoryResolver = resolve })
  state.directoryPath = ''
  elements['directory-select'].disabled = true
  elements['directory-dialog'].showModal()
  createIcons({ icons })
  void loadDirectory(initialPath || state.config?.homeDirectory || '')
  return selection
}

async function loadDirectory(directoryPath) {
  const targetPath = directoryPath?.trim() || state.config?.homeDirectory || ''
  elements['directory-dialog'].classList.add('is-loading')
  elements['directory-select'].disabled = true
  elements['directory-count'].textContent = '正在读取…'
  try {
    const result = await api(`/api/directories?path=${encodeURIComponent(targetPath)}`)
    state.directoryPath = result.path
    state.directoryParent = result.parent || ''
    state.directoryHome = result.home || state.config?.homeDirectory || ''
    elements['directory-current'].value = result.path
    elements['directory-up'].disabled = !result.parent
    elements['directory-select'].disabled = false
    elements['directory-count'].textContent = `${result.entries.length} 个文件夹`
    renderDirectoryRoots(result.roots || [])
    renderDirectoryEntries(result.entries || [])
  } catch (error) {
    showError(error)
  } finally {
    elements['directory-dialog'].classList.remove('is-loading')
  }
}

function renderDirectoryRoots(roots) {
  elements['directory-roots'].replaceChildren(...roots.map(root => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = sameLocalPath(state.directoryPath, root.path) ? 'active' : ''
    button.innerHTML = '<i data-lucide="hard-drive"></i><span></span>'
    button.querySelector('span').textContent = root.name
    button.title = root.path
    button.addEventListener('click', () => void loadDirectory(root.path))
    return button
  }))
  createIcons({ icons })
}

function renderDirectoryEntries(entries) {
  if (!entries.length) {
    elements['directory-list'].innerHTML = '<div class="directory-empty"><i data-lucide="folder-open"></i><span>当前目录没有子文件夹</span></div>'
    createIcons({ icons })
    return
  }
  elements['directory-list'].replaceChildren(...entries.map(entry => {
    const button = document.createElement('button')
    button.type = 'button'
    button.innerHTML = '<span class="directory-folder"><i data-lucide="folder"></i></span><strong></strong><i data-lucide="chevron-right" class="directory-chevron"></i>'
    button.querySelector('strong').textContent = entry.name
    button.title = entry.path
    button.addEventListener('click', () => void loadDirectory(entry.path))
    return button
  }))
  createIcons({ icons })
}

function finishDirectorySelection() {
  const resolve = state.directoryResolver
  if (!resolve) return
  state.directoryResolver = undefined
  resolve(elements['directory-dialog'].returnValue === 'select' ? state.directoryPath : null)
}

async function forcePush() {
  const confirmation = elements['force-confirmation'].value.trim()
  if (confirmation !== 'OVERWRITE') return toast('请输入 OVERWRITE', true)
  elements['force-dialog'].close()
  await runAction('forceLease', { confirmation, acknowledgeRisks: elements['risk-confirm'].checked })
  elements['force-confirmation'].value = ''
}

function acceptSnapshot(snapshot) {
  state.snapshot = snapshot
  state.currentPath = snapshot.path
  elements['repo-path'].value = snapshot.path
  localStorage.setItem('git-publish:last-path', snapshot.path)
  renderSnapshot()
  renderRecents()
}

function renderSnapshot() {
  const snapshot = state.snapshot
  if (!snapshot) return
  elements['empty-state'].classList.add('hidden')
  elements['repo-workspace'].classList.remove('hidden')
  elements['repo-name'].textContent = pathBasename(snapshot.path)
  elements['repo-full-path'].textContent = snapshot.path
  elements['not-repo'].classList.toggle('hidden', snapshot.initialized)
  elements['repo-content'].classList.toggle('hidden', !snapshot.initialized)
  elements['branch-name'].textContent = snapshot.branch || '未初始化'
  const hasUpstream = Boolean(snapshot.upstream)
  elements['upstream-name'].textContent = hasUpstream ? snapshot.upstream : (snapshot.remoteUrl ? '待首次推送' : '未配置远端')
  elements['upstream-name'].title = hasUpstream ? `正在跟踪 ${snapshot.upstream}` : '首次推送成功后建立远端跟踪'
  elements['ahead-count'].textContent = hasUpstream ? (snapshot.ahead || 0) : '—'
  elements['behind-count'].textContent = hasUpstream ? (snapshot.behind || 0) : '—'
  elements['ahead-count'].parentElement.title = hasUpstream ? '本地领先远端的提交数量' : '尚未建立远端跟踪，暂时无法计算'
  elements['behind-count'].parentElement.title = hasUpstream ? '远端领先本地的提交数量' : '尚未建立远端跟踪，暂时无法计算'
  elements['remote-url'].value = snapshot.remoteUrl || ''
  elements['git-name'].value = snapshot.identity?.name || ''
  elements['git-email'].value = snapshot.identity?.email || ''
  elements['identity-source'].textContent = snapshot.identity?.scope === 'local' ? '仓库配置' : snapshot.identity?.scope === 'inherited' ? '继承全局配置' : '未配置'
  elements['identity-source'].className = snapshot.identity?.name || snapshot.identity?.email ? 'configured' : ''
  elements['remote-source'].textContent = snapshot.remoteUrl ? '仓库配置' : '未配置'
  elements['remote-source'].className = snapshot.remoteUrl ? 'configured' : ''
  elements['config-path'].textContent = snapshot.configPath || '.git/config'
  elements['config-path'].title = snapshot.configPath || '.git/config'
  renderChanges(snapshot)
  renderCommits(snapshot.recentCommits || [])
  renderWorkflow(snapshot)
  renderSyncGuidance(snapshot)
  renderCompletion(snapshot)
  updateButtons(snapshot)
  createIcons({ icons })
}

function renderChanges(snapshot) {
  const changes = snapshot.changes || []
  const staged = changes.filter(change => change.staged).length
  const unstaged = changes.length - staged
  elements['change-summary'].textContent = changes.length ? `${staged} 个已暂存 · ${unstaged} 个未暂存` : '工作区干净'
  elements['change-list'].innerHTML = changes.map(change => `<div class="change-row"><span class="status-badge ${change.staged ? 'staged' : ''} ${change.label === '冲突' ? 'conflict' : ''}">${escapeHtml(change.label)}</span><span class="file-path" title="${escapeHtml(change.path)}">${escapeHtml(change.path)}</span><span class="area-label">${change.staged ? '暂存区' : change.untracked ? '未跟踪' : '工作区'}</span></div>`).join('')
  elements['changes-empty'].classList.toggle('hidden', changes.length > 0)
  elements['change-list'].classList.toggle('hidden', changes.length === 0)
  const risks = snapshot.risks || []
  const conflicts = snapshot.conflicts || snapshot.changes?.filter(change => change.conflict).map(change => change.path) || []
  elements['risk-banner'].classList.toggle('hidden', risks.length === 0)
  elements['risk-confirm-wrap'].classList.toggle('hidden', risks.length === 0)
  elements['risk-list'].innerHTML = risks.map(risk => `<li><strong>${escapeHtml(risk.path)}</strong>：${escapeHtml(risk.message)}</li>`).join('')
  if (!risks.length) elements['risk-confirm'].checked = false
  elements['conflict-banner'].classList.toggle('hidden', conflicts.length === 0 && !snapshot.rebaseInProgress)
  elements['conflict-help'].textContent = snapshot.rebaseInProgress
    ? (conflicts.length ? '请先处理并暂存所有冲突文件，再点击“继续变基”。' : '冲突已处理。请确认变更已暂存，然后点击“继续变基”。')
    : '请先在编辑器中处理冲突文件，再暂存并继续变基。'
  elements['continue-rebase'].classList.toggle('hidden', !snapshot.rebaseInProgress)
  elements['staged-stat'].textContent = snapshot.stagedStat || ''
  elements['staged-stat'].classList.toggle('hidden', !snapshot.stagedStat)
}

function renderCommits(commits) {
  elements['commit-list'].innerHTML = commits.length
    ? commits.map(commit => `<div class="commit-row"><span class="commit-sha">${escapeHtml(commit.sha)}</span><span class="commit-subject">${escapeHtml(commit.subject)}</span><span class="commit-time">${escapeHtml(commit.relativeTime || '')}</span></div>`).join('')
    : '<div class="list-empty"><span>还没有本地提交</span></div>'
}

function renderWorkflow(snapshot) {
  const steps = ['settings', 'stage', 'commit', 'sync'].map(name => elements[`workflow-step-${name}`])
  steps.forEach(step => step.classList.remove('active', 'complete', 'blocked'))
  const button = elements['workflow-next']
  let current = 0
  let title = '准备工作区'
  let description = '打开仓库后，按当前状态完成下一步。'
  let action = ''
  let focus = ''
  let buttonText = '下一步'
  let view = 'settings'
  const initialized = snapshot.initialized
  const changes = snapshot.changes || []
  const stagedCount = changes.filter(change => change.staged).length
  const conflictCount = changes.filter(change => change.conflict).length
  const hasIdentity = Boolean(snapshot.identity?.name && snapshot.identity?.email)

  if (!initialized) {
    title = '先初始化仓库'
    description = '这个目录还不是 Git 仓库，初始化后才能继续。'
    action = 'init'
    buttonText = '初始化 Git'
  } else if (snapshot.rebaseInProgress) {
    view = 'conflict'
    current = 3
    title = conflictCount ? '先解决冲突' : '继续当前变基'
    description = conflictCount ? '打开 Diff，处理冲突并暂存文件。' : '冲突已处理，确认暂存后继续变基。'
    action = conflictCount ? 'openConflictDiff' : 'continueRebase'
    buttonText = conflictCount ? '查看冲突 Diff' : '继续变基'
    if (conflictCount) steps[3].classList.add('blocked')
  } else if (!snapshot.remoteUrl) {
    view = 'settings'
    title = '配置远程仓库'
    description = '先填写 origin 地址，之后才能推送或拉取。'
    focus = 'remote-url'
    buttonText = '填写远程地址'
  } else if (!hasIdentity) {
    view = 'settings'
    title = '配置提交身份'
    description = '提交前需要 Git 用户名和邮箱。'
    focus = 'git-name'
    buttonText = '填写提交身份'
  } else if (changes.length > 0 && stagedCount === 0) {
    view = 'stage'
    current = 1
    title = '暂存要提交的文件'
    description = '先把本次要发布的文件放入暂存区。'
    action = 'stageAll'
    buttonText = '全部暂存'
  } else if (stagedCount > 0) {
    view = 'commit'
    current = 2
    title = '检查 Diff 并创建提交'
    description = '确认修改前后差异，再填写提交说明。'
    action = 'openDiff'
    buttonText = '查看提交前 Diff'
  } else if (!snapshot.upstream && (snapshot.recentCommits || []).length > 0) {
    view = 'sync'
    current = 3
    title = '首次推送到远端'
    description = '本地已有提交，但尚未建立远端分支跟踪。'
    action = 'push'
    buttonText = '首次推送'
  } else if (!snapshot.upstream) {
    view = 'sync'
    current = 3
    title = '检查远端仓库'
    description = '当前分支尚未建立远端跟踪，请先刷新远端状态。'
    action = 'fetch'
    buttonText = '刷新远端状态'
  } else if ((snapshot.ahead || 0) > 0 && (snapshot.behind || 0) === 0) {
    view = 'sync'
    current = 3
    title = '推送本地提交'
    description = `本地有 ${snapshot.ahead} 个提交尚未同步到远端。`
    action = 'push'
    buttonText = '推送到远端'
  } else if ((snapshot.behind || 0) > 0) {
    view = 'sync'
    current = 3
    title = '同步远端更新'
    description = `远端领先 ${snapshot.behind} 个提交，先拉取并变基。`
    action = 'pullRebase'
    buttonText = '拉取并变基'
  } else {
    view = 'sync'
    current = 4
    title = '工作区已同步'
    description = '当前分支、暂存区和远端没有待处理事项。'
    buttonText = '已完成'
  }

  steps.forEach((step, index) => {
    if (current === 4 || index < current) step.classList.add('complete')
    if (current < 4 && index === current) step.classList.add('active')
  })
  elements['workflow-title'].textContent = title
  elements['workflow-description'].textContent = description
  button.querySelector('span').textContent = buttonText
  button.dataset.action = action
  button.dataset.focus = focus
  button.disabled = !action && !focus
  elements['repo-content'].className = `workspace-grid workflow-view-${view}${current === 4 ? ' workflow-complete' : ''}`
  elements['repo-state'].textContent = title
  elements['repo-state'].className = `repo-state ${current === 4 ? 'state-success' : conflictCount ? 'state-danger' : current === 3 ? 'state-sync' : 'state-active'}`
}

function handleWorkflowNext() {
  const action = elements['workflow-next'].dataset.action
  const focus = elements['workflow-next'].dataset.focus
  if (action === 'openDiff' || action === 'openConflictDiff') return openDiffWindow()
  if (focus) return elements[focus]?.focus()
  if (action) void runAction(action, { acknowledgeRisks: elements['risk-confirm'].checked })
}

function applyCommitPreset(prefix) {
  const textarea = elements['commit-message']
  const content = textarea.value.replace(/^[a-z]+:\s*/i, '').trimStart()
  textarea.value = `${prefix} ${content}`
  textarea.focus()
  textarea.setSelectionRange(textarea.value.length, textarea.value.length)
  if (navigator.clipboard) void navigator.clipboard.writeText(prefix).catch(() => {})
  elements['commit-presets-dialog'].close()
  toast(`${prefix} 已复制并填入`)
}

function renderSyncGuidance(snapshot) {
  const guidance = elements['sync-guidance']
  if (!guidance) return
  const ahead = snapshot.ahead || 0
  const behind = snapshot.behind || 0
  const hasLocalCommits = (snapshot.recentCommits || []).length > 0
  elements['push-button'].querySelector('span').textContent = !snapshot.upstream && hasLocalCommits ? '首次推送' : '推送提交'
  const icon = guidance.querySelector('svg')
  guidance.classList.remove('sync-ready', 'sync-pull', 'sync-push', 'sync-blocked')
  if (snapshot.rebaseInProgress || (snapshot.changes || []).some(change => change.conflict)) {
    guidance.classList.add('sync-blocked')
    guidance.querySelector('strong').textContent = '请先处理当前变基或冲突'
    guidance.querySelector('span').textContent = '同步按钮已暂停，完成冲突处理后再继续。'
  } else if (!snapshot.upstream && hasLocalCommits) {
    guidance.classList.add('sync-push')
    guidance.querySelector('strong').textContent = '需要完成首次推送'
    guidance.querySelector('span').textContent = '本地已有提交，但尚未关联远端分支。首次推送后才算同步完成。'
  } else if (!snapshot.upstream) {
    guidance.classList.add('sync-pull')
    guidance.querySelector('strong').textContent = '尚未建立远端跟踪'
    guidance.querySelector('span').textContent = '先刷新远端状态，确认远端分支后再继续。'
  } else if (behind > 0) {
    guidance.classList.add('sync-pull')
    guidance.querySelector('strong').textContent = '建议先拉取并变基'
    guidance.querySelector('span').textContent = `远端领先 ${behind} 个提交，处理远端更新后才能安全推送。`
  } else if (ahead > 0) {
    guidance.classList.add('sync-push')
    guidance.querySelector('strong').textContent = '建议推送本地提交'
    guidance.querySelector('span').textContent = `本地有 ${ahead} 个提交等待上传到远端。`
  } else {
    guidance.classList.add('sync-ready')
    guidance.querySelector('strong').textContent = '工作区已同步'
    guidance.querySelector('span').textContent = '当前不需要执行同步操作，可用“刷新远端状态”再次确认。'
  }
  if (icon) icon.setAttribute('data-lucide', behind > 0 ? 'arrow-down-to-line' : ahead > 0 || (!snapshot.upstream && hasLocalCommits) ? 'arrow-up-from-line' : 'circle-check-big')
  createIcons({ icons })
}

function renderCompletion(snapshot) {
  const complete = snapshot.initialized && Boolean(snapshot.remoteUrl) && Boolean(snapshot.upstream) && !snapshot.rebaseInProgress
    && !(snapshot.changes || []).some(change => change.conflict)
    && (snapshot.changes || []).length === 0
    && (snapshot.ahead || 0) === 0
    && (snapshot.behind || 0) === 0
  const summary = elements['completion-summary']
  summary.classList.toggle('hidden', !complete)
  elements['completion-branch'].textContent = snapshot.branch || '当前分支'
  elements['completion-remote'].textContent = complete ? 'origin 已同步' : '等待同步'
  elements['completion-changes'].textContent = `${snapshot.changes?.length || 0} 个`
}

function updateButtons(snapshot) {
  const initialized = snapshot.initialized
  const stagedCount = snapshot.changes?.filter(change => change.staged).length || 0
  const changeCount = snapshot.changes?.length || 0
  const conflictCount = snapshot.changes?.filter(change => change.conflict).length || 0
  elements['stage-all'].disabled = !initialized || changeCount === 0
  elements['unstage-all'].disabled = !initialized || stagedCount === 0
  elements['commit-button'].disabled = !initialized || stagedCount === 0 || conflictCount > 0
  elements['open-diff'].disabled = !initialized || stagedCount === 0
  const ahead = snapshot.ahead || 0
  const behind = snapshot.behind || 0
  const firstPush = !snapshot.upstream && (snapshot.recentCommits || []).length > 0
  elements['fetch-button'].disabled = !snapshot.remoteUrl || snapshot.rebaseInProgress
  const syncBlocked = conflictCount > 0 || snapshot.rebaseInProgress
  elements['pull-button'].disabled = !snapshot.remoteUrl || syncBlocked || behind === 0
  elements['push-button'].disabled = !snapshot.remoteUrl || syncBlocked || behind > 0 || (ahead === 0 && !firstPush)
  elements['open-force'].disabled = !snapshot.remoteUrl || syncBlocked
  elements['continue-rebase'].disabled = !snapshot.rebaseInProgress || conflictCount > 0
  elements['fetch-button'].classList.remove('recommended')
  elements['pull-button'].classList.remove('recommended')
  elements['push-button'].classList.remove('recommended')
  if (!syncBlocked && behind > 0) elements['pull-button'].classList.add('recommended')
  else if (!syncBlocked && (ahead > 0 || firstPush)) elements['push-button'].classList.add('recommended')
}

function rememberRepository(repositoryPath) {
  state.recents = [repositoryPath, ...state.recents.filter(item => !sameLocalPath(item, repositoryPath))].slice(0, 12)
  localStorage.setItem('git-publish:recents', JSON.stringify(state.recents))
}

function renderRecents() {
  elements['recent-list'].innerHTML = state.recents.length
    ? state.recents.map(repositoryPath => `<button class="recent-item ${sameLocalPath(state.currentPath, repositoryPath) ? 'active' : ''}" data-path="${escapeHtml(repositoryPath)}"><span class="recent-icon"><i data-lucide="folder-git-2"></i></span><span class="recent-copy"><strong>${escapeHtml(pathBasename(repositoryPath))}</strong><span>${escapeHtml(repositoryPath)}</span></span></button>`).join('')
    : '<div class="list-empty"><span>暂无记录</span></div>'
  elements['recent-list'].querySelectorAll('[data-path]').forEach(button => button.addEventListener('click', () => void openRepository(button.dataset.path)))
  createIcons({ icons })
}

function clearRecents() {
  state.recents = []
  state.snapshot = undefined
  state.currentPath = ''
  localStorage.removeItem('git-publish:recents')
  localStorage.removeItem('git-publish:last-path')
  elements['repo-path'].value = ''
  elements['repo-workspace'].classList.add('hidden')
  elements['empty-state'].classList.remove('hidden')
  renderRecents()
  toast('最近记录已清空')
}

function openCloneDialog() {
  const rememberedRoot = localStorage.getItem('git-publish:clone-root')
  elements['clone-root'].value = rememberedRoot || parentDirectory(state.currentPath) || state.config?.homeDirectory || ''
  elements['clone-dialog'].showModal()
}

function openDiffWindow() {
  if (!state.currentPath || (!state.snapshot?.changes?.some(change => change.staged) && !(state.snapshot?.conflictFiles || []).length)) return toast('暂存区还没有内容', true)
  const features = `popup=yes,width=${screen.availWidth},height=${screen.availHeight},left=0,top=0`
  const diffWindow = window.open(`/diff?path=${encodeURIComponent(state.currentPath)}`, 'git-publish-diff', features)
  if (!diffWindow) toast('浏览器拦截了 Diff 窗口，请允许弹出窗口', true)
}

function suggestCloneFolder() {
  if (elements['clone-folder'].value.trim()) return
  const remote = elements['clone-url'].value.trim().replace(/\/$/, '')
  const suggestion = remote.split(/[/:]/).pop()?.replace(/\.git$/i, '')
  if (suggestion) elements['clone-folder'].value = suggestion
}

function openForceDialog() {
  if (!state.snapshot) return
  elements['force-target'].textContent = `${state.snapshot.branch} 将覆盖 origin/${state.snapshot.branch}`
  elements['force-confirmation'].value = ''
  elements['force-dialog'].showModal()
}

function toggleConsole() {
  const collapsed = elements['console-panel'].classList.toggle('collapsed')
  elements['console-chevron'].setAttribute('data-lucide', collapsed ? 'chevron-up' : 'chevron-down')
  createIcons({ icons })
}

function openConsole() {
  elements['console-panel'].classList.remove('collapsed')
  elements['console-chevron'].setAttribute('data-lucide', 'chevron-down')
  createIcons({ icons })
}

function appendConsole(text) {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  elements['console-output'].textContent += `\n[${timestamp}] ${text}`
  elements['console-output'].scrollTop = elements['console-output'].scrollHeight
}

async function api(url, options = {}) {
  const headers = { 'X-Git-Tool-Token': sessionToken, ...(options.headers || {}) }
  if (options.method && options.method !== 'GET') {
    headers['Content-Type'] = 'application/json'
  }
  const response = await fetch(url, { ...options, headers })
  const payload = await response.json().catch(() => ({}))
  if (!response.ok) {
    if (response.status === 403 && String(payload.message || '').includes('会话已失效')) {
      location.reload()
      throw new Error('页面会话已更新，正在重新加载')
    }
    const error = new Error(payload.message || '请求失败')
    error.detail = payload.detail
    error.guidance = payload.guidance
    throw error
  }
  return payload
}

function setBusy(busy, button, message = '正在处理…') {
  state.busy = busy
  document.body.classList.toggle('is-busy', busy)
  elements['busy-text'].textContent = message
  elements['busy-indicator'].classList.toggle('visible', busy)
  if (button) button.disabled = busy
  if (!busy && state.snapshot) updateButtons(state.snapshot)
}

function actionButton(action) {
  return ({ init: elements['init-repo'], stageAll: elements['stage-all'], unstage: elements['unstage-all'], remote: elements['save-remote'], identity: elements['save-identity'], commit: elements['commit-button'], fetch: elements['fetch-button'], pullRebase: elements['pull-button'], continueRebase: elements['continue-rebase'], push: elements['push-button'], forceLease: elements['force-submit'], openFolder: elements['open-folder'] })[action]
}

function actionTitle(action) {
  return ({ init: '初始化仓库', stageAll: '暂存全部变更', unstage: '取消暂存', remote: '保存远程地址', identity: '保存提交身份', commit: '创建提交', fetch: '获取远端状态', pullRebase: '拉取并变基', continueRebase: '继续变基', push: '推送远端', forceLease: '安全覆盖远端', openFolder: '打开项目目录' })[action] || action
}

function toast(message, error = false) {
  elements.toast.textContent = message
  elements.toast.classList.toggle('error', error)
  elements.toast.classList.add('visible')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => elements.toast.classList.remove('visible'), 2600)
}

function showError(error, context = '操作') {
  toast(error.message || '操作失败', true)
  showNotification(error.guidance || fallbackGuidance(error), context, error.detail)
}

function fallbackGuidance(error) {
  return {
    level: 'error',
    title: error.message || '操作未完成',
    summary: '请根据技术详情检查仓库状态或配置后重试。',
    actions: ['展开操作输出查看完整 Git 信息。', '确认当前分支、远程地址和账号权限是否正确。']
  }
}

function showNotification(notice, context = 'Git 操作', detail = '') {
  if (!notice) return
  const panel = document.createElement('section')
  panel.className = `operation-notification ${notice.level === 'warning' ? 'warning' : 'error'}`
  panel.innerHTML = '<div class="notification-icon"><i data-lucide="triangle-alert"></i></div><div class="notification-content"><span class="notification-context"></span><h2></h2><p></p><ol></ol><details><summary>技术详情</summary><pre></pre></details><div class="notification-actions"><button type="button" class="notification-console"><i data-lucide="terminal-square"></i><span>查看操作输出</span></button><button type="button" class="notification-close">关闭</button></div></div>'
  panel.querySelector('.notification-context').textContent = context
  panel.querySelector('h2').textContent = notice.title || 'Git 返回了提示'
  panel.querySelector('p').textContent = notice.summary || ''
  const actions = Array.isArray(notice.actions) ? notice.actions : []
  const actionList = panel.querySelector('ol')
  actionList.replaceChildren(...actions.map(action => {
    const item = document.createElement('li')
    item.textContent = action
    return item
  }))
  actionList.classList.toggle('hidden', actions.length === 0)
  const technicalDetail = detail || notice.detail || ''
  const details = panel.querySelector('details')
  details.classList.toggle('hidden', !technicalDetail)
  details.querySelector('pre').textContent = technicalDetail
  panel.querySelector('.notification-console').addEventListener('click', openConsole)
  panel.querySelector('.notification-close').addEventListener('click', () => panel.remove())
  elements['notification-stack'].prepend(panel)
  while (elements['notification-stack'].children.length > 3) elements['notification-stack'].lastElementChild.remove()
  createIcons({ icons })
}

function loadRecents() {
  try { return JSON.parse(localStorage.getItem('git-publish:recents') || '[]') }
  catch { return [] }
}

function pathBasename(value) {
  return value.replace(/[\\/]$/, '').split(/[\\/]/).pop() || value
}

function sameLocalPath(left, right) {
  if (!left || !right) return left === right
  return state.config?.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function parentDirectory(value) {
  if (!value) return ''
  const normalized = value.replace(/[\\/]$/, '')
  const separatorIndex = Math.max(normalized.lastIndexOf('\\'), normalized.lastIndexOf('/'))
  if (separatorIndex === 0) return normalized.slice(0, 1)
  if (separatorIndex === 2 && /^[a-z]:/i.test(normalized)) return normalized.slice(0, 3)
  if (separatorIndex < 0) return ''
  return normalized.slice(0, separatorIndex)
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character])
}
