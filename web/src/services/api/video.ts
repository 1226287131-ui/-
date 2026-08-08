import axios from "axios";
import { nanoid } from "nanoid";

import { dataUrlToFile } from "@/lib/image-utils";
import { getVideoModelProfile, normalizeVideoQualityForReferences, normalizeVideoQualityForModel, normalizeVideoRatioForModel, normalizeVideoSecondsForModel, normalizeVideoSizeForModel } from "@/lib/video-model";
import { compileVideoV1Prompt, normalizeVideoV2Prompt } from "@/lib/video-reference-prompt";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { resolveReferenceMediaUrls } from "@/services/api/video-media";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";

type VideoResponse = {
    id?: string;
    task_id?: string;
    status?: string;
    error?: { message?: string } | string;
    message?: string;
    url?: string;
    result_url?: string;
    video_url?: string;
    metadata?: { url?: string; [key: string]: unknown };
    content?: { video_url?: string; url?: string; [key: string]: unknown } | null;
    [key: string]: unknown;
};
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: unknown; msg?: string; message?: string; error?: { message?: string } | string; [key: string]: unknown };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = { signal?: AbortSignal };

const VIDEO_QUERY_TIMEOUT_MS = 45_000;
const VIDEO_DOWNLOAD_TIMEOUT_MS = 120_000;

class NonVideoResponseError extends Error {
    readonly name = "NonVideoResponseError";
}

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string; remoteOnly?: boolean };
export type VideoGenerationTask = { id: string; provider: "openai" | "seedance" | "video-v1" | "video-v2" | "video-v2-full" | "grok" | "minimax-h3" | "plugin"; model: string };
export type VideoGenerationTaskState = { status: "pending" } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" || task.provider === "video-v1" || task.provider === "video-v2" || task.provider === "video-v2-full" || task.provider === "grok" || task.provider === "minimax-h3" ? 5000 : 2500;
    for (;;) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        await delay(delayMs, options?.signal);
    }
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    const requestConfig = resolveModelRequestConfig(config, selectedModel);
    const script = resolveModelScript(config, selectedModel);
    if (script) return createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
    assertVideoConfig(requestConfig, requestConfig.model);
    const profile = getVideoModelProfile(modelOptionName(selectedModel));
    if (profile.kind === "video-v1") return createVideoV1Task(requestConfig, selectedModel, prompt, references, options);
    if (profile.kind === "video-v2-full") return createVideoV2FullTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "video-v2") return createVideoV2Task(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "grok") return createGrokTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (profile.kind === "minimax-h3") return createMiniMaxH3Task(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    if (isSeedanceVideoConfig(requestConfig)) {
        return createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
    }
    if (videoReferences.length || audioReferences.length) {
        throw new Error("当前视频接口不支持参考视频或参考音频，请切换到 Seedance 2.0 / 火山 Agent Plan 模型，或移除参考资产");
    }
    return createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: "插件视频任务已失效，请重新生成" };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "seedance") return pollSeedanceTask(requestConfig, task, options);
    if (task.provider === "video-v1") return pollVideoV1Task(requestConfig, task, options);
    if (task.provider === "video-v2") return pollVideoV2Task(requestConfig, task, options);
    if (task.provider === "video-v2-full") return pollVideoV2FullTask(requestConfig, task, options);
    if (task.provider === "grok") return pollGrokTask(requestConfig, task, options);
    if (task.provider === "minimax-h3") return pollMiniMaxH3Task(requestConfig, task, options);
    return pollOpenAIVideoTask(requestConfig, task, options);
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    const profile = getVideoModelProfile(modelOptionName(model));
    const requestConfig = {
        ...config,
        vquality: normalizeVideoQualityForReferences(model, config.vquality, references.length),
        ...(profile.kind === "minimax-h3"
            ? {
                  videoSeconds: normalizeVideoSecondsForModel(model, config.videoSeconds),
                  size: normalizeVideoSizeForModel(model, config.size),
              }
            : {}),
    };
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config: requestConfig,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(requestConfig.videoSeconds),
                size: normalizeVideoSize(requestConfig.size),
                resolution: normalizeVideoResolution(requestConfig.vquality),
                ratio: requestConfig.size,
                generateAudio: boolConfig(requestConfig.videoGenerateAudio, true),
                watermark: boolConfig(requestConfig.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error("模型调用脚本没有返回视频");
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        if (result.remoteOnly) return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error("视频接口没有返回可播放的视频");
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error("视频接口没有返回任务 ID");
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "视频任务创建失败"));
    }
}

