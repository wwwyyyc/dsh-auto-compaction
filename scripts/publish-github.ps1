# 一键把本插件发布到 GitHub（两种路径，优先 git）。
#
# 用法：
#   pwsh -NoProfile -File scripts/publish-github.ps1 -DryRun      # 只做前置检查与打印计划
#   pwsh -NoProfile -File scripts/publish-github.ps1             # 真发布（需要 git 或 GH_TOKEN）
#
# 凭据（二选一）：
#   1) 本机装好 Git for Windows —— 不需要把任何 token 交给别人；
#   2) 设一个细粒度 PAT：setx GH_TOKEN "<你的PAT>"（只勾这一个仓库、Contents: Read and write、
#      尽量短的有效期），发布完立刻吊销。脚本只从环境变量读，不接受命令行明文 token。
#
# git 路径保留完整历史；REST 路径（机器上没有 git 时）用 Git Data API 生成一次提交。

param(
  [string]$Owner = 'wwwyyyc',
  [string]$Repo = 'dsh-auto-compaction',
  [string]$Branch = 'main',
  [string]$Tag = 'v0.8.0',
  [string]$Email = 'wwwyyyc@users.noreply.github.com',
  [string]$Message = 'feat: dsh-auto-compaction 0.8.0',
  [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Fail($msg) { Write-Host ('FAIL: ' + $msg) -ForegroundColor Red; exit 1 }
function Info($msg) { Write-Host ('- ' + $msg) }

# ---------- 前置检查（不碰网络） ----------
$pkgPath = Join-Path $root 'package.json'
if (-not (Test-Path $pkgPath)) { Fail 'package.json 不存在' }
$pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
if (-not $pkg.dsh.bundle.patch) { Fail 'package.json 缺少 dsh.bundle.patch' }
if (Test-Path (Join-Path $root 'node_modules')) { Fail '工作树里有 node_modules，先清掉' }

$files = @(Get-ChildItem -Path $root -Recurse -File -Force | Where-Object {
  $_.FullName -notmatch 'node_modules' -and $_.FullName -notmatch '\.git\\' -and $_.FullName -notmatch '\.tscheck'
} | ForEach-Object { $_.FullName.Substring($root.Length + 1).Replace('\', '/') })
Info ('包：' + $pkg.name + '@' + $pkg.version + '；待发布 ' + $files.Count + ' 个文件')

$git = Get-Command git -ErrorAction SilentlyContinue
$token = $env:GH_TOKEN
if ($git) { Info ('git: ' + $git.Source) } else { Info 'git: 未安装' }
if ($token) { Info ('GH_TOKEN: 已设置（末 4 位 ' + $token.Substring([Math]::Max(0, $token.Length - 4)) + '）') } else { Info 'GH_TOKEN: 未设置' }
Info ('目标：https://github.com/' + $Owner + '/' + $Repo + ' （分支 ' + $Branch + '，tag ' + $Tag + '）')

if ($DryRun) {
  if (-not $git -and -not $token) { Write-Host '警告：两条路径都不可用 —— 装 Git for Windows，或设置 GH_TOKEN' -ForegroundColor Yellow }
  Write-Host '—— DryRun：未做任何网络或写操作 ——' -ForegroundColor Cyan
  $files | ForEach-Object { Write-Host ('   ' + $_) }
  exit 0
}

if (-not $git -and -not $token) { Fail '需要 git，或设置 GH_TOKEN（细粒度 PAT，仅 Contents: Read and write）' }

# ---------- 路径 A：git ----------
if ($git) {
  if (-not (Test-Path (Join-Path $root '.git'))) { & git init -b $Branch | Out-Null; Info 'git init' }
  & git add -A
  & git -c user.name=$Owner -c user.email=$Email commit -m $Message | Out-Null
  & git tag $Tag 2>$null | Out-Null
  $remote = 'https://github.com/' + $Owner + '/' + $Repo + '.git'
  if ($token) { $pushUrl = 'https://x-access-token:' + $token + '@github.com/' + $Owner + '/' + $Repo + '.git' } else { $pushUrl = $remote }
  $refspec = 'refs/heads/' + $Branch + ':refs/heads/' + $Branch
  & git remote remove origin 2>$null | Out-Null
  & git remote add origin $remote
  & git push $pushUrl $refspec --tags
  if ($LASTEXITCODE -ne 0) { Fail 'git push 失败（检查仓库是否存在、token 权限）' }
  Write-Host ('OK 已推送：https://github.com/' + $Owner + '/' + $Repo + ' （tag ' + $Tag + '）') -ForegroundColor Green
  exit 0
}

# ---------- 路径 B：REST API（机器上没有 git 时） ----------
$api = 'https://api.github.com/repos/' + $Owner + '/' + $Repo
$headers = @{ Authorization = ('Bearer ' + $token); Accept = 'application/vnd.github+json'; 'User-Agent' = 'dsh-auto-compaction-publish' }

function Api($method, $url, $body) {
  if ($null -eq $body) { return Invoke-RestMethod -Method $method -Uri $url -Headers $headers }
  return Invoke-RestMethod -Method $method -Uri $url -Headers $headers -Body ($body | ConvertTo-Json -Depth 10 -Compress) -ContentType 'application/json'
}

try { $repoInfo = Api 'GET' $api $null } catch { Fail ('仓库不可访问（先建空仓库，或 token 权限不足）：' + $_.Exception.Message) }
Info ('仓库已存在，默认分支：' + $repoInfo.default_branch)

$treeItems = @()
foreach ($rel in $files) {
  $abs = Join-Path $root ($rel -replace '/', '\\')
  $bytes = [System.IO.File]::ReadAllBytes($abs)
  $blob = Api 'POST' ($api + '/git/blobs') @{ content = [Convert]::ToBase64String($bytes); encoding = 'base64' }
  $treeItems += @{ path = $rel; mode = '100644'; type = 'blob'; sha = $blob.sha }
}
Info ('已上传 ' + $treeItems.Count + ' 个 blob')

$parent = $null
try { $ref = Api 'GET' ($api + '/git/ref/heads/' + $Branch) $null; $parent = $ref.object.sha } catch { Info ('分支 ' + $Branch + ' 尚不存在，将创建首个提交') }
$treeBody = @{ tree = $treeItems }
if ($parent) { $treeBody.base_tree = (Api 'GET' ($api + '/git/commits/' + $parent) $null).tree.sha }
$tree = Api 'POST' ($api + '/git/trees') $treeBody
$commitBody = @{ message = $Message; tree = $tree.sha; author = @{ name = $Owner; email = $Email } }
if ($parent) { $commitBody.parents = @($parent) }
$commit = Api 'POST' ($api + '/git/commits') $commitBody
if ($parent) { Api 'PATCH' ($api + '/git/refs/heads/' + $Branch) @{ sha = $commit.sha; force = $false } | Out-Null }
else { Api 'POST' ($api + '/git/refs') @{ ref = ('refs/heads/' + $Branch); sha = $commit.sha } | Out-Null }
Info ('提交：' + $commit.sha.Substring(0, 8))
try { Api 'POST' ($api + '/git/refs') @{ ref = ('refs/tags/' + $Tag); sha = $commit.sha } | Out-Null; Info ('tag ' + $Tag + ' 已创建') } catch { Info 'tag 已存在或创建失败（可忽略）' }
Write-Host ('OK 已发布：https://github.com/' + $Owner + '/' + $Repo) -ForegroundColor Green
