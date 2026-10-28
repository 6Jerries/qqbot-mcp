#!/usr/bin/env node
/**
 * qqbot-mcp — QQ 机器人 MCP 服务器
 *
 * 让 AI（Windsurf / Devin 等）通过 QQ 机器人与用户通信：
 *   - qq_send_message    发送文本 / 图片（本地文件路径）
 *   - qq_notify_and_wait 发送任务完成通知，并阻塞等待用户从 QQ 发来的下一条指令
 *   - qq_get_messages    读取等候期间堆积的 QQ 消息
 *   - qq_get_status      查看连接状态
 *
 * 配置（环境变量）：
 *   QQBOT_APP_ID        QQ Bot AppID（必填）
 *   QQBOT_APP_SECRET    QQ Bot AppSecret（必填）
 *   QQBOT_SANDBOX       "1"=沙箱 "0"=正式（默认 1）
 *   QQBOT_DEFAULT_USER  兜底 C2C 目标 user_openid（可选）
 *   QQBOT_DEFAULT_GROUP 兜底群 group_openid（可选）
 *
 * 注意：stdout 仅用于 JSON-RPC，日志一律走 stderr。
 */

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { z } = require('zod');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');

const TARGET_FILE = path.join(os.homedir(), '.qqbot-mcp-target.json');

const TAG = '[qqbot-mcp]';
const log = (...a) => console.error(TAG, ...a);

const CFG = {
    appId: process.env.QQBOT_APP_ID || '',
    appSecret: process.env.QQBOT_APP_SECRET || '',
    sandbox: (process.env.QQBOT_SANDBOX || '1') !== '0',
    defaultUser: process.env.QQBOT_DEFAULT_USER || '',
    defaultGroup: process.env.QQBOT_DEFAULT_GROUP || '',
};
const API_BASE = CFG.sandbox ? 'https://sandbox.api.sgroup.qq.com' : 'https://api.sgroup.qq.com';
const MSG_LIMIT = 500;          // QQ 单条消息安全上限
const PASSIVE_TTL = 4 * 60e3;   // 被动回复(msg_id)有效期 4 分钟（官方5分钟留余量）

// ================= QQ 底层 =================

const qq = {
    token: null, tokenExp: 0, seq: null, sessionId: null, ready: false,
    // msg_id+msg_seq 必须全局唯一（多个进程/重启会共用同一 msg_id），随机起点避免被去重
    ws: null, heartbeat: null, pushSeq: Math.floor(Math.random() * 1e6) + 1,
    lastTarget: null,   // { userId, groupId, isGroup, msgId, msgTime }
    inbox: [],          // 无 waiter 时堆积的入站消息 {from, isGroup, content, at}
    waiter: null,       // { resolve, timer }
};

function jsonReq(method, url, headers, body) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = https.request({
            method, hostname: u.hostname, path: u.pathname + u.search, timeout: 30000,
            headers: { 'Content-Type': 'application/json', ...headers },
        }, res => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ s: res.statusCode, d: JSON.parse(d) }); }
                catch { resolve({ s: res.statusCode, d }); }
            });
        });
        req.on('timeout', () => { req.destroy(new Error('请求超时(30s) ' + url)); });
        req.on('error', reject);
        if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

async function getToken() {
    if (qq.token && Date.now() < qq.tokenExp - 60e3) return qq.token;
    const res = await jsonReq('POST', 'https://bots.qq.com/app/getAppAccessToken', {}, {
        appId: CFG.appId, clientSecret: CFG.appSecret,
    });
    if (res.s === 200 && res.d.access_token) {
        qq.token = res.d.access_token;
        qq.tokenExp = Date.now() + res.d.expires_in * 1000;
        log('token ok, expires_in:', res.d.expires_in);
        return qq.token;
    }
    throw new Error('getAppAccessToken 失败: ' + JSON.stringify(res.d));
}

async function authHeaders() {
    return { Authorization: 'QQBot ' + (await getToken()) };
}

