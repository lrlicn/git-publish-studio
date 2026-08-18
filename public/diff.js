import { createIcons, icons } from '/vendor/lucide.js'

const token = document.querySelector('meta[name="git-tool-token"]').content
const elements = Object.fromEntries([...document.querySelectorAll('[id]')].map(element => [element.id, element]))
const repositoryPath = new URLSearchParams(location.search).get('path') || ''
let files = []

createIcons({ icons })
elements['repository-path'].textContent = repositoryPath || '未指定仓库'
elements['close-button'].addEventListener('click', () => window.close())
elements['fullscreen-button'].addEventListener('click', toggleFullscreen)
document.addEventListener('fullscreenchange', renderFullscreenButton)
await loadDiff()

async function loadDiff() {
  if (!repositoryPath) return showFailure('缺少仓库路径')
  try {
    const response = await fetch(`/api/diff?path=${encodeURIComponent(repositoryPath)}`, { headers: { 'X-Git-Tool-Token': token } })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(payload.message || '无法读取 Diff')
    files = [...parseUnifiedDiff(payload.diff || ''), ...(payload.conflicts || []).map(createConflictFile)]
    renderDiff()
  } catch (error) {
    showFailure(error.message)
  }
}

function parseUnifiedDiff(source) {
  const parsedFiles = []
  let file = null
  let oldLine = 0
  let newLine = 0
  let removed = []
  let added = []

  const flushChanges = () => {
    if (!file || (!removed.length && !added.length)) return
    const rowCount = Math.max(removed.length, added.length)
    for (let index = 0; index < rowCount; index += 1) {
      file.rows.push({ type: 'change', left: removed[index] || null, right: added[index] || null })
    }
    removed = []
    added = []
  }

  for (const line of source.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flushChanges()
      const match = line.match(/^diff --git a\/(.+) b\/(.+)$/)
      file = { name: match?.[2] || line.slice(11), additions: 0, deletions: 0, rows: [] }
      parsedFiles.push(file)
      continue
    }
    if (!file || line.startsWith('index ') || line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('new file ') || line.startsWith('deleted file ') || line.startsWith('similarity index ') || line.startsWith('rename from ') || line.startsWith('rename to ')) continue
    if (line.startsWith('@@')) {
      flushChanges()
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
      oldLine = Number(match?.[1] || 0)
      newLine = Number(match?.[2] || 0)
      file.rows.push({ type: 'hunk', text: line })
      continue
    }
    if (line.startsWith('-')) {
      removed.push({ number: oldLine, text: line.slice(1) })
      oldLine += 1
      file.deletions += 1
      continue
    }
    if (line.startsWith('+')) {
      added.push({ number: newLine, text: line.slice(1) })
      newLine += 1
      file.additions += 1
      continue
    }
    if (line.startsWith(' ')) {
      flushChanges()
      const content = line.slice(1)
      file.rows.push({ type: 'context', left: { number: oldLine, text: content }, right: { number: newLine, text: content } })
      oldLine += 1
      newLine += 1
    }
  }
  flushChanges()
  return parsedFiles
}

function createConflictFile(conflict) {
  return { name: conflict.path, additions: 0, deletions: 0, rows: [], conflict: true, conflictData: conflict }
}

function renderDiff() {
  elements.loading.classList.add('hidden')
  if (!files.length) {
    elements.empty.classList.remove('hidden')
    createIcons({ icons })
    return
  }
  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const conflictCount = files.filter(file => file.conflict).length
  elements['file-count'].textContent = files.length
  elements['diff-summary'].innerHTML = `<span class="addition">+${totalAdditions}</span><span class="deletion">-${totalDeletions}</span>${conflictCount ? `<span class="conflict-summary">! ${conflictCount} 个冲突</span>` : ''}`
  elements['file-list'].replaceChildren(...files.map((file, index) => createFileButton(file, index)))
  elements['diff-content'].replaceChildren(...files.map((file, index) => createFileSection(file, index)))
  elements['diff-content'].classList.remove('hidden')
}

