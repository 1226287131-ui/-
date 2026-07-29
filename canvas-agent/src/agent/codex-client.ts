import { spawn, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { VERSION } from "../config.js";
import { logger } from "../utils/logger.js";
import { field, type JsonRecord } from "../utils/value.js";
import type { AgentEmit } from "./types.js";

type AgentEvent = JsonRecord & { type: string; usage?: unknown };
type PendingRequest = { resolve: (value: unknown) => void; reject: (error: Error) => void };

const canvasAgentMcp = canvasAgentMcpCommand();
const require = createRequire(import.meta.url);

/** 封装 Codex app-server 的 JSON-RPC 通信与事件转换。 */
export class CodexAppClient {
    private nextId = 1;
    private buffer = "";
    private currentThreadId = "";
    private textByItem = new Map<string, string>();
    private lastUsage: unknown = null;
    private pending = new Map<number, PendingRequest>();
    private activeTurns = new Map<string, PendingRequest>();
    private completedTurns = new Map<string, Error | null>();

    /** 保存 app-server 子进程和事件出口。 */
    private constructor(private child: ChildProcess, private emit: AgentEmit) {}

    /** 启动并初始化 Codex app-server。 */
    static async start(emit: AgentEmit, onExit: () => void) {
        logger.info("Starting Codex app-server", { executable: process.execPath, codex: codexBin() });
        const child = spawn(process.execPath, [codexBin(), "app-server", "--stdio"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
        const client = new CodexAppClient(child, emit);
        child.stdout?.on("data", (chunk) => client.read(chunk.toString()));
        child.stderr?.on("data", (chunk) => {
            const text = chunk.toString();
            logger.warn("Codex app-server stderr", { text });
            emit("agent_log", { text });
        });
        child.on("error", (error) => {
            logger.error("Codex app-server process error", error);
            emit("agent_error", { message: error.message });
        });
        child.on("exit", (code) => {
            logger.warn("Codex app-server exited", { code });
            client.failAll(`Codex app-server exited: ${code ?? 0}`);
            onExit();
            emit("agent_log", { text: `Codex app-server exited: ${code ?? 0}` });
        });
        await client.request("initialize", { clientInfo: { name: "canvas-agent", title: "Infinite Canvas Agent", version: VERSION }, capabilities: { experimentalApi: true, requestAttestation: false } });
        client.notify("initialized");
        return client;
    }

    /** 创建新的 Codex 线程。 */
    async startThread(cwd?: string) {
        const result = await this.request("thread/start", { approvalPolicy: "never", sandbox: "workspace-write", config: codexConfig(), ...(cwd ? { cwd } : {}), threadSource: "user" });
        const thread = field(result, "thread") as JsonRecord | undefined;
        const id = String(field(thread, "id") || "");
        if (!id) throw new Error("Codex app-server 没有返回 thread id");
        return thread || {};
    }

    /** 恢复已有 Codex 线程。 */
    async resumeThread(threadId: string, cwd?: string) {
        const result = await this.request("thread/resume", { threadId, approvalPolicy: "never", sandbox: "workspace-write", config: codexConfig(), ...(cwd ? { cwd } : {}) });
        const thread = field(result, "thread") as JsonRecord | undefined;
        const id = String(field(thread, "id") || "");
        if (!id) throw new Error("Codex app-server 没有返回 thread id");
        return thread || {};
    }

    /** 查询 Codex 线程列表。 */
    listThreads(params: JsonRecord) {
        return this.request("thread/list", params);
    }

    /** 读取指定 Codex 线程。 */
    readThread(threadId: string, includeTurns = true) {
        return this.request("thread/read", { threadId, includeTurns });
    }

    /** 归档指定 Codex 线程。 */
    archiveThread(threadId: string) {
        return this.request("thread/archive", { threadId });
    }

    /** 启动一个 Codex turn 并等待完成通知。 */
    async startTurn(threadId: string, prompt: string, images: string[], onTurn?: (turnId: string) => void) {
        const result = await this.request("turn/start", { threadId, input: codexInput(prompt, images), approvalPolicy: "never" });
        const turnId = String(field(field(result, "turn"), "id") || "");
        if (!turnId) throw new Error("Codex app-server 没有返回 turn id");
        this.currentThreadId = threadId;
        onTurn?.(turnId);
        const completed = this.completedTurns.get(turnId);
        if (this.completedTurns.has(turnId)) {
            this.completedTurns.delete(turnId);
            if (completed) throw completed;
            return;
        }
        await new Promise((resolve, reject) => this.activeTurns.set(turnId, { resolve, reject }));
    }

    /** 中断当前正在运行的 Codex turn。 */
    interruptCurrentTurn() {
        if (this.activeTurns.size === 0) return false;
        try {
            logger.warn("Interrupting active Codex turn", { threadId: this.currentThreadId, activeTurns: this.activeTurns.size });
            this.child.kill("SIGINT");
            return true;
        } catch {
            return false;
        }
    }

    /** 发送 JSON-RPC 请求并保存待处理 Promise。 */
    private request(method: string, params: unknown) {
        const id = this.nextId++;
        this.write({ id, method, params });
        return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    }

    /** 发送无需响应的 JSON-RPC 通知。 */
    private notify(method: string, params?: unknown) {
        this.write(params === undefined ? { method } : { method, params });
    }

    /** 将 JSON-RPC 消息写入 app-server 标准输入。 */
    private write(value: unknown) {
        const method = String(field(value, "method") || "");
        const params = field(value, "params");
        if (method) logger.debug(`Codex ${method}`, { id: field(value, "id"), threadId: field(params, "threadId") });
        this.child.stdin?.write(`${JSON.stringify(value)}\n`);
    }

    /** 按行解析 app-server 标准输出。 */
    private read(chunk: string) {
        this.buffer += chunk;
        const lines = this.buffer.split(/\r?\n/);
        this.buffer = lines.pop() || "";
        lines.filter(Boolean).forEach((line) => {
            try {
                this.handle(JSON.parse(line) as JsonRecord);
            } catch (error) {
                logger.warn("Invalid Codex app-server output", { error, line });
                this.emit("agent_log", { text: line });
            }
        });
    }

    /** 分派单条 JSON-RPC 响应、请求或通知。 */
    private handle(message: JsonRecord) {
        const id = Number(message.id);
        if (message.error && this.pending.has(id)) {
            const error = String(field(message.error, "message") || "Codex request failed");
            logger.warn("Codex request failed", { id, error });
            return this.reject(id, error);
        }
        if (this.pending.has(id)) return this.resolve(id, message.result);
        if (typeof message.method === "string" && "id" in message) return this.answerServerRequest(message);
        if (typeof message.method === "string") this.handleNotification(message.method, (message.params || {}) as JsonRecord);
    }

    /** 转换并广播 app-server 通知。 */
    private handleNotification(method: string, params: JsonRecord) {
        if (method === "item/agentMessage/delta") return this.emitDelta(params);
        if (method === "thread/tokenUsage/updated") {
            this.lastUsage = normalizeUsage(params);
            this.emit("agent_event", { agent: "codex", type: "usage.updated", usage: this.lastUsage, ...codexEventScope(params) });
            return;
        }
        const event = normalizeCodexNotification(method, params);
        if (!event) return;
        if (event.type === "item.completed") {
            const item = field(event, "item") as JsonRecord | undefined;
            const id = String(field(item, "id") || "");
            const streamedText = this.textByItem.get(id);
            if (item?.type === "agent_message" && streamedText && !item.text) item.text = streamedText;
            if (id) this.textByItem.delete(id);
        }
        if (event.type === "turn.completed") event.usage = this.lastUsage;
        this.emit("agent_event", { agent: "codex", ...event });
        if (event.type === "turn.completed") {
            const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
            const pending = this.activeTurns.get(turnId);
            const error = field(field(params, "turn"), "error");
            if (pending) {
                this.activeTurns.delete(turnId);
                error ? pending.reject(new Error(String(field(error, "message") || "Codex turn failed"))) : pending.resolve(event);
            } else if (turnId) {
                this.completedTurns.set(turnId, error ? new Error(String(field(error, "message") || "Codex turn failed")) : null);
            }
            if (this.activeTurns.size === 0) this.currentThreadId = "";
            this.emit("agent_done", { agent: "codex", usage: event.usage, ...codexEventScope(params) });
        }
    }

    /** 合并并广播 Agent 文本增量。 */
    private emitDelta(params: JsonRecord) {
        const id = String(field(params, "itemId") || "");
        const text = `${this.textByItem.get(id) || ""}${String(field(params, "delta") || "")}`;
        this.textByItem.set(id, text);
        this.emit("agent_event", { agent: "codex", type: "item.updated", item: { id, type: "agent_message", text }, ...codexEventScope(params) });
    }

    /** 自动回复 app-server 发起的授权或交互请求。 */
    private answerServerRequest(message: JsonRecord) {
        const method = String(message.method);
        const result = method === "mcpServer/elicitation/request" ? { action: "accept", content: {}, _meta: null } : { decision: "decline" };
        this.write({ id: message.id, result });
        this.emit("agent_event", { agent: "codex", type: "server.request", method, params: message.params, result });
    }

    /** 完成指定 JSON-RPC 请求。 */
    private resolve(id: number, result: unknown) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.resolve(result));
    }

    /** 拒绝指定 JSON-RPC 请求。 */
    private reject(id: number, message: string) {
        const pending = this.pending.get(id);
        if (pending) (this.pending.delete(id), pending.reject(new Error(message)));
    }

    /** 拒绝进程退出时仍未完成的请求与 turn。 */
    private failAll(message: string) {
        [...this.pending.values(), ...this.activeTurns.values()].forEach((item) => item.reject(new Error(message)));
        this.pending.clear();
        this.activeTurns.clear();
        this.currentThreadId = "";
    }
}

/** 生成 Codex 调用 Canvas Agent MCP 的启动命令。 */
function canvasAgentMcpCommand() {
    const current = process.argv.find((arg) => /index\.(t|j)s$/.test(arg)) || "";
    const entry = path.resolve(current || fileURLToPath(new URL("../index.js", import.meta.url)));
    const tsx = path.join(path.dirname(entry), "..", "node_modules", "tsx", "dist", "cli.mjs");
    return entry.endsWith(".ts") ? { command: process.execPath, args: [tsx, entry, "mcp"] } : { command: process.execPath, args: [entry, "mcp"] };
}

/** 生成 Codex app-server 使用的 MCP 配置。 */
function codexConfig() {
    return { mcp_servers: { "infinite-canvas": { command: canvasAgentMcp.command, args: canvasAgentMcp.args, default_tools_approval_mode: "approve", startup_timeout_sec: 20, tool_timeout_sec: 90 } } };
}

/** 将文本和本地图片转换为 Codex turn 输入。 */
function codexInput(prompt: string, images: string[]) {
    return [{ type: "text", text: prompt, text_elements: [] }, ...images.map((file) => ({ type: "localImage", path: file }))];
}

/** 将 app-server 通知转换为前端使用的 Agent 事件。 */
function normalizeCodexNotification(method: string, params: JsonRecord): AgentEvent | null {
    const scope = codexEventScope(params);
    if (method === "thread/started") return { type: "thread.started", ...scope };
    if (method === "turn/started") return { type: "turn.started", ...scope };
    if (method === "turn/completed") return { type: "turn.completed", usage: null, duration_ms: field(field(params, "turn"), "durationMs"), ...scope };
    if (method === "item/started") return { type: "item.started", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "item/completed") return { type: "item.completed", item: normalizeItem(field(params, "item")), ...scope };
    if (method === "error") return { type: "error", message: field(params, "message"), ...scope };
    return null;
}

/** 提取 Codex 事件所属的线程和 turn。 */
function codexEventScope(params: JsonRecord) {
    const threadId = String(field(params, "threadId") || field(field(params, "thread"), "id") || "");
    const turnId = String(field(params, "turnId") || field(field(params, "turn"), "id") || "");
    return { ...(threadId ? { thread_id: threadId } : {}), ...(turnId ? { turn_id: turnId } : {}) };
}

/** 统一 app-server item 的类型和参数格式。 */
function normalizeItem(item: unknown) {
    const value = item && typeof item === "object" ? { ...(item as JsonRecord) } : {};
    if (value.type === "agentMessage") value.type = "agent_message";
    if (value.type === "mcpToolCall") value.type = "mcp_tool_call";
    if (value.type === "agent_message" && typeof value.id === "string") value.text = String(value.text || "");
    if ("arguments" in value) value.arguments = parseMaybeJson(value.arguments);
    return value;
}

/** 将 Codex token usage 转换为前端字段。 */
function normalizeUsage(params: JsonRecord) {
    const last = field(field(params, "tokenUsage"), "last") as JsonRecord | undefined;
    return {
        input_tokens: field(last, "inputTokens"),
        cached_input_tokens: field(last, "cachedInputTokens"),
        output_tokens: field(last, "outputTokens"),
        reasoning_output_tokens: field(last, "reasoningOutputTokens"),
    };
}

/** 尝试将字符串解析为 JSON，失败时保留原值。 */
function parseMaybeJson(value: unknown) {
    if (typeof value !== "string") return value;
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

/** 定位当前依赖中 Codex CLI 的执行文件。 */
function codexBin() {
    return path.join(path.dirname(require.resolve("@openai/codex/package.json")), "bin", "codex.js");
}
