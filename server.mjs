import http from 'node:http'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const appDirectory = path.dirname(fileURLToPath(import.meta.url))
const publicDirectory = path.join(appDirectory, 'public')
const vendorDirectory = path.join(appDirectory, 'node_modules', 'lucide', 'dist', 'esm')
const port = Number(process.env.PORT || 4399)
const sessionToken = randomBytes(32).toString('hex')

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml']
])

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    if (request.method === 'GET' && url.pathname === '/') {
      const html = (await fs.readFile(path.join(publicDirectory, 'index.html'), 'utf8'))
        .replace('__SESSION_TOKEN__', sessionToken)
      return send(response, 200, html, 'text/html; charset=utf-8')
    }
    if (request.method === 'GET' && url.pathname === '/diff') {
      const html = (await fs.readFile(path.join(publicDirectory, 'diff.html'), 'utf8'))
        .replace('__SESSION_TOKEN__', sessionToken)
      return send(response, 200, html, 'text/html; charset=utf-8')
    }
    if (request.method === 'GET' && url.pathname.startsWith('/vendor/')) {
      return serveStatic(response, vendorDirectory, url.pathname.slice('/vendor/'.length))
    }
    if (request.method === 'GET' && url.pathname.startsWith('/assets/')) {
      return serveStatic(response, publicDirectory, url.pathname.slice('/assets/'.length))
    }
    if (request.method === 'GET' && url.pathname === '/api/config') {
      requirePageAuthorization(request)
      const git = await runGit(['--version'])
      return sendJson(response, 200, {
        gitVersion: git.stdout.trim(),
        platform: process.platform,
        homeDirectory: os.homedir(),
        pathSeparator: path.sep,
        port
      })
    }
    if (request.method === 'GET' && url.pathname === '/api/repo') {
      requirePageAuthorization(request)
      const repositoryPath = await requireDirectoryPath(url.searchParams.get('path'), { mustExist: true })
      return sendJson(response, 200, await repositorySnapshot(repositoryPath))
    }
    if (request.method === 'GET' && url.pathname === '/api/diff') {
      requirePageAuthorization(request)
      const repositoryPath = await requireDirectoryPath(url.searchParams.get('path'), { mustExist: true })
      await requireRepository(repositoryPath)
      const result = await runGit(['-C', repositoryPath, 'diff', '--cached', '--no-color', '--find-renames', '--unified=4'], { maxBuffer: 16 * 1024 * 1024 })
      const snapshot = await repositorySnapshot(repositoryPath)
      return sendJson(response, 200, { path: repositoryPath, diff: result.stdout, conflicts: snapshot.conflictFiles || [] })
    }
    if (request.method === 'GET' && url.pathname === '/api/directories') {
      requirePageAuthorization(request)
      return sendJson(response, 200, await listDirectories(url.searchParams.get('path')))
    }
    if (request.method === 'POST' && url.pathname === '/api/pick-directory') {
      requirePageAuthorization(request)
      throw httpError(410, '目录选择方式已更新，请刷新页面')
    }
    if (request.method === 'POST' && url.pathname === '/api/clone') {
      requirePageAuthorization(request)
      const body = await readJson(request)
      const result = await cloneRepository(body)
      return sendJson(response, 200, result)
    }
    if (request.method === 'POST' && url.pathname === '/api/action') {
      requirePageAuthorization(request)
      const body = await readJson(request)
      const result = await performAction(body)
      return sendJson(response, 200, result)
    }
    sendJson(response, 404, { message: '接口不存在' })
  } catch (error) {
    const status = Number(error.statusCode) || 500
    sendJson(response, status, {
      message: status >= 500 ? '操作失败，请查看终端输出' : error.message,
      detail: error.publicDetail || undefined,
      guidance: error.publicGuidance || undefined
    })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`Git Publish Studio: http://127.0.0.1:${port}`)
  console.log(`Platform: ${process.platform}; Home: ${os.homedir()}`)
})