function createFileButton(file, index) {
  const button = document.createElement('button')
  button.type = 'button'
  button.innerHTML = `<span class="file-index">${String(index + 1).padStart(2, '0')}</span><span class="file-name"></span><span class="file-delta">${file.conflict ? '<b class="conflict-mark">冲突</b>' : `<b>+${file.additions}</b><i>-${file.deletions}</i>`}</span>`
  if (file.conflict) button.classList.add('conflict-file')
  button.querySelector('.file-name').textContent = file.name
  button.title = file.name
  button.addEventListener('click', () => document.getElementById(`file-${index}`).scrollIntoView({ behavior: 'smooth', block: 'start' }))
  return button
}

function createFileSection(file, index) {
  if (file.conflict) return createConflictSection(file, index)
  const section = document.createElement('article')
  section.className = 'file-diff'
  section.id = `file-${index}`
  const header = document.createElement('header')
  const fileName = document.createElement('strong')
  fileName.textContent = file.name
  const stats = document.createElement('span')
  stats.innerHTML = `<b>+${file.additions}</b><i>-${file.deletions}</i>`
  header.append(fileName, stats)
  const columns = document.createElement('div')
  columns.className = 'column-head'
  columns.innerHTML = '<span>修改前</span><span>修改后</span>'
  const table = document.createElement('div')
  table.className = 'diff-table'
  table.append(...file.rows.map(createDiffRow))
  section.append(header, columns, table)
  return section
}

function createConflictSection(file, index) {
  const section = document.createElement('article')
  section.className = 'file-diff conflict-diff'
  section.id = `file-${index}`
  const header = document.createElement('header')
  const fileName = document.createElement('strong')
  fileName.textContent = file.name
  const label = document.createElement('span')
  label.className = 'conflict-label'
  label.textContent = '存在冲突'
  header.append(fileName, label)
  const columns = document.createElement('div')
  columns.className = 'column-head'
  columns.innerHTML = '<span>当前版本（HEAD）</span><span>传入版本</span>'
  const left = splitConflictLines(file.conflictData.ours)
  const right = splitConflictLines(file.conflictData.theirs)
  const table = document.createElement('div')
  table.className = 'diff-table'
  const rowCount = Math.max(left.length, right.length)
  for (let index = 0; index < rowCount; index += 1) {
    const row = document.createElement('div')
    row.className = 'diff-row change'
    row.append(createCodeCell(left[index] || null, 'delete'), createCodeCell(right[index] || null, 'add'))
    table.append(row)
  }
  const note = document.createElement('div')
  note.className = 'conflict-note'
  note.textContent = '解决后请删除冲突标记，保存文件，再回到工作台暂存并继续变基。'
  section.append(header, columns, note, table)
  return section
}

function splitConflictLines(value) {
  const text = String(value || '')
  return text ? text.split(/\r?\n/).map((line, index) => ({ number: index + 1, text: line })) : []
}

function createDiffRow(row) {
  if (row.type === 'hunk') {
    const hunk = document.createElement('div')
    hunk.className = 'hunk-row'
    hunk.textContent = row.text
    return hunk
  }
  const element = document.createElement('div')
  element.className = `diff-row ${row.type}`
  element.append(createCodeCell(row.left, row.type === 'change' ? 'delete' : 'context'), createCodeCell(row.right, row.type === 'change' ? 'add' : 'context'))
  return element
}

function createCodeCell(line, type) {
  const cell = document.createElement('div')
  cell.className = `code-cell ${line ? type : 'blank'}`
  const number = document.createElement('span')
  number.className = 'line-number'
  number.textContent = line?.number || ''
  const code = document.createElement('code')
  code.textContent = line?.text || ''
  cell.append(number, code)
  return cell
}

async function toggleFullscreen() {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
    else await document.documentElement.requestFullscreen()
  } catch {
    toast('浏览器未允许全屏，可使用窗口最大化按钮')
  }
}

function renderFullscreenButton() {
  const icon = document.fullscreenElement ? 'minimize-2' : 'maximize-2'
  elements['fullscreen-button'].innerHTML = `<i data-lucide="${icon}"></i><span>${document.fullscreenElement ? '退出全屏' : '全屏'}</span>`
  createIcons({ icons })
}

function showFailure(message) {
  elements.loading.classList.add('hidden')
  elements.empty.classList.remove('hidden')
  elements.empty.querySelector('strong').textContent = message
  createIcons({ icons })
}

function toast(message) {
  elements.toast.textContent = message
  elements.toast.classList.add('visible')
  setTimeout(() => elements.toast.classList.remove('visible'), 2600)
}
