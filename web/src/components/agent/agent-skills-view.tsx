import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Form, Input, Modal, Select, Switch, Tooltip } from "antd";
import { Check, CircleAlert, FilePenLine, LoaderCircle, LockKeyhole, Plus, RefreshCw, Search, Sparkles, Trash2 } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { createCodexSkill, deleteCodexSkill, fetchCodexSkill, setCodexSkillEnabled, updateCodexSkill, type AgentSkillDetail, type AgentSkillInterface, type AgentSkillScope, type AgentSkillSummary } from "@/services/api/canvas-agent";
import { useAgentSkillStore } from "@/stores/use-agent-skill-store";
import { useAgentStore } from "@/stores/use-agent-store";
import { useThemeStore } from "@/stores/use-theme-store";

type ScopeFilter = "all" | AgentSkillScope;
type SkillEditor = { mode: "create" } | { mode: "edit"; detail: AgentSkillDetail };
type SkillFormValues = { name: string; description: string; instructions: string; displayName?: string; shortDescription?: string; defaultPrompt?: string };

const scopeLabels: Record<AgentSkillScope, string> = { repo: "项目", user: "个人", system: "系统", admin: "管理员" };
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function AgentSkillsView() {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { message, modal } = App.useApp();
    const connected = useAgentStore((state) => state.connected);
    const url = useAgentStore((state) => state.url);
    const token = useAgentStore((state) => state.token);
    const setAgentState = useAgentStore((state) => state.setAgentState);
    const skills = useAgentSkillStore((state) => state.skills);
    const selectedSkill = useAgentSkillStore((state) => state.selectedSkill);
    const loading = useAgentSkillStore((state) => state.loading);
    const loaded = useAgentSkillStore((state) => state.loaded);
    const errors = useAgentSkillStore((state) => state.errors);
    const loadSkills = useAgentSkillStore((state) => state.loadSkills);
    const selectSkill = useAgentSkillStore((state) => state.selectSkill);
    const clearSelection = useAgentSkillStore((state) => state.clearSelection);
    const [query, setQuery] = useState("");
    const [scope, setScope] = useState<ScopeFilter>("all");
    const [editor, setEditor] = useState<SkillEditor | null>(null);
    const [saving, setSaving] = useState(false);
    const [busySkill, setBusySkill] = useState("");
    const [errorsOpen, setErrorsOpen] = useState(false);
    const confirmRef = useRef<{ destroy: () => void } | null>(null);
    const [form] = Form.useForm<SkillFormValues>();
    const endpoint = url.trim().replace(/\/$/, "");
    const filteredSkills = useMemo(() => {
        const keyword = query.trim().toLowerCase();
        return skills.filter((skill) => {
            if (scope !== "all" && skill.scope !== scope) return false;
            return !keyword || [skill.name, skill.description, skill.interface?.displayName, skill.interface?.shortDescription, skill.shortDescription].some((value) => value?.toLowerCase().includes(keyword));
        });
    }, [query, scope, skills]);

    const editorValues = editor?.mode === "edit" ? skillFormValues(editor.detail) : undefined;

    const refresh = (forceReload = true) => loadSkills(endpoint, token, forceReload);
    const connectionIsCurrent = (revision: number) => {
        const agent = useAgentStore.getState();
        const skillsState = useAgentSkillStore.getState();
        return skillsState.connectionRevision === revision && agent.connected && agent.url.trim().replace(/\/$/, "") === endpoint && agent.token === token;
    };
    useEffect(() => {
        if (connected) return;
        confirmRef.current?.destroy();
        confirmRef.current = null;
        setEditor(null);
        setSaving(false);
        setBusySkill("");
        setErrorsOpen(false);
        form.resetFields();
    }, [connected, form]);
    const useSkill = (skill: AgentSkillSummary) => {
        selectSkill(skill);
        setAgentState({ activeTab: "chat" });
    };
    const openEdit = async (skill: AgentSkillSummary) => {
        if (!skill.managed || busySkill) return;
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        setBusySkill(skill.path);
        try {
            const response = await fetchCodexSkill(endpoint, token, skill.name);
            if (!connectionIsCurrent(connectionRevision)) return;
            if (!response.data) throw new Error("未读取到 Skill 内容");
            setEditor({ mode: "edit", detail: response.data });
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : "读取 Skill 失败");
        } finally {
            if (connectionIsCurrent(connectionRevision)) setBusySkill("");
        }
    };
    const saveSkill = async () => {
        if (!editor) return;
        let values: SkillFormValues;
        try {
            values = await form.validateFields();
        } catch {
            return;
        }
        const name = editor.mode === "edit" ? editor.detail.name : values.name.trim();
        const skillInterface = compactInterface(values);
        if (skillInterface?.defaultPrompt && !mentionsSkill(skillInterface.defaultPrompt, name)) {
            form.setFields([{ name: "defaultPrompt", errors: [`默认提示词需要包含 $${name}`] }]);
            return;
        }
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        if (!connectionIsCurrent(connectionRevision)) return;
        setSaving(true);
        try {
            const input = { description: values.description.trim(), instructions: values.instructions.trim(), interface: skillInterface || null };
            if (editor.mode === "create") await createCodexSkill(endpoint, token, { name, ...input });
            else await updateCodexSkill(endpoint, token, name, { ...input, expectedRevision: editor.detail.revision });
            if (!connectionIsCurrent(connectionRevision)) return;
            setEditor(null);
            await refresh();
            if (!connectionIsCurrent(connectionRevision)) return;
            message.success(editor.mode === "create" ? "Skill 已创建" : "Skill 已更新");
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : "保存 Skill 失败");
        } finally {
            if (connectionIsCurrent(connectionRevision)) setSaving(false);
        }
    };
    const confirmDelete = (skill: AgentSkillSummary) => {
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        confirmRef.current = modal.confirm({
            title: `删除 ${skill.interface?.displayName || skill.name}`,
            content: "删除后本地文件无法恢复，确定继续吗？",
            okText: "删除",
            okType: "danger",
            cancelText: "取消",
            onOk: async () => {
                if (!connectionIsCurrent(connectionRevision)) return;
                setBusySkill(skill.path);
                try {
                    const response = await fetchCodexSkill(endpoint, token, skill.name);
                    if (!connectionIsCurrent(connectionRevision)) return;
                    if (!response.data) throw new Error("未读取到 Skill 内容");
                    await deleteCodexSkill(endpoint, token, skill.name, response.data.revision);
                    if (!connectionIsCurrent(connectionRevision)) return;
                    if (selectedSkill?.name === skill.name && selectedSkill.path === skill.path) clearSelection();
                    await refresh();
                    if (!connectionIsCurrent(connectionRevision)) return;
                    message.success("Skill 已删除");
                } catch (error) {
                    if (!connectionIsCurrent(connectionRevision)) return;
                    message.error(error instanceof Error ? error.message : "删除 Skill 失败");
                    throw error;
                } finally {
                    if (connectionIsCurrent(connectionRevision)) setBusySkill("");
                }
            },
            afterClose: () => {
                confirmRef.current = null;
            },
        });
    };
    const toggleEnabled = async (skill: AgentSkillSummary, enabled: boolean) => {
        const connectionRevision = useAgentSkillStore.getState().connectionRevision;
        if (!connectionIsCurrent(connectionRevision)) return;
        setBusySkill(skill.path);
        try {
            await setCodexSkillEnabled(endpoint, token, skill, enabled);
            if (!connectionIsCurrent(connectionRevision)) return;
            if (!enabled && selectedSkill?.name === skill.name && selectedSkill.path === skill.path) clearSelection();
            await refresh();
        } catch (error) {
            if (connectionIsCurrent(connectionRevision)) message.error(error instanceof Error ? error.message : "更新 Skill 状态失败");
        } finally {
            if (connectionIsCurrent(connectionRevision)) setBusySkill("");
        }
    };

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="shrink-0 border-b px-4 py-3" style={{ borderColor: theme.node.stroke }}>
                <div className="flex items-center justify-between gap-3">
                    <div>
                        <div className="text-sm font-semibold">本地 Skill</div>
                        <div className="mt-0.5 text-xs" style={{ color: theme.node.muted }}>安装在本机，由 Codex 直接执行</div>
                    </div>
                    <div className="flex items-center gap-1">
                        <Tooltip title="重新读取">
                            <Button type="text" shape="circle" className="!h-8 !w-8 !min-w-8" aria-label="重新读取 Skill" disabled={!connected || loading} icon={<RefreshCw className={`size-4 ${loading ? "animate-spin" : ""}`} />} onClick={() => void refresh()} />
                        </Tooltip>
                        <Button type="text" className="!h-8 !px-2" disabled={!connected} icon={<Plus className="size-4" />} onClick={() => setEditor({ mode: "create" })}>新建</Button>
                    </div>
                </div>
                <div className="mt-3 flex gap-2">
                    <Input className="min-w-0 flex-1" allowClear disabled={!connected} value={query} onChange={(event) => setQuery(event.target.value)} prefix={<Search className="size-3.5" />} placeholder="搜索 Skill" />
                    <Select<ScopeFilter>
                        size="small"
                        variant="borderless"
                        className="w-28 shrink-0"
                        disabled={!connected}
                        value={scope}
                        onChange={setScope}
                        options={[{ value: "all", label: "全部范围" }, ...Object.entries(scopeLabels).map(([value, label]) => ({ value: value as AgentSkillScope, label }))]}
                    />
                </div>
                {errors.length ? (
                    <Button danger type="text" size="small" className="!mt-1 !h-7 !px-1 text-xs" icon={<CircleAlert className="size-3.5" />} onClick={() => setErrorsOpen(true)}>{errors.length} 个 Skill 未能加载</Button>
                ) : null}
            </div>
            <div className="thin-scrollbar min-h-0 flex-1 overflow-y-auto px-4">
                {loading && !loaded ? (
                    <div className="flex h-40 items-center justify-center gap-2 text-sm" style={{ color: theme.node.muted }}><LoaderCircle className="size-4 animate-spin" />正在读取 Skill</div>
                ) : filteredSkills.length ? (
                    <div className="divide-y" style={{ borderColor: theme.node.stroke }}>
                        {filteredSkills.map((skill) => {
                            const selected = selectedSkill?.name === skill.name && selectedSkill.path === skill.path;
                            const busy = busySkill === skill.path;
                            return (
                                <div key={`${skill.name}:${skill.path}`} className={`py-3 transition-opacity ${skill.enabled ? "" : "opacity-55"}`} style={{ borderColor: theme.node.stroke }}>
                                    <div className="flex items-start gap-3">
                                        <Sparkles className="mt-0.5 size-4 shrink-0" style={{ color: selected ? theme.node.text : theme.node.muted }} />
                                        <div className="min-w-0 flex-1">
                                            <div className="flex min-w-0 items-center gap-2">
                                                <span className="truncate text-sm font-medium">{skill.interface?.displayName || skill.name}</span>
                                                {!skill.managed ? <Tooltip title="外部 Skill 只能使用或启停"><LockKeyhole className="size-3.5 shrink-0" style={{ color: theme.node.faint }} /></Tooltip> : null}
                                            </div>
                                            <div className="mt-1 line-clamp-2 text-xs leading-5" style={{ color: theme.node.muted }}>{skill.interface?.shortDescription || skill.shortDescription || skill.description || "暂无说明"}</div>
                                            <Tooltip title={skill.path}>
                                                <div className="mt-1.5 truncate text-[11px]" style={{ color: theme.node.faint }}>{scopeLabels[skill.scope] || skill.scope} · {skill.name}</div>
                                            </Tooltip>
                                        </div>
                                    </div>
                                    <div className="mt-2 flex items-center justify-between gap-2 pl-7">
                                        <label className="inline-flex items-center gap-2 text-xs" style={{ color: theme.node.muted }}>
                                            <Switch size="small" checked={skill.enabled} loading={busy} disabled={!connected || Boolean(busySkill)} onChange={(enabled) => void toggleEnabled(skill, enabled)} />
                                            {skill.enabled ? "已启用" : "已停用"}
                                        </label>
                                        <div className="flex items-center gap-0.5">
                                            <Button type="text" size="small" disabled={!connected || !skill.enabled || Boolean(busySkill)} icon={selected ? <Check className="size-3.5" /> : <Sparkles className="size-3.5" />} onClick={() => useSkill(skill)}>{selected ? "已选择" : "使用"}</Button>
                                            {skill.managed ? (
                                                <>
                                                    <Tooltip title="编辑"><Button type="text" shape="circle" size="small" aria-label={`编辑 ${skill.interface?.displayName || skill.name}`} disabled={!connected || Boolean(busySkill)} icon={<FilePenLine className="size-3.5" />} onClick={() => void openEdit(skill)} /></Tooltip>
                                                    <Tooltip title="删除"><Button danger type="text" shape="circle" size="small" aria-label={`删除 ${skill.interface?.displayName || skill.name}`} disabled={!connected || Boolean(busySkill)} icon={<Trash2 className="size-3.5" />} onClick={() => confirmDelete(skill)} /></Tooltip>
                                                </>
                                            ) : null}
                                        </div>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                ) : (
                    <div className="flex h-48 flex-col items-center justify-center text-center">
                        <Sparkles className="size-5" style={{ color: theme.node.faint }} />
                        <div className="mt-3 text-sm font-medium">{!connected ? "连接 Agent 后查看 Skill" : skills.length ? "没有匹配的 Skill" : "还没有本地 Skill"}</div>
                        <div className="mt-1 text-xs" style={{ color: theme.node.muted }}>{!connected ? "连接成功后会读取本机已安装的 Skill" : skills.length ? "换个关键词或范围试试" : "新建一个，或在本机安装后刷新"}</div>
                    </div>
                )}
            </div>

            <Modal title={`${errors.length} 个 Skill 未能加载`} open={errorsOpen} footer={null} width={720} onCancel={() => setErrorsOpen(false)}>
                <div className="thin-scrollbar mt-4 max-h-[60vh] overflow-y-auto rounded-md border px-3 py-2 text-xs leading-5" style={{ borderColor: theme.node.stroke }}>
                    {errors.map((error, index) => <div key={`${index}:${error}`} className="break-all py-1" style={{ color: theme.node.muted }}>{error}</div>)}
                </div>
            </Modal>

            <Modal title={editor?.mode === "edit" ? `编辑 ${editor.detail.interface?.displayName || editor.detail.name}` : "新建 Skill"} open={Boolean(editor)} okText="保存" cancelText="取消" confirmLoading={saving} width={620} destroyOnHidden onCancel={() => !saving && setEditor(null)} onOk={() => void saveSkill()}>
                <Form key={editor?.mode === "edit" ? editor.detail.revision : "create"} form={form} initialValues={editorValues} layout="vertical" className="mt-4" requiredMark={false} preserve={false}>
                    <Form.Item name="name" label="名称" rules={[{ required: true, message: "请输入名称" }, { max: 64, message: "名称不能超过 64 个字符" }, { pattern: skillNamePattern, message: "仅支持小写字母、数字和连字符，连字符不能连续或位于首尾" }]}>
                        <Input maxLength={64} disabled={editor?.mode === "edit"} placeholder="例如 product-grid" />
                    </Form.Item>
                    <Form.Item name="displayName" label="显示名称" rules={[{ max: 64, message: "显示名称不能超过 64 个字符" }]}><Input maxLength={64} placeholder="例如 产品九宫格生成" /></Form.Item>
                    <Form.Item name="description" label="触发说明" extra="写清楚这个 Skill 做什么，以及应在什么情况下使用。" rules={[{ required: true, message: "请输入 Skill 触发说明" }, { max: 1024, message: "触发说明不能超过 1024 个字符" }, { validator: (_, value) => typeof value === "string" && /[<>]/.test(value) ? Promise.reject(new Error("触发说明不能包含尖括号")) : Promise.resolve() }]}><Input.TextArea maxLength={1024} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="说明能力和适用场景" /></Form.Item>
                    <Form.Item name="instructions" label="执行指引" rules={[{ required: true, message: "请输入执行指引" }]}><Input.TextArea className="font-mono text-xs" autoSize={{ minRows: 10, maxRows: 16 }} placeholder="写清楚触发条件、步骤和输出要求" /></Form.Item>
                    <Form.Item name="shortDescription" label="卡片短说明" extra="填写时控制在 25–64 个字符，便于快速浏览。" rules={[{ min: 25, message: "卡片短说明不能少于 25 个字符" }, { max: 64, message: "卡片短说明不能超过 64 个字符" }]}><Input maxLength={64} showCount placeholder="可选，用于列表展示" /></Form.Item>
                    <Form.Item name="defaultPrompt" label="默认提示词" extra="可选；填写时必须准确包含 $skill-name，例如 $product-grid" rules={[{ max: 1024, message: "默认提示词不能超过 1024 个字符" }]}><Input.TextArea maxLength={1024} autoSize={{ minRows: 2, maxRows: 4 }} placeholder="选择 Skill 时可预填到输入框" /></Form.Item>
                </Form>
            </Modal>
        </div>
    );
}

function skillFormValues(detail: AgentSkillDetail): SkillFormValues {
    return {
        name: detail.name,
        description: detail.description,
        instructions: detail.instructions,
        displayName: detail.interface?.displayName || undefined,
        shortDescription: detail.interface?.shortDescription || undefined,
        defaultPrompt: detail.interface?.defaultPrompt || undefined,
    };
}

function compactInterface(values: SkillFormValues): AgentSkillInterface | undefined {
    const skillInterface = {
        displayName: values.displayName?.trim() || undefined,
        shortDescription: values.shortDescription?.trim() || undefined,
        defaultPrompt: values.defaultPrompt?.trim() || undefined,
    };
    return Object.values(skillInterface).some(Boolean) ? skillInterface : undefined;
}

function mentionsSkill(prompt: string, name: string) {
    return new RegExp(`\\$${name}(?![A-Za-z0-9_-]|:[A-Za-z0-9_-])`).test(prompt);
}
