import { useEffect, useState, type ReactNode } from "react";
import { Button } from "antd";
import { Brain, CheckCircle2, ChevronDown, Circle, CircleAlert, FilePenLine, FileText, ListChecks, LoaderCircle, Search, TerminalSquare, UserRound, Wrench, XCircle } from "lucide-react";
import { Streamdown } from "streamdown";

import { canvasThemes } from "@/lib/canvas-theme";
import type { LocalUser } from "@/stores/use-user-store";

export type AgentChatAttachment = { id: string; name: string; url: string };
export type AgentChatMessageItem = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    attachments?: AgentChatAttachment[];
    /** Present while the message is actively streaming; cleared on completion. */
    streamId?: string;
};

export function AgentChatMessage({ item, theme, user, onRejectTool, onApproveTool }: { item: AgentChatMessageItem; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; user: LocalUser | null; onRejectTool?: (id: string) => void; onApproveTool?: (id: string) => void }) {
    const isUser = item.role === "user";
    const isSystem = item.role === "system";
    const color = item.role === "error" ? "#dc2626" : item.role === "tool" ? "#2563eb" : theme.node.text;
    if (isSystem) {
        return (
            <div className="flex justify-center text-xs">
                <div className="max-w-[88%] px-3 py-1.5 text-center" style={{ color: theme.node.muted }}>
                    {item.text}
                    {item.meta ? <span className="ml-2 opacity-60">{item.meta}</span> : null}
                </div>
            </div>
        );
    }
    if (item.role === "tool") {
        if (objectField(item.detail, "status") === "pending") return <AgentPendingToolCard summary={item.text} detail={item.detail} theme={theme} onReject={() => onRejectTool?.(item.id)} onApprove={() => onApproveTool?.(item.id)} />;
        return (
            <div className="flex items-start gap-3">
                <AgentAvatar theme={theme} />
                <AgentToolCard title={item.title || "工具调用"} text={item.text} detail={item.detail} theme={theme} />
            </div>
        );
    }
    return (
        <div className={`flex items-start gap-3 ${isUser ? "justify-end" : "justify-start"}`}>
            {!isUser ? <AgentAvatar theme={theme} /> : null}
            <div
                className={isUser ? "min-w-0 max-w-[82%] py-1 text-right text-sm leading-6" : "min-w-0 flex-1 text-left text-sm leading-6"}
                style={{ color }}
            >
                {isUser ? (
                    <div className="whitespace-pre-wrap break-words">{item.text}</div>
                ) : (
                    <Streamdown animated isAnimating={!!item.streamId}>{item.text}</Streamdown>
                )}
                {item.attachments?.length ? <AgentMessageAttachments attachments={item.attachments} alignRight={isUser} /> : null}
                {item.meta ? <div className={`mt-1 text-[11px] tabular-nums opacity-55 ${isUser ? "text-right" : ""}`}>{item.meta}</div> : null}
            </div>
            {isUser ? <AgentUserAvatar user={user} theme={theme} /> : null}
        </div>
    );
}