async function createVideoV1Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const media = await resolveReferenceMediaUrls(references, [], []);
    const payload: Record<string, unknown> = {
        model: modelOptionName(model),
        prompt: compileVideoV1Prompt(prompt, references.length),
        duration: Number(normalizeVideoSecondsForModel(model, config.videoSeconds)),
        aspect_ratio: normalizeVideoRatioForModel(model, config.size),
    };
    if (media.images.length) payload.images = media.images;
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/video/generations"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error("video-v1 接口没有返回任务 ID");
        return { id, provider: "video-v1", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "video-v1 任务创建失败"));
    }
}

async function createVideoV2Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const media = await resolveReferenceMediaUrls(references, videoReferences, audioReferences);
    const payload = {
        model: modelOptionName(model),
        prompt: normalizeVideoV2Prompt(prompt, { images: media.images.length, videos: media.videos.length, audios: media.audios.length }),
        images: media.images,
        videos: media.videos,
        audios: media.audios,
        aspect_ratio: normalizeVideoRatioForModel(model, config.size),
        duration: Number(normalizeVideoSecondsForModel(model, config.videoSeconds)),
        resolution: normalizeVideoQualityForModel(model, config.vquality),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error("video-v2 接口没有返回任务 ID");
        return { id, provider: "video-v2", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "video-v2 任务创建失败"));
    }
}

async function createVideoV2FullTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const profile = getVideoModelProfile(modelName);
    if (!prompt.trim()) throw new Error("video-v2-满血兜底版需要填写提示词");
    if (Array.from(prompt).length > 4000) throw new Error("video-v2-满血兜底版提示词不能超过 4000 个字符");
    const media = await resolveReferenceMediaUrls(references.slice(0, profile.maxImages), videoReferences.slice(0, profile.maxVideos), audioReferences.slice(0, profile.maxAudios));
    const payload = {
        model: modelName,
        prompt: normalizeVideoV2Prompt(prompt, { images: media.images.length, videos: media.videos.length, audios: media.audios.length }),
        images: media.images,
        videos: media.videos,
        audios: media.audios,
        aspect_ratio: normalizeVideoRatioForModel(modelName, config.size),
        duration: Number(normalizeVideoSecondsForModel(modelName, config.videoSeconds)),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error("video-v2-满血兜底版接口没有返回任务 ID");
        return { id, provider: "video-v2-full", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "video-v2-满血兜底版任务创建失败"));
    }
}

async function createMiniMaxH3Task(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const modelName = modelOptionName(model);
    const profile = getVideoModelProfile(modelName);
    if (!prompt.trim()) throw new Error("MiniMax-H3-933-1440P-GF 需要填写视频提示词");
    if (references.length > profile.maxImages) throw new Error(`MiniMax-H3-933-1440P-GF 最多支持 ${profile.maxImages} 张参考图`);
    if (videoReferences.length) throw new Error("MiniMax-H3-933-1440P-GF 不支持参考视频");
    if (audioReferences.length) throw new Error("MiniMax-H3-933-1440P-GF 不支持参考音频");
    const media = await resolveReferenceMediaUrls(references, [], []);
    const payload = {
        model: modelName,
        prompt,
        seconds: Number(normalizeVideoSecondsForModel(modelName, config.videoSeconds)),
        size: normalizeVideoSizeForModel(modelName, config.size),
        audio: boolConfig(config.videoGenerateAudio, true),
        images: media.images.slice(0, profile.maxImages),
    };
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error("MiniMax-H3-933-1440P-GF 接口没有返回任务 ID");
        return { id, provider: "minimax-h3", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "MiniMax-H3-933-1440P-GF 任务创建失败"));
    }
}

async function createGrokTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!prompt.trim()) throw new Error("Grok 需要填写视频提示词");
    if (videoReferences.length) throw new Error("Grok 不支持参考视频");
    if (audioReferences.length) throw new Error("Grok 不支持参考音频");
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSecondsForModel(model, config.videoSeconds));
    body.append("aspect_ratio", normalizeVideoRatioForModel(model, config.size));
    body.append("resolution", normalizeVideoQualityForReferences(model, config.vquality, references.length));
    for (const reference of references) {
        const file = dataUrlToFile({ ...reference, dataUrl: await imageToDataUrl(reference) });
        if (!file.size) throw new Error("Grok 参考图不能为空");
        if (!file.type.toLowerCase().startsWith("image/")) throw new Error("Grok 仅支持图片格式的参考图");
        body.append("input_reference", file);
    }
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        const id = taskIdOf(created);
        if (!id) throw new Error("Grok 接口没有返回任务 ID");
        return { id, provider: "grok", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "Grok 任务创建失败"));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const video = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        const url = videoResultUrl(payload, config.baseUrl);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(video.error) || "视频生成失败" };
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options) };
        if (isSuccessStatus(status)) {
            return { status: "completed", result: await downloadVideoContent(config, `/videos/${encodeURIComponent(task.id)}/content`, options) };
        }
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "视频任务查询失败"));
    }
}