async function performAction(body) {
  const action = String(body.action || '')
  if (action === 'init') {
    const repositoryPath = await requireDirectoryPath(body.path, { mustExist: false, create: true })
    const result = await runGit(['init', repositoryPath])
    await runGit(['-C', repositoryPath, 'branch', '-M', 'main'], { allowFailure: true })
    return actionResult(repositoryPath, result)
  }

  const repositoryPath = await requireDirectoryPath(body.path, { mustExist: true })
  await requireRepository(repositoryPath)
  let result
  switch (action) {
    case 'identity': {
      const name = validateText(body.name, '用户名', 120)
      const email = validateEmail(body.email)
      await runGit(['-C', repositoryPath, 'config', 'user.name', name])
      result = await runGit(['-C', repositoryPath, 'config', 'user.email', email])
      break
    }
    case 'remote': {
      const remoteUrl = validateRemoteUrl(body.remoteUrl)
      const exists = (await runGit(['-C', repositoryPath, 'remote'], { allowFailure: true })).stdout
        .split(/\r?\n/).includes('origin')
      result = await runGit(['-C', repositoryPath, 'remote', exists ? 'set-url' : 'add', 'origin', remoteUrl])
      break
    }
    case 'stageAll': {
      const conflictMarkers = await findConflictMarkers(repositoryPath)
      if (conflictMarkers.length > 0) {
        throw httpError(409, `以下冲突文件仍保留冲突标记：${conflictMarkers.join('、')}`)
      }
      result = await runGit(['-C', repositoryPath, 'add', '-A'])
      break
    }
    case 'unstage':
      result = await runGit(['-C', repositoryPath, 'reset'])
      break
    case 'commit': {
      const snapshot = await repositorySnapshot(repositoryPath)
      enforceRiskAcknowledgement(snapshot, body.acknowledgeRisks)
      const commitMessage = validateText(body.message, '提交说明', 200)
      result = await runGit(['-C', repositoryPath, 'commit', '-m', commitMessage])
      break
    }
    case 'fetch':
      result = await runGit(['-C', repositoryPath, 'fetch', 'origin'], { timeout: 120000 })
      break
    case 'pullRebase': {
      const branch = await currentBranch(repositoryPath)
      result = await runGit(['-C', repositoryPath, 'pull', '--rebase', 'origin', branch], { timeout: 120000 })
      break
    }
    case 'continueRebase': {
      const snapshot = await repositorySnapshot(repositoryPath)
      if (!snapshot.rebaseInProgress) throw httpError(409, '当前仓库没有正在进行的变基')
      if ((snapshot.conflictFiles || []).length > 0) {
        throw httpError(409, '仍有未解决的冲突文件，请先处理并暂存冲突文件')
      }
      // 使用已有提交说明继续变基，避免后台进程等待编辑器输入。
      result = await runGit(['-C', repositoryPath, '-c', 'core.editor=true', 'rebase', '--continue'], { timeout: 120000 })
      break
    }
    case 'push': {
      const snapshot = await repositorySnapshot(repositoryPath)
      enforceRiskAcknowledgement(snapshot, body.acknowledgeRisks)
      const branch = await currentBranch(repositoryPath)
      result = await runGit(['-C', repositoryPath, 'push', '-u', 'origin', branch], { timeout: 120000 })
      break
    }
    case 'forceLease': {
      if (body.confirmation !== 'OVERWRITE') throw httpError(400, '请输入 OVERWRITE 确认覆盖远端')
      const snapshot = await repositorySnapshot(repositoryPath)
      enforceRiskAcknowledgement(snapshot, body.acknowledgeRisks)
      const branch = await currentBranch(repositoryPath)
      await runGit(['-C', repositoryPath, 'fetch', 'origin', `${branch}:refs/remotes/origin/${branch}`], { timeout: 120000 })
      result = await runGit(['-C', repositoryPath, 'push', '--force-with-lease', '-u', 'origin', branch], { timeout: 120000 })
      break
    }
    case 'openFolder':
      openDirectory(repositoryPath)
      result = { stdout: `已打开 ${repositoryPath}`, stderr: '', exitCode: 0 }
      break
    default:
      throw httpError(400, '不支持的 Git 操作')
  }
  return actionResult(repositoryPath, result)
}

