const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');

// ── API server (port 4000) ──
const apiApp = express();
const API_PORT = 4000;

apiApp.use(cors());
apiApp.use(express.json({ limit: '200mb' }));

// Long timeout for large uploads
apiApp.use((req, res, next) => {
    req.setTimeout(30 * 60 * 1000); // 30 min
    res.setTimeout(30 * 60 * 1000);
    next();
});

// ── Static server (port 8443) ──
const staticApp = express();
const STATIC_PORT = 8443;

staticApp.use(cors());
staticApp.use(express.static(__dirname));

// ── In-memory fallback store (when MySQL is unavailable) ──
const memoryStore = new Map();

// ── MySQL connection pool ──
let pool = null;

async function initMySQL() {
    try {
        pool = mysql.createPool({
            host: 'localhost',
            user: 'root',
            password: '123456',
            database: 'github_uploader',
            waitForConnections: true,
            connectionLimit: 5
        });
        const conn = await pool.getConnection();
        await conn.query(`CREATE TABLE IF NOT EXISTS user_config (
            id INT PRIMARY KEY AUTO_INCREMENT,
            config_key VARCHAR(100) UNIQUE NOT NULL,
            config_value TEXT NOT NULL,
            updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )`);
        conn.release();
        console.log('[MySQL] Connected successfully');
        return true;
    } catch (err) {
        console.warn('[MySQL] Connection failed, using in-memory storage:', err.message);
        console.warn('[MySQL] To use MySQL, create database "github_uploader" and update credentials in server.js');
        pool = null;
        return false;
    }
}

// ── Config storage (DB or memory) ──
async function getConfig(key) {
    if (pool) {
        try {
            const [rows] = await pool.query('SELECT config_value FROM user_config WHERE config_key = ?', [key]);
            return rows.length > 0 ? rows[0].config_value : null;
        } catch (err) {
            return memoryStore.get(key) || null;
        }
    }
    return memoryStore.get(key) || null;
}

async function setConfig(key, value) {
    if (pool) {
        try {
            await pool.query(
                'INSERT INTO user_config (config_key, config_value) VALUES (?, ?) ON DUPLICATE KEY UPDATE config_value = ?',
                [key, value, value]
            );
            return;
        } catch (err) { /* fall through */ }
    }
    memoryStore.set(key, value);
}

async function deleteConfig(key) {
    if (pool) {
        try {
            await pool.query('DELETE FROM user_config WHERE config_key = ?', [key]);
            return;
        } catch (err) { /* fall through */ }
    }
    memoryStore.delete(key);
}

// ── GitHub API helper ──
async function githubFetch(token, method, url, body = null, timeoutMs = 60000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const headers = {
            'Authorization': `token ${token}`,
            'Accept': 'application/vnd.github.v3+json',
            'User-Agent': 'GitHub-Uploader'
        };
        if (body && body !== 'stream') {
            headers['Content-Type'] = 'application/json';
        }

        const opts = { method, headers, signal: controller.signal };
        if (body && body !== 'stream') {
            opts.body = JSON.stringify(body);
        }

        const res = await fetch(`https://api.github.com${url}`, opts);

        if (res.status === 204) return null;

        const text = await res.text();
        let data;
        try { data = JSON.parse(text); } catch (e) {
            throw new Error(`GitHub API HTTP ${res.status}: ${text.slice(0, 300)}`);
        }

        if (!res.ok) {
            const err = new Error(data.message || `GitHub API error: ${res.status}`);
            err.status = res.status;
            err.githubData = data;
            throw err;
        }
        return data;
    } finally {
        clearTimeout(timer);
    }
}

// ── Get token middleware ──
async function requireToken(req, res, next) {
    const token = await getConfig('github_token');
    if (!token) {
        return res.status(401).json({ error: '未找到 GitHub Token，请先登录' });
    }
    req.githubToken = token;
    req.githubUsername = await getConfig('github_username');
    next();
}

// ── Auth routes ──
apiApp.post('/api/auth', async (req, res) => {
    try {
        const { token } = req.body;
        if (!token) return res.status(400).json({ error: 'Token 不能为空' });

        const userData = await githubFetch(token, 'GET', '/user');
        const username = userData.login;

        await setConfig('github_token', token);
        await setConfig('github_username', username);

        res.json({ success: true, username, avatar: userData.avatar_url });
    } catch (err) {
        if (err.status === 401) {
            res.status(401).json({ error: 'Token 无效，请检查后重试' });
        } else {
            res.status(500).json({ error: '验证失败: ' + err.message });
        }
    }
});