function connectGateway() {
    (async () => {
        const token = await getToken();
        const gw = await jsonReq('GET', API_BASE + '/gateway', { Authorization: 'QQBot ' + token });
        if (gw.s !== 200 || !gw.d.url) throw new Error('gateway 失败: ' + JSON.stringify(gw.d));
        qq.ws = new WebSocket(gw.d.url);
        qq.ws.on('open', () => log('QQ gateway 已连接'));
        qq.ws.on('message', raw => {
            try {
                const p = JSON.parse(raw.toString());
                if (p.s) qq.seq = p.s;
                onPayload(p);
            } catch (e) { log('payload 解析失败:', e.message); }
        });
        qq.ws.on('close', code => {
            log('QQ gateway 断开 code=' + code + '，5s 后重连');
            qq.ready = false;
            clearInterval(qq.heartbeat);
            setTimeout(() => connectGateway().catch(e => log('重连失败:', e.message)), 5000);
        });
        qq.ws.on('error', e => log('QQ WS error:', e.message));
    })().catch(e => {
        log('连接失败:', e.message, '5s 后重试');
        setTimeout(connectGateway, 5000);
    });
}

function onPayload(p) {
    switch (p.op) {
        case 10: // Hello
            qq.ws.send(JSON.stringify({
                op: 2,
                d: {
                    token: 'QQBot ' + qq.token,
                    intents: (1 << 25) | (1 << 30), // C2C_MESSAGE_CREATE + GROUP_AT_MESSAGE_CREATE
                    shard: [0, 1],
                },
            }));
            qq.heartbeat = setInterval(() => {
                if (qq.ws?.readyState === 1) qq.ws.send(JSON.stringify({ op: 1, d: qq.seq }));
            }, p.d.heartbeat_interval);
            break;
        case 0: onDispatch(p); break;
        case 7: qq.ws?.close(); break;               // Reconnect
        case 9: qq.sessionId = null; break;          // Invalid session → 下个 Hello 重新 identify
    }
}

function onDispatch(p) {
    const d = p.d;
    if (p.t === 'READY') {
        qq.sessionId = d.session_id;
        qq.ready = true;
        log('READY session:', d.session_id);
        return;
    }
    let msg = null;
    if (p.t === 'C2C_MESSAGE_CREATE') {
        msg = { userId: d.author.user_openid, groupId: null, isGroup: false, msgId: d.id, content: d.content || '' };
    } else if (p.t === 'GROUP_AT_MESSAGE_CREATE') {
        msg = { userId: d.author.member_openid, groupId: d.group_openid, isGroup: true, msgId: d.id, content: (d.content || '').replace(/<@!\w+>/g, '').trim() };
    } else {
        return;
    }
    // 附带附件信息
    if (Array.isArray(d.attachments) && d.attachments.length) {
        msg.content += '\n[附件] ' + d.attachments.map(a => a.url).join(' , ');
    }
    qq.lastTarget = { userId: msg.userId, groupId: msg.groupId, isGroup: msg.isGroup, msgId: msg.msgId, msgTime: Date.now() };
    try { fs.writeFileSync(TARGET_FILE, JSON.stringify(qq.lastTarget)); } catch (e) {}
    log(`收到 QQ [${msg.isGroup ? 'group' : 'c2c'}] "${msg.content.slice(0, 80)}"`);

    if (qq.waiter) {
        const w = qq.waiter; qq.waiter = null;
        clearTimeout(w.timer);
        w.resolve(msg);
    } else {
        qq.inbox.push({ ...msg, at: Date.now() });
    }
}

// ================= 发送 =================

function splitMessage(text, limit) {
    if (text.length <= limit) return [text];
    const parts = [];
    let chunk = '';
    for (const line of text.split('\n')) {
        if (chunk.length + line.length + 1 > limit && chunk.length > 0) {
            parts.push(chunk.trim());
            chunk = '';
        }
        if (line.length > limit) {
            if (chunk.trim()) { parts.push(chunk.trim()); chunk = ''; }
            for (let i = 0; i < line.length; i += limit) parts.push(line.slice(i, i + limit));
        } else {
            chunk += (chunk ? '\n' : '') + line;
        }
    }
    if (chunk.trim()) parts.push(chunk.trim());
    return parts.length ? parts : [''];
}

function resolveTarget() {
    if (!qq.lastTarget) {
        try {
            if (fs.existsSync(TARGET_FILE)) {
                const t = JSON.parse(fs.readFileSync(TARGET_FILE, 'utf8'));
                if (t && (t.userId || t.groupId)) qq.lastTarget = t;
            }
        } catch (e) {}
    }
    if (qq.lastTarget) return qq.lastTarget;
    if (CFG.defaultUser) return { userId: CFG.defaultUser, groupId: null, isGroup: false, msgId: null, msgTime: 0 };
    if (CFG.defaultGroup) return { userId: null, groupId: CFG.defaultGroup, isGroup: true, msgId: null, msgTime: 0 };
    return null;
}