export function AgentPendingToolCard({ summary, detail, theme, onReject, onApprove }: { summary: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onReject?: () => void; onApprove?: () => void }) {
    const view = userDetail(detail);
    return (
        <div className="flex items-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 flex-1 rounded-xl border px-3 py-3" style={{ borderColor: "rgba(217,119,6,.28)", background: "rgba(217,119,6,.025)", color: theme.node.text }}>
                <details className="group">
                    <summary className={`flex list-none items-start gap-2.5 ${view ? "cursor-pointer" : "cursor-default"}`} onClick={(event) => { if (!view) event.preventDefault(); }}>
                        <CircleAlert className="mt-0.5 size-4 shrink-0 text-amber-600" />
                        <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-sm font-medium leading-5">
                                <span>等待确认</span>
                                {view ? <ChevronDown className="ml-auto size-3.5 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} /> : null}
                            </div>
                            <div className="mt-1 text-sm leading-5" style={{ color: theme.node.muted }}>{summary}</div>
                        </div>
                    </summary>
                    {view ? <AgentDetailBlock detail={view} theme={theme} /> : null}
                </details>
                {onReject || onApprove ? (
                    <div className="mt-3 flex justify-end gap-2 border-t pt-3" style={{ borderColor: theme.node.stroke }}>
                        <Button danger type="text" className="!h-8" icon={<XCircle className="size-3.5" />} onClick={() => onReject?.()}>
                            拒绝执行
                        </Button>
                        <Button type="text" className="!h-8" icon={<CheckCircle2 className="size-3.5" />} style={{ color: "#16a34a" }} onClick={() => onApprove?.()}>
                            批准执行
                        </Button>
                    </div>
                ) : null}
            </div>
        </div>
    );
}

export function AgentToolCard({ title, text, detail, theme }: { title: string; text: string; detail?: unknown; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const plan = planDetail(detail);
    if (plan) return <AgentPlanCard title={title} plan={plan} theme={theme} />;
    const state = toolCardState(title, text, detail);
    const view = userDetail(detail);
    const kind = String(objectField(detail, "kind") || "");
    return (
        <details className="group min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className={`flex list-none items-start gap-2.5 ${view ? "cursor-pointer" : "cursor-default"}`} onClick={(event) => { if (!view) event.preventDefault(); }}>
                <span className="mt-0.5 shrink-0" style={{ color: state.color }}>{toolIcon(kind, state.icon)}</span>
                <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2 text-sm font-medium leading-5">
                        <span className="min-w-0 truncate">{title}</span>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[11px] font-normal" style={{ color: state.color }}>
                            {state.label}
                        </span>
                        {view ? <ChevronDown className="ml-auto size-3.5 shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} /> : null}
                    </div>
                    <div className={`mt-1 whitespace-pre-wrap break-words text-sm leading-5 ${kind === "command" ? "font-mono text-[12px]" : ""}`} style={{ color: state.isError ? state.color : theme.node.muted }}>
                        {text}
                    </div>
                </div>
            </summary>
            {view ? <AgentDetailBlock detail={view} theme={theme} /> : null}
        </details>
    );
}

function AgentPlanCard({ title, plan, theme }: { title: string; plan: PlanDetail; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const [open, setOpen] = useState(true);
    const completed = plan.tasks.filter((item) => item.status === "completed").length;
    const state = planCardState(plan, completed);
    return (
        <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)} className="group min-w-0 flex-1 rounded-xl border px-3 py-2.5 text-left" style={{ borderColor: theme.node.stroke, background: "transparent", color: theme.node.text }}>
            <summary className="flex min-w-0 cursor-pointer list-none items-center gap-2.5">
                <ListChecks className="size-4 shrink-0" style={{ color: state.color }} />
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
                <span className="shrink-0 text-[11px]" style={{ color: state.color }}>{state.label}</span>
                <span aria-live="polite" className="shrink-0 text-[11px] tabular-nums" style={{ color: theme.node.muted }}>{completed}/{plan.tasks.length}</span>
                <ChevronDown className="size-3.5 shrink-0 transition-transform group-open:rotate-180" style={{ color: theme.node.muted }} />
            </summary>
            {plan.explanation ? <div className="mt-1.5 text-xs leading-5" style={{ color: theme.node.muted }}>{plan.explanation}</div> : null}
            <div className="mt-2.5 space-y-2 border-t pt-2.5" style={{ borderColor: theme.node.stroke }}>
                {plan.tasks.map((item, index) => {
                    const task = planTaskState(item.status, theme.node.muted);
                    return (
                        <div key={`${index}-${item.step}`} className="flex items-start gap-2 text-sm leading-5">
                            <span className="mt-0.5 shrink-0" style={{ color: task.color }}>{task.icon}</span>
                            <span className={`min-w-0 flex-1 ${item.status === "completed" ? "opacity-55" : item.status === "inProgress" ? "font-medium" : ""}`} style={{ color: item.status === "inProgress" ? theme.node.text : theme.node.muted }}>{item.step}</span>
                            <span className="shrink-0 text-[11px]" style={{ color: task.color }}>{task.label}</span>
                        </div>
                    );
                })}
            </div>
        </details>
    );
}

export function AgentWorkingMessage({ text, activityKey, theme }: { text: string; activityKey: string; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const [elapsed, setElapsed] = useState(0);
    useEffect(() => {
        const startedAt = Date.now();
        setElapsed(0);
        const timer = window.setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
        return () => window.clearInterval(timer);
    }, [activityKey]);
    return (
        <div className="flex items-start gap-3">
            <AgentAvatar theme={theme} />
            <div className="min-w-0 flex-1 py-1" aria-live="polite">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" style={{ color: theme.node.muted }}>
                    <LoaderCircle className="size-3.5 shrink-0 animate-spin" />
                    <span className="min-w-0">{text}</span>
                    {elapsed >= 5 ? <span className="shrink-0 text-[11px] tabular-nums opacity-60">{waitingTime(elapsed)}</span> : null}
                </div>
                {elapsed >= 30 ? <div className="mt-1 text-xs leading-5 opacity-65" style={{ color: theme.node.muted }}>响应时间较长，但任务仍在运行。可以继续等待，或点击输入框右侧的停止按钮结束本轮。</div> : null}
            </div>
        </div>
    );
}

function waitingTime(seconds: number) {
    if (seconds < 60) return `已等待 ${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return `已等待 ${minutes} 分 ${seconds % 60} 秒`;
}

type PlanTask = { step: string; status: string };
type PlanDetail = { status: string; tasks: PlanTask[]; explanation?: string };
type UserDetail = { kind?: string; status?: string; rows?: Array<{ label: string; value: string }>; output?: string; files?: Array<{ path: string; action?: string }> };

function AgentDetailBlock({ detail, theme }: { detail: UserDetail; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <div className="mt-3 space-y-2.5 border-t pt-3 text-xs" style={{ borderColor: theme.node.stroke, color: theme.node.muted }}>
            {detail.rows?.length ? (
                <dl className="space-y-1.5">
                    {detail.rows.map((row) => (
                        <div key={`${row.label}-${row.value}`} className="grid grid-cols-[64px_minmax(0,1fr)] gap-2">
                            <dt className="opacity-60">{row.label}</dt>
                            <dd className="min-w-0 break-words" style={{ color: theme.node.text }}>{row.value}</dd>
                        </div>
                    ))}
                </dl>
            ) : null}
            {detail.files?.length ? (
                <div className="space-y-1.5">
                    <div className="opacity-60">涉及文件</div>
                    {detail.files.map((file) => (
                        <div key={`${file.action}-${file.path}`} className="flex items-start gap-2">
                            <FileText className="mt-0.5 size-3.5 shrink-0" />
                            <span className="min-w-0 flex-1 break-all" style={{ color: theme.node.text }}>{file.path}</span>
                            {file.action ? <span className="shrink-0 opacity-60">{file.action}</span> : null}
                        </div>
                    ))}
                </div>
            ) : null}
            {detail.output ? (
                <div className="space-y-1.5">
                    <div className="opacity-60">{detail.status === "failed" || detail.status === "error" ? "错误信息" : "运行输出"}</div>
                    <pre className="thin-scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-lg px-3 py-2 font-mono text-[11px] leading-4" style={{ background: theme.toolbar.panel, color: theme.node.text }}>{detail.output}</pre>
                </div>
            ) : null}
        </div>
    );
}

function AgentAvatar({ theme }: { theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    return (
        <span className="grid size-8 shrink-0 place-items-center" role="img" aria-label="OpenAI">
            <span className="size-5 opacity-80" style={{ background: theme.node.text, WebkitMask: "url(/icons/openai.svg) center / contain no-repeat", mask: "url(/icons/openai.svg) center / contain no-repeat" }} />
        </span>
    );
}

function AgentUserAvatar({ user, theme }: { user: LocalUser | null; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const avatarUrl = user?.avatarUrl?.trim();
    return (
        <span className="grid size-8 shrink-0 place-items-center overflow-hidden rounded-full" style={{ color: theme.node.text }}>
            {avatarUrl ? <img src={avatarUrl} alt="" className="size-full object-cover" referrerPolicy="no-referrer" /> : <UserRound className="size-4" />}
        </span>
    );
}

function AgentMessageAttachments({ attachments, alignRight }: { attachments: AgentChatAttachment[]; alignRight?: boolean }) {
    return (
        <div className={`mt-2 flex flex-wrap gap-2 ${alignRight ? "justify-end" : "justify-start"}`}>
            {attachments.map((item) => (
                <img key={item.id} src={item.url} alt={item.name} className="max-h-72 max-w-[280px] rounded-xl object-contain" />
            ))}
        </div>
    );
}

function toolCardState(title: string, text: string, detail?: unknown) {
    const raw = `${title} ${text} ${normalizeText(objectField(detail, "error"))}`;
    const lower = raw.toLowerCase();
    const status = String(objectField(detail, "status") || "").toLowerCase();
    if (status === "noop" || /未生效|无需|没有找到|没有.*可|已存在/.test(raw)) return { label: "未生效", color: "#d97706", icon: <CircleAlert className="size-4" />, isError: false };
    if (["declined", "rejected", "cancelled", "canceled"].includes(status) || /拒绝|取消/.test(raw)) return { label: "已取消", color: "#dc2626", icon: <XCircle className="size-4" />, isError: true };
    if (["failed", "error"].includes(status) || /失败|错误/.test(raw) || lower.includes("failed") || lower.includes("error")) return { label: "执行失败", color: "#dc2626", icon: <XCircle className="size-4" />, isError: true };
    if (["inprogress", "in_progress", "running", "started", "pending"].includes(status)) return { label: "进行中", color: "#d97706", icon: <LoaderCircle className="size-4 animate-spin" />, isError: false };
    if (["completed", "succeeded", "success"].includes(status) || /完成|成功/.test(raw)) return { label: "已完成", color: "#16a34a", icon: <CheckCircle2 className="size-4" />, isError: false };
    return { label: "已记录", color: "#2563eb", icon: <Wrench className="size-4" />, isError: false };
}

function toolIcon(kind: string | undefined, fallback: ReactNode) {
    if (kind === "reasoning") return <Brain className="size-4" />;
    if (kind === "command") return <TerminalSquare className="size-4" />;
    if (kind === "search") return <Search className="size-4" />;
    if (kind === "file") return <FilePenLine className="size-4" />;
    if (kind === "plan") return <ListChecks className="size-4" />;
    return fallback;
}

function planCardState(plan: PlanDetail, completed: number) {
    if (plan.status === "failed") return { label: "执行失败", color: "#dc2626" };
    if (["interrupted", "cancelled", "canceled"].includes(plan.status)) return { label: "已停止", color: "#d97706" };
    if (completed === plan.tasks.length) return { label: "已完成", color: "#16a34a" };
    if (plan.status === "finished") return { label: "已结束", color: "#2563eb" };
    return { label: "进行中", color: "#d97706" };
}

function planTaskState(status: string, muted: string) {
    if (status === "completed") return { label: "已完成", color: "#16a34a", icon: <CheckCircle2 className="size-3.5" /> };
    if (status === "inProgress") return { label: "进行中", color: "#d97706", icon: <LoaderCircle className="size-3.5 animate-spin" /> };
    return { label: "待处理", color: muted, icon: <Circle className="size-3.5" /> };
}

function planDetail(value: unknown): PlanDetail | null {
    if (!value || typeof value !== "object" || objectField(value, "kind") !== "todo") return null;
    const tasks = Array.isArray(objectField(value, "tasks"))
        ? (objectField(value, "tasks") as unknown[]).flatMap((item) => {
              const step = String(objectField(item, "step") || "").trim();
              return step ? [{ step, status: String(objectField(item, "status") || "pending") }] : [];
          })
        : [];
    if (!tasks.length) return null;
    const explanation = String(objectField(value, "explanation") || "").trim();
    return { status: String(objectField(value, "status") || "inProgress"), tasks, ...(explanation ? { explanation } : {}) };
}

function userDetail(value: unknown): UserDetail | null {
    if (!value || typeof value !== "object") return null;
    const detail = value as Record<string, unknown>;
    const rows = Array.isArray(detail.rows)
        ? detail.rows.flatMap((row) => {
              if (!row || typeof row !== "object") return [];
              const label = String((row as Record<string, unknown>).label || "");
              const value = String((row as Record<string, unknown>).value || "");
              return label && value ? [{ label, value }] : [];
          })
        : [];
    const files = Array.isArray(detail.files)
        ? detail.files.flatMap((file) => {
              if (!file || typeof file !== "object") return [];
              const path = String((file as Record<string, unknown>).path || "");
              return path ? [{ path, action: String((file as Record<string, unknown>).action || "") || undefined }] : [];
          })
        : [];
    const error = objectField(detail.error, "message");
    const output = typeof detail.output === "string" ? detail.output.trim() : typeof error === "string" ? error : "";
    if (!rows.length && !files.length && !output) return null;
    return { kind: typeof detail.kind === "string" ? detail.kind : undefined, status: typeof detail.status === "string" ? detail.status : undefined, rows, files, output };
}

function normalizeText(value: unknown) {
    if (typeof value === "string") return value.trim();
    if (value instanceof Error) return value.message;
    if (value == null) return "";
    return String(objectField(value, "message") || "");
}

function objectField(value: unknown, key: string) {
    return value && typeof value === "object" ? (value as Record<string, unknown>)[key] : undefined;
}