async function cloneRepository(body) {
  const remoteUrl = validateRemoteUrl(body.remoteUrl)
  const root = await requireDirectoryPath(body.root, { mustExist: true })
  const folderName = String(body.folderName || '').trim()
  if (!/^[\p{L}\p{N}._-]{1,120}$/u.test(folderName) || folderName === '.' || folderName === '..') {
    throw httpError(400, '目标目录名只能包含文字、数字、点、短横线和下划线')
  }
  const targetPath = path.resolve(root, folderName)
  if (!isDirectChild(root, targetPath)) throw httpError(400, '目标目录必须位于所选保存位置内')
  const exists = await fs.stat(targetPath).then(() => true).catch(() => false)
  if (exists) {
    const entries = await fs.readdir(targetPath)
    if (entries.length > 0) throw httpError(409, '目标目录已存在且不为空')
  }
  const result = await runGit(['clone', remoteUrl, targetPath], { timeout: 300000 })
  return actionResult(targetPath, result)
}

async function repositorySnapshot(repositoryPath) {
  const repoCheck = await runGit(['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') {
    return { path: repositoryPath, initialized: false, branch: null, remoteUrl: null, upstream: null, ahead: 0, behind: 0, identity: {}, configPath: null, changes: [], risks: [], stagedStat: '', recentCommits: [] }
  }
  const [branchResult, remoteResult, upstreamResult, statusResult, nameResult, emailResult, localNameResult, localEmailResult, configPathResult, logResult, unmergedResult] = await Promise.all([
    runGit(['-C', repositoryPath, 'symbolic-ref', '--short', 'HEAD'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'remote', 'get-url', 'origin'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'status', '--porcelain=v1', '--untracked-files=all']),
    runGit(['-C', repositoryPath, 'config', 'user.name'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'config', 'user.email'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'config', '--local', 'user.name'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'config', '--local', 'user.email'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'rev-parse', '--git-path', 'config'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'log', '-6', '--pretty=format:%h%x09%s%x09%cr'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'ls-files', '-u', '-z'], { allowFailure: true })
  ])
  const unmergedFiles = parseUnmergedFiles(unmergedResult.stdout)
  const conflictPaths = new Set(unmergedFiles.map(file => file.path))
  const rebaseInProgress = await isRebaseInProgress(repositoryPath)
  const detached = branchResult.exitCode !== 0
  const branch = detached ? '游离 HEAD' : (branchResult.stdout.trim() || 'main')
  const upstream = upstreamResult.exitCode === 0 ? upstreamResult.stdout.trim() : null
  let ahead = 0
  let behind = 0
  if (upstream) {
    const counts = await runGit(['-C', repositoryPath, 'rev-list', '--left-right', '--count', `HEAD...${upstream}`], { allowFailure: true })
    const [localCount, remoteCount] = counts.stdout.trim().split(/\s+/).map(Number)
    ahead = Number.isFinite(localCount) ? localCount : 0
    behind = Number.isFinite(remoteCount) ? remoteCount : 0
  }
  const changes = parseStatus(statusResult.stdout, conflictPaths)
  const stagedStatResult = await runGit(['-C', repositoryPath, 'diff', '--cached', '--stat'], { allowFailure: true })
  return {
    path: repositoryPath,
    initialized: true,
    branch,
    detached,
    rebaseInProgress,
    conflictFiles: await readConflictFiles(repositoryPath, unmergedFiles),
    remoteUrl: remoteResult.exitCode === 0 ? remoteResult.stdout.trim() : null,
    upstream,
    ahead,
    behind,
    identity: {
      name: nameResult.stdout.trim(),
      email: emailResult.stdout.trim(),
      scope: localNameResult.stdout.trim() || localEmailResult.stdout.trim() ? 'local' : (nameResult.stdout.trim() || emailResult.stdout.trim() ? 'inherited' : 'none')
    },
    configPath: resolveGitConfigPath(repositoryPath, configPathResult.stdout.trim()),
    changes,
    risks: await detectRisks(repositoryPath, changes),
    stagedStat: stagedStatResult.stdout.trim(),
    recentCommits: logResult.stdout.trim() ? logResult.stdout.trim().split(/\r?\n/).map(line => {
      const [sha, subject, relativeTime] = line.split('\t')
      return { sha, subject, relativeTime }
    }) : []
  }
}

function parseStatus(output, conflictPaths = new Set()) {
  return output.split(/\r?\n/).filter(Boolean).map(line => {
    const indexStatus = line.slice(0, 1)
    const worktreeStatus = line.slice(1, 2)
    const filePath = line.slice(3).replace(/^"|"$/g, '')
    return {
      path: filePath,
      indexStatus,
      worktreeStatus,
      staged: indexStatus !== ' ' && indexStatus !== '?',
      untracked: indexStatus === '?' && worktreeStatus === '?',
      conflict: conflictPaths.has(filePath),
      label: conflictPaths.has(filePath) ? '冲突' : statusLabel(indexStatus, worktreeStatus)
    }
  })
}

async function isRebaseInProgress(repositoryPath) {
  const [mergePathResult, applyPathResult] = await Promise.all([
    runGit(['-C', repositoryPath, 'rev-parse', '--git-path', 'rebase-merge'], { allowFailure: true }),
    runGit(['-C', repositoryPath, 'rev-parse', '--git-path', 'rebase-apply'], { allowFailure: true })
  ])
  const candidates = [mergePathResult.stdout.trim(), applyPathResult.stdout.trim()]
    .filter(Boolean)
    .map(value => path.isAbsolute(value) ? value : path.resolve(repositoryPath, value))
  for (const candidate of candidates) {
    if (await fs.stat(candidate).then(() => true).catch(() => false)) return true
  }
  return false
}

async function findConflictMarkers(repositoryPath) {
  const result = await runGit(['-C', repositoryPath, 'diff', '--name-only', '--diff-filter=U', '-z'], { allowFailure: true })
  const paths = result.stdout.split('\0').filter(Boolean)
  const marked = []
  for (const filePath of paths) {
    const content = await fs.readFile(path.resolve(repositoryPath, filePath), 'utf8').catch(() => '')
    if (/^(<<<<<<<|=======|>>>>>>>)(?:\s|$)/m.test(content)) marked.push(filePath)
  }
  return marked
}

function parseUnmergedFiles(output) {
  const files = new Map()
  for (const record of String(output || '').split('\0').filter(Boolean)) {
    const match = record.match(/^\d+\s+([0-9a-f]+)\s+(\d)\t(.+)$/)
    if (!match) continue
    const [, objectId, stage, filePath] = match
    const entry = files.get(filePath) || { path: filePath, stages: {} }
    entry.stages[stage] = objectId
    files.set(filePath, entry)
  }
  return [...files.values()]
}

async function readConflictFiles(repositoryPath, files) {
  return Promise.all(files.map(async file => {
    const [oursResult, theirsResult, worktreeResult] = await Promise.all([
      file.stages['2'] ? runGit(['-C', repositoryPath, 'show', `:2:${file.path}`], { allowFailure: true, maxBuffer: 8 * 1024 * 1024 }) : { stdout: '' },
      file.stages['3'] ? runGit(['-C', repositoryPath, 'show', `:3:${file.path}`], { allowFailure: true, maxBuffer: 8 * 1024 * 1024 }) : { stdout: '' },
      fs.readFile(path.resolve(repositoryPath, file.path), 'utf8').catch(() => '')
    ])
    return {
      path: file.path,
      ours: normalizeConflictText(oursResult.stdout),
      theirs: normalizeConflictText(theirsResult.stdout),
      worktree: normalizeConflictText(typeof worktreeResult === 'string' ? worktreeResult : worktreeResult.stdout)
    }
  }))
}

function normalizeConflictText(value) {
  const text = String(value || '')
  return text.includes('\u0000') ? '[二进制文件，无法进行文本对比]' : text
}

function statusLabel(indexStatus, worktreeStatus) {
  if (indexStatus === '?' && worktreeStatus === '?') return '未跟踪'
  if (indexStatus === 'A') return '已新增'
  if (indexStatus === 'D' || worktreeStatus === 'D') return '已删除'
  if (indexStatus === 'R') return '已重命名'
  if (indexStatus === 'U' || worktreeStatus === 'U') return '冲突'
  if (indexStatus === 'M' && worktreeStatus === 'M') return '暂存后又修改'
  if (indexStatus === 'M') return '已暂存'
  return '已修改'
}

async function detectRisks(repositoryPath, changes) {
  const risks = []
  const sensitivePattern = /(^|\/)(\.env($|\.)|application-secrets\.ya?ml$|id_rsa$|credentials?($|\.)|.*\.(pem|p12|pfx|key)$)/i
  for (const change of changes.filter(item => item.staged)) {
    if (sensitivePattern.test(change.path)) risks.push({ level: 'high', path: change.path, message: '疑似包含凭据或私密配置' })
    const absolutePath = path.resolve(repositoryPath, change.path)
    const size = await fs.stat(absolutePath).then(stat => stat.size).catch(() => 0)
    if (size >= 95 * 1024 * 1024) risks.push({ level: 'block', path: change.path, message: '文件接近或超过 GitHub 100 MB 限制' })
    else if (size >= 50 * 1024 * 1024) risks.push({ level: 'high', path: change.path, message: '大文件可能不适合直接提交 Git' })
  }
  return risks
}

function enforceRiskAcknowledgement(snapshot, acknowledged) {
  if (snapshot.risks.some(item => item.level === 'block')) throw httpError(413, '暂存区包含接近或超过 100 MB 的文件，请先移除')
  if (snapshot.risks.length > 0 && !acknowledged) throw httpError(409, '暂存区包含敏感或大文件，请检查并确认风险')
}

async function actionResult(repositoryPath, result) {
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim() || '操作完成'
  return {
    output,
    notice: gitOutputNotice(output),
    snapshot: await repositorySnapshot(repositoryPath)
  }
}

async function currentBranch(repositoryPath) {
  const result = await runGit(['-C', repositoryPath, 'symbolic-ref', '--short', 'HEAD'], { allowFailure: true })
  const branch = result.stdout.trim()
  if (!branch || result.exitCode !== 0) {
    const error = httpError(409, '当前不在可推送的本地分支上')
    error.publicDetail = result.stderr.trim() || 'HEAD 未指向本地分支'
    error.publicGuidance = gitFailureGuidance(error.publicDetail)
    throw error
  }
  return branch
}

async function requireRepository(repositoryPath) {
  const result = await runGit(['-C', repositoryPath, 'rev-parse', '--is-inside-work-tree'], { allowFailure: true })
  if (result.exitCode !== 0 || result.stdout.trim() !== 'true') throw httpError(409, '该目录还不是 Git 仓库')
}

async function runGit(args, options = {}) {
  try {
    const result = await execFileAsync('git', args, {
      cwd: options.cwd || appDirectory,
      timeout: options.timeout || 30000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      windowsHide: true,
      // 禁止不可见的终端密码提示，但保留 Git Credential Manager 的浏览器授权能力。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
    })
    return { stdout: result.stdout || '', stderr: result.stderr || '', exitCode: 0 }
  } catch (error) {
    const result = { stdout: error.stdout || '', stderr: error.stderr || error.message || '', exitCode: Number(error.code) || 1 }
    if (options.allowFailure) return result
    const publicError = httpError(409, 'Git 操作未完成')
    publicError.publicDetail = [result.stdout, result.stderr].filter(Boolean).join('\n').slice(0, 12000)
    publicError.publicGuidance = gitFailureGuidance(publicError.publicDetail)
    throw publicError
  }
}

function resolveGitConfigPath(repositoryPath, configValue) {
  if (!configValue) return path.join(repositoryPath, '.git', 'config')
  return path.isAbsolute(configValue) ? path.normalize(configValue) : path.resolve(repositoryPath, configValue)
}

function gitOutputNotice(output) {
  if (!/(^|\n)(warning|hint):/im.test(output)) return null
  const guidance = gitFailureGuidance(output)
  return guidance || {
    level: 'warning',
    title: 'Git 返回了提示信息',
    summary: output.split(/\r?\n/).find(line => /^(warning|hint):/i.test(line.trim()))?.trim() || '操作已完成，但 Git 返回了需要留意的信息。',
    actions: ['展开操作输出查看完整提示，再确认是否需要调整仓库配置。']
  }
}

function gitFailureGuidance(detail) {
  const message = String(detail || '')
  const cases = [
    {
      pattern: /HEAD is not a symbolic ref|detached HEAD|not currently on a branch/i,
      title: '当前处于游离 HEAD 状态',
      summary: 'Git 无法确定要推送的本地分支。',
      actions: ['切换到已有分支，或基于当前提交创建一个新分支。', '刷新仓库，确认顶部显示了明确的分支名称后再推送。']
    },
    {
      pattern: /src refspec .* does not match|does not have any commits yet|No commits yet/i,
      title: '当前分支还没有提交',
      summary: '远端推送需要至少一个本地提交。',
      actions: ['暂存需要发布的文件并创建首次提交。', '确认提交记录出现后重新推送。']
    },
    {
      pattern: /non-fast-forward|fetch first|rejected.*behind/i,
      title: '远端包含本地没有的提交',
      summary: '为避免覆盖他人的更新，Git 拒绝了普通推送。',
      actions: ['先点击“获取”，再点击“拉取”合并远端更新。', '解决可能出现的冲突并重新提交，然后再次推送。', '只有明确要替换远端历史时才使用“安全覆盖远程分支”。']
    },
    {
      pattern: /Authentication failed|could not read Username|Permission denied \(publickey\)|HTTP 401|HTTP 403/i,
      title: '远程仓库身份验证失败',
      summary: '当前电脑没有可用凭据，或账号无仓库写入权限。',
      actions: ['HTTPS 地址请完成 Git Credential Manager 登录。', 'SSH 地址请检查 SSH 密钥是否已添加到远程账号。', '确认当前账号拥有该仓库的写入权限。']
    },
    {
      pattern: /Repository not found|repository .* not found/i,
      title: '找不到远程仓库',
      summary: '远程地址可能不正确，或者当前账号无权访问私有仓库。',
      actions: ['检查仓库设置中的 origin 地址。', '在浏览器中确认该仓库存在，并确认当前账号具有访问权限。']
    },
    {
      pattern: /Could not resolve host|Failed to connect|Connection timed out|Network is unreachable/i,
      title: '无法连接远程服务',
      summary: '网络、代理或 DNS 配置阻止了 Git 访问远端。',
      actions: ['确认网络可以访问远程仓库网站。', '检查 Git 代理、系统代理和防火墙设置后重试。']
    },
    {
      pattern: /protected branch|GH006|pre-receive hook declined/i,
      title: '远程分支受到保护',
      summary: '仓库规则不允许直接推送到当前分支。',
      actions: ['推送到新的功能分支。', '在远程平台创建 Pull Request，或联系仓库管理员调整规则。']
    },
    {
      pattern: /CONFLICT|fix conflicts|unmerged files/i,
      title: '存在尚未解决的合并冲突',
      summary: '冲突解决并提交前无法继续同步。',
      actions: ['在编辑器中处理冲突文件。', '暂存已解决的文件并创建提交，然后重新同步。']
    }
  ]
  const matched = cases.find(item => item.pattern.test(message))
  return matched ? { level: 'error', ...matched } : null
}

async function requireDirectoryPath(value, options = {}) {
  if (typeof value !== 'string' || !value.trim()) throw httpError(400, '请输入项目目录')
  const resolved = path.resolve(value.trim())
  const stat = await fs.stat(resolved).catch(() => null)
  if (!stat && options.create) await fs.mkdir(resolved, { recursive: true })
  else if (!stat && options.mustExist) throw httpError(404, '项目目录不存在')
  else if (stat && !stat.isDirectory()) throw httpError(400, '项目路径必须是目录')
  return resolved
}

function isDirectChild(parentPath, childPath) {
  const relative = path.relative(parentPath, childPath)
  return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative) && !relative.includes(path.sep)
}