apiApp.get('/api/auth', async (req, res) => {
    const token = await getConfig('github_token');
    const username = await getConfig('github_username');
    if (token && username) {
        res.json({ authenticated: true, username });
    } else {
        res.json({ authenticated: false });
    }
});

apiApp.delete('/api/auth', async (req, res) => {
    await deleteConfig('github_token');
    await deleteConfig('github_username');
    res.json({ success: true });
});

// ── Repo routes ──
apiApp.get('/api/repos', requireToken, async (req, res) => {
    try {
        const page = req.query.page || 1;
        const perPage = req.query.per_page || 100;
        const repos = await githubFetch(
            req.githubToken, 'GET',
            `/user/repos?per_page=${perPage}&page=${page}&sort=updated&type=owner`
        );
        const mapped = repos.map(r => ({
            id: r.id,
            name: r.name,
            full_name: r.full_name,
            description: r.description,
            private: r.private,
            language: r.language,
            stargazers_count: r.stargazers_count,
            updated_at: r.updated_at,
            default_branch: r.default_branch,
            clone_url: r.clone_url,
            html_url: r.html_url
        }));
        res.json(mapped);
    } catch (err) {
        res.status(500).json({ error: '获取仓库列表失败: ' + err.message });
    }
});

apiApp.post('/api/repos', requireToken, async (req, res) => {
    try {
        const { name, description, isPrivate } = req.body;
        if (!name) return res.status(400).json({ error: '仓库名不能为空' });
        const repo = await githubFetch(req.githubToken, 'POST', '/user/repos', {
            name, description, private: !!isPrivate, auto_init: false
        });
        res.json({ success: true, repo });
    } catch (err) {
        res.status(500).json({ error: '创建仓库失败: ' + err.message });
    }
});

apiApp.delete('/api/repos/:owner/:repo', requireToken, async (req, res) => {
    try {
        const { owner, repo } = req.params;
        await githubFetch(req.githubToken, 'DELETE', `/repos/${owner}/${repo}`);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: '删除仓库失败: ' + err.message });
    }
});

apiApp.patch('/api/repos/:owner/:repo', requireToken, async (req, res) => {
    try {
        const { owner, repo } = req.params;
        const { name } = req.body;
        if (!name) return res.status(400).json({ error: '新名称不能为空' });
        const result = await githubFetch(req.githubToken, 'PATCH', `/repos/${owner}/${repo}`, { name });
        res.json({ success: true, repo: result });
    } catch (err) {
        res.status(500).json({ error: '重命名失败: ' + err.message });
    }
});

// ── Branch routes ──
apiApp.get('/api/repos/:owner/:repo/branches', requireToken, async (req, res) => {
    try {
        const { owner, repo } = req.params;
        const branches = await githubFetch(req.githubToken, 'GET', `/repos/${owner}/${repo}/branches?per_page=100`);
        res.json(branches.map(b => ({ name: b.name, sha: b.commit.sha })));
    } catch (err) {
        res.status(500).json({ error: '获取分支列表失败: ' + err.message });
    }
});