async function pollVideoV1Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/video/generations/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        const url = videoResultUrl(payload, config.baseUrl);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "video-v1 视频生成失败" };
        // 部分中转站会在状态仍为 IN_PROGRESS 时先写入成片 URL，URL 优先视为完成。
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options) };
        // 成功状态和视频 URL 可能分开写入；在成片真正可用前继续查询。
        if (isSuccessStatus(status)) return { status: "pending" };
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "video-v1 任务查询失败"));
    }
}

async function pollVideoV2Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return pollOpenCompatibleTask(config, task, options, "video-v2");
}

async function pollVideoV2FullTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return pollOpenCompatibleTask(config, task, options, "video-v2-满血兜底版");
}

async function pollGrokTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || "Grok 视频生成失败" };
        if (!isSuccessStatus(status)) return { status: "pending" };
        const url = videoResultUrl(payload, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options) };
        return { status: "completed", result: await downloadVideoContent(config, `/videos/${encodeURIComponent(task.id)}/content`, options) };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "Grok 任务查询失败"));
    }
}

async function pollMiniMaxH3Task(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    return pollOpenCompatibleTask(config, task, options, "MiniMax-H3-933-1440P-GF");
}

async function pollOpenCompatibleTask(config: AiConfig, task: VideoGenerationTask, options: RequestOptions | undefined, label: string): Promise<VideoGenerationTaskState> {
    try {
        const payload = (await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${encodeURIComponent(task.id)}`), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data;
        const state = unwrapVideoResponse(payload);
        const status = videoStatus(payload);
        const url = videoResultUrl(payload, config.baseUrl);
        if (isFailureStatus(status)) return { status: "failed", error: readApiErrorMessage(state.error) || readApiErrorMessage(state.message) || `${label} 视频生成失败` };
        // Some gateways publish the result URL just before updating status; use it
        // when present so a finished task is not hidden behind a slow content route.
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options) };
        if (isSuccessStatus(status)) return { status: "completed", result: await downloadVideoContent(config, `/videos/${encodeURIComponent(task.id)}/content`, options) };
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, `${label} 任务查询失败`));
    }
}

async function downloadVideoContent(config: AiConfig, path: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(aiApiUrl(config, path), { headers: aiHeaders(config), responseType: "blob", timeout: VIDEO_DOWNLOAD_TIMEOUT_MS, signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data, mimeType: response.data.type || "video/mp4" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw error;
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error("Seedance 参考音频不能单独使用，请同时添加参考图或参考视频");
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error("请输入视频提示词，或连接参考图片/视频/音频");
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality, modelOptionName(model)),
        duration: normalizeSeedanceDuration(config.videoSeconds),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error("Seedance 接口没有返回任务 ID");
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        throw new Error(readAxiosError(error, "Seedance 任务创建失败"));
    }
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), timeout: VIDEO_QUERY_TIMEOUT_MS, signal: options?.signal })).data);
        const url = videoResultUrl(state, config.baseUrl);
        if (url) return { status: "completed", result: await videoResultFromUrl(config, url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "pending" };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired") return { status: "failed", error: readApiErrorMessage(state.error?.message) || `Seedance 视频生成${state.status === "expired" ? "超时" : "失败"}` };
        return { status: "pending" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        if (isRetryableVideoPollError(error)) return { status: "pending" };
        throw new Error(readAxiosError(error, "Seedance 任务查询失败"));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error("Seedance 参考视频单个时长需要在 2-15 秒之间");
        total += video.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考视频总时长不能超过 15 秒");
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error("Seedance 参考音频单个时长需要在 2-15 秒之间");
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error("Seedance 参考音频总时长不能超过 15 秒");
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error("参考图读取失败，请换一张图片或重新上传");
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error("参考视频必须是公网 URL、资产 ID，或本地已保存的视频");
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error("参考音频必须是公网 URL、资产 ID，或本地已保存的音频");
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(config: AiConfig, url: string, options?: RequestOptions): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { headers: videoResultHeaders(config, url), responseType: "blob", timeout: VIDEO_DOWNLOAD_TIMEOUT_MS, signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data, mimeType: response.data.type || "video/mp4" };
    } catch (error) {
        throwIfRequestAborted(error, options?.signal);
        // A JSON/HTML response is an API error, not a playable fallback URL.
        if (error instanceof NonVideoResponseError) throw error;
        return { url, mimeType: "video/mp4", remoteOnly: true };
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error("请先配置视频模型");
    if (!config.baseUrl.trim()) throw new Error("请先配置 Base URL");
    if (!config.apiKey.trim()) throw new Error("请先配置 API Key");
    if (config.apiFormat === "gemini") throw new Error("Gemini 调用格式暂不支持视频生成，请使用 OpenAI 格式渠道");
}

function normalizeVideoSeconds(value: string) {
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function unwrapVideoResponse(payload: ApiVideoResponse): VideoResponse {
    return unwrapEnvelope<VideoResponse>(payload, "接口没有返回视频任务");
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>): SeedanceTask {
    return unwrapEnvelope<SeedanceTask>(payload, "Seedance 接口没有返回任务");
}

function unwrapEnvelope<T>(payload: unknown, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    let current: unknown = payload;
    for (let depth = 0; depth < 6; depth += 1) {
        if (!current || typeof current !== "object") break;
        const record = current as Record<string, unknown>;
        if ("code" in record && record.code !== undefined) {
            if (!isSuccessfulEnvelopeCode(record.code)) throw new Error(readApiErrorMessage(record) || "请求失败");
            if ("data" in record && record.data) {
                current = record.data;
                continue;
            }
            if (hasVideoTaskFields(record)) break;
            throw new Error(emptyMessage);
        }
        // Some gateways wrap the task in data without returning a code field.
        if ("data" in record && record.data && !hasVideoTaskFields(record)) {
            current = record.data;
            continue;
        }
        break;
    }
    if (!current || typeof current !== "object") throw new Error(emptyMessage);
    return current as T;
}

function isSuccessfulEnvelopeCode(code: unknown) {
    if (code === 0 || code === "0") return true;
    if (typeof code === "number") return code >= 200 && code < 300;
    if (typeof code === "string" && /^2\d\d$/.test(code.trim())) return true;
    return typeof code === "string" && ["ok", "success", "succeeded"].includes(code.trim().toLowerCase());
}

function videoResultUrl(payload: unknown, baseUrl = "") {
    const preferredKeys = ["result_url", "video_url", "download_url", "file_url"];
    const visit = (value: unknown, depth: number, includeGenericUrl: boolean): string | undefined => {
        if (!value || typeof value !== "object" || depth > 8) return undefined;
        const record = value as Record<string, unknown>;
        for (const key of preferredKeys) {
            const candidate = resolveVideoUrl(record[key], baseUrl);
            if (candidate) return candidate;
        }
        if (includeGenericUrl) {
            const candidate = resolveVideoUrl(record.url, baseUrl);
            if (candidate) return candidate;
        }
        for (const key of ["metadata", "task", "state", "content", "result", "data", "output", "response", "video", "file", "media"]) {
            const nested = record[key];
            if (Array.isArray(nested)) {
                for (const item of nested) {
                    const candidate = visit(item, depth + 1, includeGenericUrl);
                    if (candidate) return candidate;
                }
            } else {
                const candidate = visit(nested, depth + 1, includeGenericUrl);
                if (candidate) return candidate;
            }
        }
        return undefined;
    };
    return visit(payload, 0, false) || visit(payload, 0, true);
}

function videoStatus(payload: unknown) {
    const statuses: string[] = [];
    const visit = (value: unknown, depth: number) => {
        if (!value || typeof value !== "object" || depth > 8) return;
        const record = value as Record<string, unknown>;
        for (const key of ["status", "state", "task_status"]) {
            if (typeof record[key] === "string") statuses.push(String(record[key]).toLowerCase().trim());
        }
        for (const key of ["metadata", "task", "state", "data", "result", "output", "response", "content", "video", "file", "media"]) {
            const nested = record[key];
            if (Array.isArray(nested)) nested.forEach((item) => visit(item, depth + 1));
            else visit(nested, depth + 1);
        }
    };
    visit(payload, 0);
    return statuses.find(isFailureStatus) || statuses.find(isSuccessStatus) || statuses[0] || "";
}

function isSuccessStatus(status: string) {
    return ["success", "succeeded", "completed", "complete", "done", "finished", "ready"].includes(status.replace(/[\s-]/g, "_"));
}

function isFailureStatus(status: string) {
    return ["failed", "failure", "cancelled", "canceled", "expired", "error"].includes(status.replace(/[\s-]/g, "_"));
}

function hasVideoTaskFields(value: Record<string, unknown>) {
    return ["id", "task_id", "status", "result_url", "video_url", "download_url", "file_url", "url", "content", "error"].some((key) => key in value);
}

function resolveVideoUrl(value: unknown, baseUrl: string) {
    if (typeof value !== "string" || !value.trim()) return undefined;
    const raw = value.trim();
    if (!isPublicMediaUrl(raw) && !/^(?:\/?[^\s]+\.mp4(?:\?|#|$)|\/(?:api|v1|videos?)\b|\.\.?(?:\/|$))/i.test(raw)) return undefined;
    if (isPublicMediaUrl(raw)) return raw;
    try {
        const fallbackOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const base = new URL(baseUrl, fallbackOrigin);
        // A bare relative path is generally relative to the gateway origin, while
        // a leading slash explicitly keeps the gateway root path.
        return new URL(raw, raw.startsWith("/") ? base : `${base.origin}/`).toString();
    } catch {
        return raw;
    }
}

function videoResultHeaders(config: AiConfig, url: string) {
    if (!sameOriginAsBaseUrl(url, config.baseUrl)) return undefined;
    return aiHeaders(config);
}

function sameOriginAsBaseUrl(url: string, baseUrl: string) {
    try {
        const fallbackOrigin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
        const base = new URL(baseUrl, fallbackOrigin);
        const target = new URL(url, base);
        return target.origin === base.origin;
    } catch {
        return false;
    }
}

function taskIdOf(payload: VideoResponse) {
    return payload.task_id || payload.id || "";
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        try {
            return readApiErrorMessage(JSON.parse(value)) || value;
        } catch {
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: { message?: unknown } };
    return readApiErrorMessage(payload.msg) || readApiErrorMessage(payload.message) || readApiErrorMessage(payload.error?.message);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return "请求已取消";
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return readApiErrorMessage(responseData) || statusMessage(error.response?.status, fallback);
    }
    if (error instanceof DOMException && error.name === "AbortError") return "请求已取消";
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return "鉴权失败，请检查 API Key、套餐权限或模型权限";
    if (status === 429) return "请求被限流或额度不足，请稍后重试";
    return status ? `${fallback}（${status}）` : fallback;
}

function isRetryableVideoPollError(error: unknown) {
    if (error instanceof NonVideoResponseError) return true;
    if (!axios.isAxiosError(error)) return false;
    if (["ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"].includes(error.code || "")) return true;
    const status = error.response?.status;
    return !status || status === 408 || status === 425 || status === 429 || status >= 500;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.size) throw new NonVideoResponseError("视频下载接口返回了空内容");
    const mime = (blob.type || "").toLowerCase();
    const declaredText = mime.includes("json") || mime.includes("html") || mime.startsWith("text/");
    const inspectUnknownMime = !mime || mime === "application/octet-stream";
    const sample = declaredText || inspectUnknownMime ? (await blob.slice(0, 4096).text()).trimStart() : "";
    const looksLikeJson = sample.startsWith("{") || sample.startsWith("[");
    const looksLikeHtml = /^<(?:!doctype\s+html|html\b|head\b|body\b)/i.test(sample);
    if (!declaredText && !looksLikeJson && !looksLikeHtml) return;

    let payload: { code?: number | string; msg?: string; message?: string; error?: { message?: string } } | undefined;
    if (looksLikeJson || mime.includes("json")) {
        try {
            payload = JSON.parse(await blob.text()) as { code?: number | string; msg?: string; message?: string; error?: { message?: string } };
        } catch {
            // Keep the generic non-video error below for malformed JSON responses.
        }
    }
    throw new NonVideoResponseError(readApiErrorMessage(payload) || "视频下载接口返回了非视频内容");
}

function isRequestAborted(error: unknown, signal?: AbortSignal) {
    return axios.isCancel(error) || Boolean(signal?.aborted) || (error instanceof DOMException && error.name === "AbortError");
}

function throwIfRequestAborted(error: unknown, signal?: AbortSignal) {
    if (!isRequestAborted(error, signal)) return;
    if (axios.isCancel(error) || (error instanceof DOMException && error.name === "AbortError")) throw error;
    throw new DOMException("Aborted", "AbortError");
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("读取本地资产失败"));
        reader.readAsDataURL(blob);
    });
}