function openDirectory(directoryPath) {
  const commands = {
    win32: ['explorer.exe', [directoryPath]],
    darwin: ['open', [directoryPath]],
    linux: ['xdg-open', [directoryPath]]
  }
  const [command, args] = commands[process.platform] || commands.linux
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function listDirectories(value) {
  const requestedPath = typeof value === 'string' && value.trim() ? value.trim() : os.homedir()
  const currentPath = await requireDirectoryPath(requestedPath, { mustExist: true })
  let entries
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true })
  } catch (error) {
    const publicError = httpError(error.code === 'EACCES' || error.code === 'EPERM' ? 403 : 409, '无法读取该目录')
    publicError.publicDetail = error.message
    throw publicError
  }

  const parentPath = path.dirname(currentPath)
  return {
    path: currentPath,
    parent: samePath(parentPath, currentPath) ? null : parentPath,
    home: os.homedir(),
    roots: await filesystemRoots(currentPath),
    entries: entries
      .filter(entry => entry.isDirectory())
      .sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: 'base' }))
      .slice(0, 2000)
      .map(entry => ({ name: entry.name, path: path.join(currentPath, entry.name) }))
  }
}

async function filesystemRoots(currentPath) {
  if (process.platform !== 'win32') {
    return uniquePaths(['/', os.homedir()]).map(root => ({ name: root === '/' ? '根目录' : '主目录', path: root }))
  }

  let roots = []
  try {
    const result = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-Command',
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; Get-PSDrive -PSProvider FileSystem | ForEach-Object { $_.Root }"
    ], { windowsHide: true, timeout: 5000 })
    roots = result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean)
  } catch {
    roots = []
  }
  roots.push(path.parse(currentPath).root, path.parse(os.homedir()).root)
  return uniquePaths(roots).map(root => ({ name: root.replace(/[\\/]$/, '') || root, path: root }))
}