// ── Repo tree ──
apiApp.get('/api/repos/:owner/:repo/tree', requireToken, async (req, res) => {
    try {
        const { owner, repo } = req.params;
        const branch = req.query.branch || 'main';
        const repoInfo = await githubFetch(req.githubToken, 'GET', `/repos/${owner}/${repo}`);
        const targetBranch = branch || repoInfo.default_branch;

        let treeEntries = [];
        try {
            const ref = await githubFetch(req.githubToken, 'GET', `/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
            const commit = await githubFetch(req.githubToken, 'GET', `/repos/${owner}/${repo}/git/commits/${ref.object.sha}`);
            if (commit.commit.tree.sha) {
                const tree = await githubFetch(req.githubToken, 'GET',
                    `/repos/${owner}/${repo}/git/trees/${commit.commit.tree.sha}?recursive=1`);
                treeEntries = (tree.tree || [])
                    .filter(t => t.type === 'blob')
                    .map(t => ({ path: t.path, size: t.size, sha: t.sha }));
            }
        } catch (e) {
            treeEntries = [];
        }

        res.json({ branch: targetBranch, files: treeEntries, isEmpty: treeEntries.length === 0 });
    } catch (err) {
        res.status(500).json({ error: '获取仓库文件失败: ' + err.message });
    }
});

// ── Upload sessions (in-memory) ──
const uploadSessions = new Map();
const SESSION_TTL = 30 * 60 * 1000; // 30 min

function cleanSession(sid) {
    const s = uploadSessions.get(sid);
    if (s && s.timer) clearTimeout(s.timer);
    uploadSessions.delete(sid);
}

// Start upload session — get repo state
apiApp.post('/api/upload/begin/:owner/:repo', requireToken, async (req, res) => {
    try {
        const { owner, repo } = req.params;
        const { branch, mode, commitMessage, fileCount } = req.body;
        const targetBranch = branch || 'main';

        console.log(`[Upload] Begin session: ${owner}/${repo}:${targetBranch} mode=${mode} files=${fileCount}`);

        let parentSha = null, existingTreeSha = null, existingFiles = [];

        try {
            const ref = await githubFetch(req.githubToken, 'GET',
                `/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
            parentSha = ref.object.sha;
            const commit = await githubFetch(req.githubToken, 'GET',
                `/repos/${owner}/${repo}/git/commits/${parentSha}`);
            existingTreeSha = commit.commit.tree.sha;
            if (existingTreeSha) {
                const tree = await githubFetch(req.githubToken, 'GET',
                    `/repos/${owner}/${repo}/git/trees/${existingTreeSha}?recursive=1`);
                existingFiles = (tree.tree || []).filter(t => t.type === 'blob').map(t => ({
                    path: t.path, sha: t.sha, size: t.size
                }));
            }
        } catch (e) {
            parentSha = null;
            existingTreeSha = null;
            existingFiles = [];
        }

        const sid = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const existsMap = new Map(existingFiles.map(f => [f.path, f]));

        uploadSessions.set(sid, {
            owner, repo, targetBranch, mode, commitMessage, parentSha, existingTreeSha,
            existingFiles, existsMap, newEntries: [], totalFiles: fileCount || 0,
            timer: setTimeout(() => cleanSession(sid), SESSION_TTL)
        });

        res.json({
            sessionId: sid,
            branch: targetBranch,
            parentSha,
            existingCount: existingFiles.length
        });

    } catch (err) {
        res.status(500).json({ error: '创建上传会话失败: ' + err.message });
    }
});

// Upload batch of files → create blobs
apiApp.post('/api/upload/batch/:sessionId', requireToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const { files } = req.body;

        const session = uploadSessions.get(sessionId);
        if (!session) return res.status(404).json({ error: '会话已过期或不存在，请重新开始上传' });

        const { owner, repo, mode, existsMap } = session;
        const MAX_SIZE = 100 * 1024 * 1024;

        const entries = [];
        const blobTasks = files
            .filter(f => f.content && f.size <= MAX_SIZE)
            .filter(f => mode !== 'incremental' || !existsMap.has(f.path))
            .map(async (file) => {
                const blob = await githubFetch(req.githubToken, 'POST',
                    `/repos/${owner}/${repo}/git/blobs`, {
                        content: file.content, encoding: 'base64'
                    });
                return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
            });

        const results = await Promise.all(blobTasks.map(p => p.catch(e => ({ error: true, message: e.message }))));
        for (const r of results) {
            if (r.error) return res.status(500).json({ error: `创建 blob 失败: ${r.message}` });
            entries.push(r);
        }

        session.newEntries.push(...entries);
        clearTimeout(session.timer);
        session.timer = setTimeout(() => cleanSession(sessionId), SESSION_TTL);

        res.json({ ok: true, batchEntries: entries.length, totalEntries: session.newEntries.length });

    } catch (err) {
        res.status(500).json({ error: '批次上传失败: ' + err.message });
    }
});