function msgUrl(t) {
    return t.isGroup ? `${API_BASE}/v2/groups/${t.groupId}/messages` : `${API_BASE}/v2/users/${t.userId}/messages`;
}
function fileUrl(t) {
    return t.isGroup ? `${API_BASE}/v2/groups/${t.groupId}/files` : `${API_BASE}/v2/users/${t.userId}/files`;
}

/** 发送一条文本消息（自动分段、被动/主动自适应）。返回 {ok, parts, errors[]} */
async function sendText(text) {
    const t = resolveTarget();
    if (!t) return { ok: false, error: '没有可用的 QQ 会话目标。请先让用户给机器人发一条消息，或配置 QQBOT_DEFAULT_USER。' };
    const headers = await authHeaders();
    const url = msgUrl(t);
    const canPassive = t.msgId && (Date.now() - t.msgTime < PASSIVE_TTL);
    const parts = splitMessage(text, MSG_LIMIT);
    const errors = [];
    for (let i = 0; i < parts.length; i++) {
        const body = { content: parts.length > 1 ? `[${i + 1}/${parts.length}]\n${parts[i]}` : parts[i], msg_type: 0 };
        if (canPassive) body.msg_id = t.msgId;
        body.msg_seq = ++qq.pushSeq;
        const res = await jsonReq('POST', url, headers, body);
        log(`文本 ${i + 1}/${parts.length} →`, res.s, JSON.stringify(res.d).slice(0, 200));
        if (res.s !== 200 && res.s !== 201) errors.push(`第${i + 1}段: HTTP ${res.s} ${JSON.stringify(res.d).slice(0, 150)}`);
        if (i < parts.length - 1) await new Promise(r => setTimeout(r, 1200));
    }
    return { ok: errors.length === 0, parts: parts.length, mode: canPassive ? 'passive' : 'proactive', errors };
}

/** 发送一张本地图片。返回 {ok, file_info|error} */
async function sendImage(filePath) {
    const t = resolveTarget();
    if (!t) return { ok: false, error: '没有可用的 QQ 会话目标' };
    let b64;
    try {
        b64 = fs.readFileSync(filePath).toString('base64');
    } catch (e) {
        return { ok: false, error: `读取文件失败 ${filePath}: ${e.message}` };
    }
    const headers = await authHeaders();
    // 1) 上传富媒体文件 file_type=1 图片
    const up = await jsonReq('POST', fileUrl(t), headers, { file_type: 1, file_data: b64, srv_send_msg: false });
    log('上传图片 →', up.s, JSON.stringify(up.d).slice(0, 200));
    if (!up.d || !up.d.file_info) return { ok: false, error: `上传失败: HTTP ${up.s} ${JSON.stringify(up.d).slice(0, 150)}` };
    // 2) msg_type=7 富媒体消息
    const t2 = resolveTarget();
    const canPassive = t2.msgId && (Date.now() - t2.msgTime < PASSIVE_TTL);
    const body = { msg_type: 7, media: { file_info: up.d.file_info }, content: ' ' };
    if (canPassive) body.msg_id = t2.msgId;
    body.msg_seq = ++qq.pushSeq;
    const res = await jsonReq('POST', msgUrl(t2), headers, body);
    log('图片消息 →', res.s, JSON.stringify(res.d).slice(0, 200));
    if (res.s !== 200 && res.s !== 201) return { ok: false, error: `发送失败: HTTP ${res.s} ${JSON.stringify(res.d).slice(0, 150)}` };
    return { ok: true };
}

function waitForReply(timeoutMs) {
    return new Promise(resolve => {
        // 入站队列已有消息 → 直接取最早一条
        if (qq.inbox.length) return resolve(qq.inbox.shift());
        const timer = setTimeout(() => {
            if (qq.waiter) { qq.waiter = null; resolve(null); }
        }, timeoutMs);
        qq.waiter = { resolve, timer };
    });
}

// ================= MCP =================

const server = new McpServer({ name: 'qqbot', version: '1.0.0' });

server.registerTool('qq_send_message', {
    description: '通过 QQ 机器人给用户发送消息。支持纯文本和本地图片（image_paths 为图片文件绝对路径数组）。发送目标为最近与机器人对话的用户/群。',
    inputSchema: {
        text: z.string().optional().describe('要发送的文本（可选，至少提供 text 或 image_paths 之一）'),
        image_paths: z.array(z.string()).optional().describe('本地图片文件的绝对路径数组'),
    },
}, async ({ text, image_paths }) => {
    const out = [];
    if (text) {
        const r = await sendText(text);
        out.push(r.ok ? `文本已发送（${r.parts} 段，${r.mode}）` : `文本发送失败: ${r.error || r.errors.join('; ')}`);
    }
    for (const p of image_paths || []) {
        const r = await sendImage(p);
        out.push(r.ok ? `图片已发送: ${p}` : `图片失败 ${p}: ${r.error}`);
    }
    if (!out.length) out.push('未提供 text 或 image_paths');
    return { content: [{ type: 'text', text: out.join('\n') }] };
});