function uniquePaths(values) {
  const unique = []
  for (const value of values) {
    if (value && !unique.some(existing => samePath(existing, value))) unique.push(value)
  }
  return unique
}

function validateRemoteUrl(value) {
  const remoteUrl = String(value || '').trim()
  if (!remoteUrl || remoteUrl.length > 1000 || /[\r\n]/.test(remoteUrl) || remoteUrl.startsWith('-')) throw httpError(400, '远程仓库地址无效')
  if (/^https:\/\//i.test(remoteUrl)) {
    const parsed = new URL(remoteUrl)
    if (parsed.username || parsed.password) throw httpError(400, '请勿在远程地址中嵌入账号或 Token')
    return remoteUrl
  }
  if (/^ssh:\/\//i.test(remoteUrl) || /^[\w.-]+@[\w.-]+:[\w./-]+$/.test(remoteUrl)) return remoteUrl
  throw httpError(400, '仅支持 HTTPS 或 SSH 远程仓库地址')
}

function validateText(value, label, maxLength) {
  const text = String(value || '').trim()
  if (!text || text.length > maxLength || /[\u0000]/.test(text)) throw httpError(400, `${label}长度应为 1-${maxLength} 个字符`)
  return text
}

function validateEmail(value) {
  const email = validateText(value, '邮箱', 190)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw httpError(400, '邮箱格式不正确')
  return email
}

function requirePageAuthorization(request) {
  if (request.headers['x-git-tool-token'] !== sessionToken) throw httpError(403, '页面会话已失效，请刷新页面')
  const origin = request.headers.origin
  if (origin && origin !== `http://127.0.0.1:${port}`) throw httpError(403, '拒绝跨站写请求')
}

async function readJson(request) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > 64 * 1024) throw httpError(413, '请求内容过大')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  } catch {
    throw httpError(400, '请求格式无效')
  }
}

async function serveStatic(response, root, relativePath) {
  const resolved = path.resolve(root, relativePath)
  if (!samePath(root, resolved) && !resolved.toLowerCase().startsWith(`${root.toLowerCase()}${path.sep}`)) return sendJson(response, 403, { message: '禁止访问' })
  const content = await fs.readFile(resolved)
  send(response, 200, content, mimeTypes.get(path.extname(resolved)) || 'application/octet-stream')
}

function samePath(left, right) {
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

function sendJson(response, statusCode, value) {
  send(response, statusCode, JSON.stringify(value), 'application/json; charset=utf-8')
}

function send(response, statusCode, body, contentType) {
  response.writeHead(statusCode, { 'Content-Type': contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'" })
  response.end(body)
}

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode })
}