// Finalize: create tree + commit
apiApp.post('/api/upload/commit/:sessionId', requireToken, async (req, res) => {
    try {
        const { sessionId } = req.params;
        const session = uploadSessions.get(sessionId);
        if (!session) return res.status(404).json({ error: '会话已过期或不存在' });

        const { owner, repo, targetBranch, mode, commitMessage, parentSha, existingTreeSha, existingFiles, newEntries } = session;
        const message = commitMessage || 'Upload via GitHub Uploader';

        console.log(`[Upload] Finalizing: ${owner}/${repo}:${targetBranch} new=${newEntries.length} existing=${existingFiles.length}`);

        // Build tree
        let treeEntries = [];
        if (mode !== 'full') {
            const newPaths = new Set(newEntries.map(e => e.path));
            for (const ef of existingFiles) {
                if (!newPaths.has(ef.path)) {
                    treeEntries.push({ path: ef.path, mode: '100644', type: 'blob', sha: ef.sha });
                }
            }
        }
        const allEntries = [...treeEntries, ...newEntries];

        if (allEntries.length === 0) {
            cleanSession(sessionId);
            return res.status(400).json({ error: '没有有效的文件可以上传' });
        }

        // Build tree in chunks to avoid GitHub 504 timeout
        const TREE_CHUNK = 100;
        let currentTreeSha = (mode !== 'full') ? existingTreeSha : null;

        console.log(`[Upload] Tree: total=${allEntries.length} chunks=${Math.ceil(allEntries.length / TREE_CHUNK)} initial_base=${currentTreeSha || 'none'}`);

        for (let i = 0; i < allEntries.length; i += TREE_CHUNK) {
            const chunk = allEntries.slice(i, i + TREE_CHUNK);
            const chunkNum = Math.floor(i / TREE_CHUNK) + 1;
            const totalChunks = Math.ceil(allEntries.length / TREE_CHUNK);

            const treePayload = { tree: chunk };
            if (currentTreeSha) treePayload.base_tree = currentTreeSha;

            console.log(`[Upload] Tree chunk ${chunkNum}/${totalChunks}: entries=${chunk.length} base_tree=${currentTreeSha ? currentTreeSha.slice(0,7) : 'none'}`);

            try {
                const tree = await githubFetch(req.githubToken, 'POST',
                    `/repos/${owner}/${repo}/git/trees`, treePayload);
                currentTreeSha = tree.sha;
            } catch (e) {
                console.error(`[Upload] Tree chunk ${chunkNum} failed: HTTP ${e.status} — ${e.message}`);
                throw new Error(`创建 tree 失败 [HTTP ${e.status}]: ${e.message}`);
            }
        }

        console.log(`[Upload] Tree complete: ${currentTreeSha}`);

        // Re-check current ref SHA now (branch may have moved since session start)
        let currentBranchSha = parentSha;
        let refExists = false;
        try {
            const ref = await githubFetch(req.githubToken, 'GET',
                `/repos/${owner}/${repo}/git/ref/heads/${targetBranch}`);
            refExists = true;
            currentBranchSha = ref.object.sha;
            if (currentBranchSha !== parentSha) {
                console.log(`[Upload] Branch moved since session start, using updated parent: ${parentSha?.slice(0,7)} -> ${currentBranchSha.slice(0,7)}`);
            }
        } catch (e) {
            // Ref doesn't exist yet
        }

        const commitPayload = { message, tree: currentTreeSha };
        if (currentBranchSha) commitPayload.parents = [currentBranchSha];

        let newCommit;
        try {
            newCommit = await githubFetch(req.githubToken, 'POST',
                `/repos/${owner}/${repo}/git/commits`, commitPayload);
            console.log(`[Upload] Commit created: ${newCommit.sha}`);
        } catch (e) {
            console.error(`[Upload] Commit creation failed: HTTP ${e.status || '?'} — ${e.message}`);
            throw new Error(`创建 commit 失败: ${e.message}`);
        }

        if (refExists) {
            await githubFetch(req.githubToken, 'PATCH',
                `/repos/${owner}/${repo}/git/refs/heads/${targetBranch}`, {
                    sha: newCommit.sha, force: false
                });
            console.log(`[Upload] Ref updated: ${targetBranch}`);
        } else {
            await githubFetch(req.githubToken, 'POST',
                `/repos/${owner}/${repo}/git/refs`, {
                    ref: `refs/heads/${targetBranch}`,
                    sha: newCommit.sha
                });
            console.log(`[Upload] Ref created: ${targetBranch}`);
        }

        cleanSession(sessionId);

        res.json({
            success: true,
            message: `成功上传 ${newEntries.length} 个文件到 ${owner}/${repo}:${targetBranch}`,
            uploaded: newEntries.length,
            commit: { sha: newCommit.sha, url: newCommit.html_url },
            branch: targetBranch
        });

    } catch (err) {
        console.error('[Upload] Finalize error:', err.message);
        if (err.githubData) console.error('[Upload] GitHub:', JSON.stringify(err.githubData).slice(0, 300));
        res.status(500).json({ error: '提交失败: ' + err.message });
    }
});

// ── Global error handler (must be after all routes) ──
apiApp.use((err, req, res, next) => {
    console.error('[API] Unhandled error:', err.message);
    if (err.type === 'entity.too.large') {
        return res.status(413).json({ error: '请求数据过大，请减少上传文件数量或大小' });
    }
    res.status(500).json({ error: '服务器内部错误: ' + err.message });
});

// ── Start servers ──
async function start() {
    await initMySQL();
    const apiServer = apiApp.listen(API_PORT, () => {
        console.log(`[API]  http://localhost:${API_PORT}`);
    });
    apiServer.timeout = 30 * 60 * 1000; // 30 min
    const staticServer = staticApp.listen(STATIC_PORT, () => {
        console.log(`[Web]  http://localhost:${STATIC_PORT}`);
    });
    staticServer.timeout = 0; // no timeout for static files
}

start();