server.registerTool('qq_notify_and_wait', {
    description: '任务完成后调用：把标题+摘要（可选图片）推送到 QQ，然后阻塞等待用户在 QQ 中回复的下一条指令，返回该指令文本。可用于"AI 完成 → QQ 通知 → 等待远程指令"的循环。',
    inputSchema: {
        title: z.string().describe('简短标题，如"编译完成"'),
        summary: z.string().describe('详细说明完成了什么'),
        choices: z.array(z.string()).optional().describe('猜测用户下一步操作的候选选项（编号展示，用户可回数字或直接回复）'),
        image_paths: z.array(z.string()).optional().describe('随通知发送的本地图片路径'),
        timeout_seconds: z.number().optional().describe('等待用户回复的最长秒数，默认 300，最大 7200'),
    },
}, async ({ title, summary, choices, image_paths, timeout_seconds }) => {
    let text = `【${title}】\n${summary}`;
    if (choices?.length) {
        text += '\n\n回复数字选择，或直接输入指令：\n' + choices.map((c, i) => `${i + 1}. ${c}`).join('\n');
    }
    const send = await sendText(text);
    const results = [send.ok ? `通知已发送（${send.mode}）` : `通知发送失败: ${send.error || send.errors.join('; ')}`];
    for (const p of image_paths || []) {
        const r = await sendImage(p);
        results.push(r.ok ? `图片已发送: ${p}` : `图片失败 ${p}: ${r.error}`);
    }
    if (!send.ok && !image_paths?.length) {
        return { content: [{ type: 'text', text: results.join('\n') }] };
    }

    const timeout = Math.min(Math.max(timeout_seconds || 300, 10), 7200) * 1000;
    const reply = await waitForReply(timeout);
    if (!reply) {
        results.push(`等待超时（${timeout / 1000}s 内未收到 QQ 回复）。如需继续等待可再次调用本工具。`);
        return { content: [{ type: 'text', text: results.join('\n') }] };
    }
    let matched = null;
    if (choices?.length) {
        const n = parseInt(reply.content.trim(), 10);
        if (n >= 1 && n <= choices.length) matched = choices[n - 1];
    }
    results.push(`用户回复: ${reply.content}` + (matched ? `\n匹配选项: ${matched}` : ''));
    return { content: [{ type: 'text', text: results.join('\n') }] };
});

server.registerTool('qq_get_messages', {
    description: '读取并清空在没有等待时堆积的 QQ 入站消息队列。',
    inputSchema: {},
}, async () => {
    const msgs = qq.inbox.splice(0);
    if (!msgs.length) return { content: [{ type: 'text', text: '无新消息' }] };
    const lines = msgs.map(m => `[${new Date(m.at).toLocaleTimeString()}] ${m.isGroup ? '群' : '私聊'} ${m.userId}: ${m.content}`);
    return { content: [{ type: 'text', text: lines.join('\n') }] };
});

server.registerTool('qq_get_status', {
    description: '查看 QQ 机器人连接状态、最近会话目标、沙箱模式。',
    inputSchema: {},
}, async () => {
    const t = qq.lastTarget;
    const info = {
        gateway_ready: qq.ready,
        sandbox: CFG.sandbox,
        inbox_size: qq.inbox.length,
        waiting: !!qq.waiter,
        last_target: t ? { type: t.isGroup ? 'group' : 'c2c', id: t.groupId || t.userId, last_msg_age_sec: Math.round((Date.now() - t.msgTime) / 1000) } : null,
        fallback_target: CFG.defaultUser || CFG.defaultGroup || null,
    };
    return { content: [{ type: 'text', text: JSON.stringify(info, null, 2) }] };
});

// ================= 启动 =================

async function main() {
    if (!CFG.appId || !CFG.appSecret) {
        log('缺少 QQBOT_APP_ID / QQBOT_APP_SECRET 环境变量，退出');
        process.exit(1);
    }
    connectGateway();
    const transport = new StdioServerTransport();
    await server.connect(transport);
    log('MCP server 已启动 (stdio)，sandbox=' + CFG.sandbox);
}

main().catch(e => { log('启动失败:', e); process.exit(1); });
